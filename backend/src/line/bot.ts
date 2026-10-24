// บทสนทนา LINE ของน้องมะระ (ผู้หญิง: หนู/ค่ะ/คะ) — เลือกบทบาทเกษตรกรหรือผู้ซื้อ
// ฝั่งเกษตรกร:
//   พิมพ์ผลผลิต → สรุป + ปุ่มยืนยัน → เริ่มเจรจา → (เจรจาเสร็จ) ส่งผลครั้งเดียวพร้อมปุ่ม [อนุมัติ] [ไม่เอา] [ต่อรองใหม่]
// ตัวเลขเงินทั้งหมดมาจาก service (โค้ดคำนวณ) — ไฟล์นี้แค่แปลงเป็นข้อความ ไม่คิดเงินเอง
// สมาชิกกลุ่มคนอื่นเป็นตัวจำลอง อนุมัติอัตโนมัติและติดป้าย simulated ใน ledger
// ฝั่งผู้ซื้อ (คนจริง): บอทถามทีละข้อ ผลผลิต → ปริมาณ → สถานที่ส่ง → ราคาที่เสนอ → ยืนยัน แล้วบันทึกคำขอซื้อ

import {
  AppError,
  appendAudit,
  approveSimulatedMembers,
  bangkokDate,
  getDeal,
  getFarmerOffer,
  MAX_LINE_ROUNDS,
  recordApproval,
  renegotiate,
  startDeal,
  type AppContext,
  type LineHooks,
} from '../app/service.js';
import type { LineMessage, LineSecrets } from './client.js';
import { LineClient } from './client.js';
import { randomInt, randomUUID } from 'node:crypto';
import type { Crop } from '../core/types.js';
import { CROP_LABEL_TH, farmers, listings } from '../data/synthetic.js';
import { groupListings } from '../core/grouping.js';
import type { BuyerDraft, LineSession } from '../store/types.js';
import {
  askGroupCode,
  askGroupName,
  autoGroupMessage,
  createdGroupMessages,
  groupChoiceMessage,
  groupNotFound,
  groupSummaryText,
  joinedGroupMessage,
  joinedMockGroupMessage,
  buyerAskLocation,
  buyerAskPrice,
  buyerAskQuantity,
  buyerConfirmMessage,
  buyerCropMessage,
  buyerRequestsMessage,
  buyerAlertMessage,
  negotiationAgreed,
  negotiationConfirmDeal,
  negotiationConfirmEnd,
  negotiationIntro,
  negotiationStatusLine,
  negotiationText,
  type PriceHint,
  buyerMatchesMessages,
  type GroupForBuyer,
  confirmMessage,
  failedMessage,
  helpMessage,
  offerMessage,
  parsePostback,
  problemsMessage,
  roleMessage,
  startedMessage,
  text,
  MOCK_NOTE,
  type OfferExtras,
} from './flex.js';
import { negotiationRounds } from './rounds.js';
import { estimateTransport } from '../core/transportEstimate.js';
import { MAX_HISTORY, smartChat, type ChatAction } from './chat.js';
import { apply, decide, extractOffer, groupTerms, MAX_BUYER_ROUNDS, openingAsk, type BuyerNegDecision, type BuyerNegState } from './buyerNegotiation.js';
import type { ListingDraft } from '../store/types.js';
import { parseBuyerCrop, parseBuyerLocation, parseBuyerPrice, parseBuyerQuantity, parseListing } from './parse.js';
import { verifyLineSignature } from './signature.js';

interface LineEvent {
  type?: string;
  mode?: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
  postback?: { data?: string };
}

const GREETING = /^(เมนู|วิธีใช้|ช่วยเหลือ|help|สวัสดี|สวัสดีครับ|สวัสดีค่ะ|หวัดดี|hi|hello)$/i;
const STATUS = /^(สถานะ|status)$/i;
const CANCEL = /^(ยกเลิก|cancel)$/i;
const MY_REQUESTS = /^(คำขอของฉัน|คำขอซื้อ|รายการของฉัน)$/;
const NEW_REQUEST = /^(ซื้อ|ขอซื้อ|ลงทะเบียน|คำขอใหม่|ลงทะเบียนคำขอ)$/;
const INTEREST = /^(สนใจ|เจรจา|ต่อรอง|ขอเจรจา|ขอต่อรอง)(ครับ|ค่ะ|คะ|จ้า|นะ)?\s*$/;
const END_NEG = /^(จบ|จบการเจรจา|ไม่เอาแล้ว|พอแล้ว)$/;
const YES = /^(ยืนยัน|ตกลง|โอเค|ok|okay|ได้|ใช่|ใช่ค่ะ|ใช่ครับ)(ครับ|ค่ะ|คะ|เลย)?$/i;
/** ข้อความที่ฟังเหมือน "รับ" ราคาของผู้ซื้อ — ห้ามมีในรอบที่โค้ดตัดสินว่ายังไม่รับ */
const SOUNDS_ACCEPTING = /ตกลงที่|รับราคา|ยอมรับราคา|เสนอราคานี้ให้กลุ่ม|ส่งราคานี้ให้กลุ่ม|ให้กลุ่มพิจารณา/;
const MAX_EVENTS = 20;

/** รหัสกลุ่มจำลองสำหรับเดโม → กลุ่มข้าวหอมมะลิ ร้อยเอ็ด (ข้อมูลจำลอง) */
export const MOCK_GROUP_CODES = ['12345', '1234'];
const MOCK_GROUP_CROP: Crop = 'rice_hommali';

function mockGroupInfo() {
  const g = groupListings(listings, farmers).find((x) => x.crop === MOCK_GROUP_CROP)!;
  return { members: g.members.length, province: g.province, cropLabel: CROP_LABEL_TH[g.crop], totalKg: g.members.reduce((n, m) => n + m.quantityKg, 0) };
}

const completeBuyerDraft = (d: BuyerDraft) =>
  d.crop && d.quantityKg !== undefined && d.location && d.offerPerKg !== undefined ? { crop: d.crop, quantityKg: d.quantityKg, location: d.location, offerPerKg: d.offerPerKg } : undefined;

/** กลุ่มเกษตรกร (ข้อมูลจำลอง) ของพืชนี้ ในรูปที่แสดงให้ผู้ซื้อได้ — ไม่มีราคาขั้นต่ำ */
function groupsFor(crop: Crop): GroupForBuyer[] {
  return groupListings(listings, farmers)
    .filter((g) => g.crop === crop)
    .map((g) => ({ crop: g.crop, cropLabel: CROP_LABEL_TH[g.crop], grade: g.grade, province: g.province, members: g.members.length, totalKg: g.members.reduce((n, m) => n + m.quantityKg, 0), window: g.deliveryWindow }));
}

/** แจ้งเตือนผู้ซื้อได้กี่คนต่อกลุ่มใหม่ (push นับโควตาข้อความของ LINE OA) */
export const MAX_BUYER_ALERTS = 5;

const STATUS_TH: Record<string, string> = {
  queued: 'รอเริ่มเจรจา',
  negotiating: 'น้องมะระกำลังเจรจา',
  pending_approval: 'เจรจาเสร็จแล้ว รอคุณอนุมัติ',
  agreed: 'ตกลงดีลแล้ว',
  rejected: 'ถูกปฏิเสธ',
  cancelled: 'ยกเลิก (ต่อรองใหม่)',
  failed: 'ยังไม่ได้ดีลที่ผ่านราคาขั้นต่ำ',
};

export class LineBot implements LineHooks {
  constructor(
    private getCtx: () => AppContext,
    private secrets: () => Promise<LineSecrets>,
    private makeClient: (token: string) => Pick<LineClient, 'reply' | 'push'> = (t) => new LineClient(t),
  ) {}

  /** URL ของระบบจาก webhook ล่าสุด (Lambda ประมวลผลทีละคำขอต่อ container จึงเก็บไว้ที่นี่ได้) */
  private baseUrl: string | undefined;

  async handleWebhook(rawBody: string, signature: string | undefined, baseUrl?: string): Promise<{ status: number; error?: string }> {
    this.baseUrl = baseUrl;
    let s: LineSecrets;
    try {
      s = await this.secrets();
    } catch (e) {
      console.error('line secrets unavailable:', (e as Error).message);
      return { status: 503, error: 'ยังไม่ได้ตั้งค่า LINE' };
    }
    if (!verifyLineSignature(rawBody, signature, s.channelSecret)) return { status: 401, error: 'ลายเซ็นไม่ถูกต้อง' };

    let events: LineEvent[] = [];
    try {
      const body = JSON.parse(rawBody) as { events?: unknown };
      events = Array.isArray(body.events) ? (body.events as LineEvent[]).slice(0, MAX_EVENTS) : [];
    } catch {
      return { status: 400, error: 'รูปแบบ JSON ไม่ถูกต้อง' };
    }
    const client = this.makeClient(s.channelAccessToken);
    for (const ev of events) {
      try {
        await this.handleEvent(ev, client);
      } catch (e) {
        // คืน 200 เสมอเมื่อลายเซ็นถูก กันไม่ให้เกิดการส่งซ้ำวนไปมา — ผู้ใช้ได้ข้อความขอโทษแทน
        console.error('line event failed:', ev.type, (e as Error).message);
        await this.safeReply(client, ev.replyToken, [text('ขอโทษค่ะ ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งได้เลย')]);
      }
    }
    return { status: 200 };
  }

  private async handleEvent(ev: LineEvent, client: Pick<LineClient, 'reply' | 'push'>) {
    if (ev.mode === 'standby') return;
    const userId = ev.source?.type === 'user' ? ev.source.userId : undefined;
    if (!userId || !ev.replyToken) return; // เฉพาะแชตส่วนตัว (ไม่รองรับกลุ่ม/ห้อง)
    if (ev.webhookEventId && !(await this.getCtx().store.claimWebhookEvent(ev.webhookEventId))) return; // เคยทำไปแล้ว

    const reply = (messages: LineMessage[]) => client.reply(ev.replyToken!, messages);
    try {
      if (ev.type === 'follow') return await reply([roleMessage()]);
      if (ev.type === 'message') {
        if (ev.message?.type !== 'text' || typeof ev.message.text !== 'string') return await reply([text('ส่งเป็นข้อความตัวอักษรนะคะ เช่น “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”')]);
        return await this.onText(userId, ev.message.text.slice(0, 1000), reply);
      }
      if (ev.type === 'postback' && ev.postback?.data) return await this.onPostback(userId, ev.postback.data, reply, client);
    } catch (e) {
      if (e instanceof AppError) return await reply([text(e.message)]);
      throw e;
    }
  }

  /** แก้เฉพาะฟิลด์ที่ระบุ (undefined = ลบ) โดยไม่ทำให้ฟิลด์อื่นของ session หาย เช่น บทบาท */
  private async save(userId: string, patch: { [K in keyof Omit<LineSession, 'updatedAt'>]?: LineSession[K] | undefined }) {
    const { store } = this.getCtx();
    const next: Record<string, unknown> = { ...(await store.getLineSession(userId)), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    await store.putLineSession(userId, { ...next, updatedAt: this.now() } as LineSession);
  }

  private async onText(userId: string, raw: string, reply: (m: LineMessage[]) => Promise<void>) {
    const t = raw.trim();
    const { store } = this.getCtx();
    if (GREETING.test(t)) {
      await this.save(userId, { role: undefined, draft: undefined, buyerDraft: undefined, awaiting: undefined, buyerNeg: undefined });
      return reply([roleMessage()]);
    }
    if (CANCEL.test(t)) {
      await this.save(userId, { draft: undefined, buyerDraft: undefined, awaiting: undefined, buyerNeg: undefined });
      return reply([text('ยกเลิกแล้วค่ะ พิมพ์ “เมนู” เพื่อเริ่มใหม่ได้เลย')]);
    }
    const session = await store.getLineSession(userId);
    if (session?.role === 'buyer') return this.onBuyerText(userId, t, session, reply);
    if (session?.awaiting === 'group_code') return this.onGroupCode(userId, t, reply);
    if (session?.awaiting === 'group_name') return this.onGroupName(userId, t, reply);

    if (STATUS.test(t)) {
      const deal = session?.lastDealId ? await store.getDeal(session.lastDealId) : undefined;
      return reply([text(deal ? `ดีลล่าสุดของคุณ: ${STATUS_TH[deal.status] ?? deal.status}` : 'ยังไม่มีดีลค่ะ พิมพ์ผลผลิตของคุณมาได้เลย')]);
    }
    // พิมพ์ผลผลิตครบในรูปแบบที่อ่านได้ → ไปขั้นยืนยันเลย (เร็ว ไม่ต้องเรียก AI)
    const r = parseListing(t);
    if (r.ok) return this.acceptListing(userId, session, r.draft, r.gradeAssumed, reply);
    // เกษตรกรพิมพ์คุย/ถามอิสระ → แชตกับ Nova ด้วยบริบทดีลของเขา
    if (session?.role === 'farmer') {
      const chat = await this.tryChat(userId, session, 'farmer', t);
      if (chat?.kind === 'listing') return this.acceptListing(userId, session, chat.draft, chat.gradeAssumed, reply, chat.text);
      if (chat) return reply([text(chat.text)]);
    }
    // ยังไม่ได้เลือกบทบาท และข้อความไม่เกี่ยวกับผลผลิตเลย → ให้เลือกบทบาทก่อน
    return reply([r.problems.length >= 3 ? (session?.role ? helpMessage() : roleMessage()) : problemsMessage(r.problems)]);
  }

  private async acceptListing(userId: string, session: LineSession | undefined, draft: ListingDraft, gradeAssumed: boolean, reply: (m: LineMessage[]) => Promise<void>, lead?: string) {
    if (session?.groupMode === 'mock' && draft.crop !== MOCK_GROUP_CROP) {
      return reply([text(`กลุ่มรหัส ${session.groupCode} เป็นกลุ่ม${CROP_LABEL_TH[MOCK_GROUP_CROP]}ค่ะ ถ้าจะขาย${CROP_LABEL_TH[draft.crop]} พิมพ์ “เมนู” แล้วเลือก “ให้น้องมะระหากลุ่มให้” ได้เลยนะคะ`)]);
    }
    await this.save(userId, { draft });
    return reply([...(lead ? [text(lead)] : []), confirmMessage(draft, gradeAssumed)]);
  }

  /** เรียกแชต AI (ถ้าตั้งไว้และยังไม่เกินโควตา) — ล้มเหลวได้ จะกลับไปใช้การตอบแบบกฎ */
  private async tryChat(userId: string, session: LineSession, role: 'farmer' | 'buyer', message: string): Promise<ChatAction | undefined> {
    const ctx = this.getCtx();
    const llm = ctx.chatLlm?.();
    if (!llm) return undefined;
    try {
      if (!(await ctx.store.takeDailyQuota(`chat-${bangkokDate((ctx.now ?? (() => new Date()))())}`, ctx.chatDailyLimit ?? 300))) return undefined;
      const context = role === 'farmer' ? await this.farmerContext(session) : await this.buyerContext(userId, session);
      const action = await smartChat(llm, { role, context, history: session.chat ?? [], message });
      await this.save(userId, { chat: [...(session.chat ?? []), { r: 'u' as const, t: message.slice(0, 500) }, { r: 'a' as const, t: action.text.slice(0, 500) }].slice(-MAX_HISTORY) });
      return action;
    } catch (e) {
      console.error('chat failed:', (e as Error).message);
      return undefined;
    }
  }

  /** บริบทของเกษตรกร: กลุ่ม รายการที่รอยืนยัน และดีลล่าสุด (รวมแต่ละรอบการเจรจา) — ไม่มีราคาขั้นต่ำของคนอื่น */
  private async farmerContext(session: LineSession) {
    const ctx = this.getCtx();
    const c: Record<string, unknown> = {
      role: 'เกษตรกร',
      supportedCrops: Object.values(CROP_LABEL_TH),
      howTo: ['พิมพ์ผลผลิต เช่น “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”', 'อนุมัติ/ไม่เอา/ต่อรองใหม่ กดปุ่มในการ์ดผลเจรจา', 'พิมพ์ “เมนู” เพื่อเปลี่ยนบทบาทหรือกลุ่ม'],
    };
    if (session.groupMode === 'mock') c.group = { code: session.groupCode, ...mockGroupInfo() };
    else if (session.groupMode) c.group = { mode: session.groupMode, ...(session.groupCode ? { code: session.groupCode } : {}), ...(session.groupName ? { name: session.groupName } : {}) };
    if (session.draft) c.pendingListing = { crop: CROP_LABEL_TH[session.draft.crop], quantityKg: session.draft.quantityKg, grade: session.draft.grade, myFloorPerKg: session.draft.floorPricePerKg, note: 'รอเกษตรกรกดยืนยัน' };
    const deal = session.lastDealId ? await ctx.store.getDeal(session.lastDealId) : undefined;
    if (deal) {
      const ld: Record<string, unknown> = { status: STATUS_TH[deal.status] ?? deal.status, crop: CROP_LABEL_TH[deal.crop] };
      if (deal.outcome?.kind === 'prepared' && deal.lineFarmerId) {
        try {
          ld.offer = await getFarmerOffer(ctx, deal.id, deal.lineFarmerId);
        } catch {
          /* ดีลที่ยังไม่มีข้อเสนอ */
        }
      }
      if (deal.outcome && 'reason' in deal.outcome) ld.reason = deal.outcome.reason;
      if (deal.metrics?.upliftVsChosenOpeningPerKg !== undefined) ld.netGainVsBuyerFirstOfferPerKg = deal.metrics.upliftVsChosenOpeningPerKg;
      if (deal.metrics?.marketMedianPerKg !== undefined) ld.marketMedianPerKg = deal.metrics.marketMedianPerKg;
      ld.rounds = negotiationRounds(await ctx.store.listEvents(deal.id)).map((r) => ({ round: r.round, buyer: r.buyerName, strategy: r.strategy, evidence: r.evidence, ourAskPerKg: r.askPerKg, buyerReplyPerKg: r.buyerPerKg, buyerObjection: r.objection }));
      c.lastDeal = ld;
    }
    return c;
  }

  /** บริบทของผู้ซื้อ: คำขอของเขา กลุ่มเกษตรกรที่ตรงกัน (ข้อมูลรวม) และราคาตลาด NABC */
  private async buyerContext(userId: string, session: LineSession) {
    const ctx = this.getCtx();
    const reqs = await ctx.store.listBuyerRequests(userId, 3);
    const crops = [...new Set(reqs.length ? reqs.map((r) => r.crop) : session.buyerDraft?.crop ? [session.buyerDraft.crop] : (['rice_hommali', 'bitter_gourd', 'cassava'] as Crop[]))];
    const date = bangkokDate((ctx.now ?? (() => new Date()))());
    const market: Record<string, unknown>[] = [];
    for (const crop of crops) {
      try {
        const province = groupsFor(crop)[0]?.province;
        const ref = await Promise.race([ctx.agentDeps().market.getReference(crop, date, province), new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000))]);
        if (ref) market.push({ crop: CROP_LABEL_TH[crop], source: 'NABC', date: ref.date, stale: ref.stale, medianPerKg: ref.medianPerKg, minPerKg: ref.minPerKg, maxPerKg: ref.maxPerKg });
      } catch {
        /* ไม่มีราคาตลาด = ไม่อ้าง */
      }
    }
    const step = session.buyerDraft?.step;
    return {
      role: 'ผู้ซื้อ',
      myRequests: reqs.map((r) => ({ crop: CROP_LABEL_TH[r.crop], quantityKg: r.quantityKg, location: r.location, offerPerKg: r.offerPerKg })),
      farmerGroups: crops.flatMap((c) => groupsFor(c)),
      market,
      groupFacts: ['ทุกกลุ่มส่งเป็นล็อตเดียวและจัดรถรวม ผู้ซื้อไม่ต้องรับทีละแปลง', 'เกรดเป็นข้อมูลที่เกษตรกรแจ้ง ยินดีให้ตรวจคุณภาพก่อนรับ', 'ผู้ซื้อโอนเงินตรงเข้าบัญชีเกษตรกรแต่ละคน'],
      ...(step && step !== 'confirm' ? { waitingFor: { crop: 'พืชที่ต้องการ', quantity: 'ปริมาณ', location: 'สถานที่ส่งมอบ', price: 'ราคาที่เสนอต่อกก.' }[step] } : {}),
      howTo: ['พิมพ์ “ซื้อ” เพื่อลงทะเบียนคำขอซื้อใหม่', 'พิมพ์ “คำขอของฉัน” เพื่อดูรายการ', 'พิมพ์ “เมนู” เพื่อเปลี่ยนบทบาท'],
    };
  }

  /** ค่าขนส่งโดยประมาณจากจังหวัดของกลุ่มเกษตรกรที่ตรงกับพืชนี้ ไปถึงที่ส่งมอบของผู้ซื้อ */
  private transportFor(crop: Crop, location: string, quantityKg?: number) {
    const province = groupsFor(crop)[0]?.province;
    return province ? estimateTransport(province, location, quantityKg) : undefined;
  }

  /** ราคาอ้างอิงตลาด NABC สำหรับช่วยผู้ซื้อตั้งราคา (null = ไม่มีข้อมูลของพืชนี้) */
  private async priceHint(crop: Crop): Promise<PriceHint | null> {
    const ctx = this.getCtx();
    try {
      const ref = await Promise.race([
        ctx.agentDeps().market.getReference(crop, bangkokDate((ctx.now ?? (() => new Date()))()), groupsFor(crop)[0]?.province),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
      ]);
      return ref ? { medianPerKg: ref.medianPerKg, minPerKg: ref.minPerKg, maxPerKg: ref.maxPerKg, date: ref.date, stale: ref.stale } : null;
    } catch {
      return null;
    }
  }

  // ---------- ผู้ซื้อเจรจากับกลุ่มเกษตรกร ----------

  private negGroup(crop: Crop): GroupForBuyer | undefined {
    return groupsFor(crop)[0];
  }

  private async startBuyerNeg(userId: string, session: LineSession, crop: Crop, reply: (m: LineMessage[]) => Promise<void>) {
    const ctx = this.getCtx();
    const terms = groupTerms(crop);
    const g = this.negGroup(crop);
    if (!terms || !g) return reply([text(`ตอนนี้ยังไม่มีกลุ่มเกษตรกรที่ขาย${CROP_LABEL_TH[crop]}ค่ะ ถ้ามีกลุ่มใหม่หนูจะแจ้งเตือนนะคะ`)]);
    let median: number | undefined;
    try {
      const ref = await Promise.race([ctx.agentDeps().market.getReference(crop, bangkokDate((ctx.now ?? (() => new Date()))()), g.province), new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000))]);
      median = ref?.medianPerKg;
    } catch {
      /* ไม่มีราคาตลาด = เปิดราคาจากเป้าของกลุ่ม */
    }
    const st: BuyerNegState = {
      id: `BNEG-${(ctx.newId ?? randomUUID)()}`,
      crop,
      groupId: terms.group.id,
      askPerKg: openingAsk(terms.minPassPerKg, median),
      minPassPerKg: terms.minPassPerKg,
      rounds: 0,
      status: 'open',
      startedAt: this.now(),
      ...(median !== undefined ? { marketMedianPerKg: median } : {}),
    } as BuyerNegState;
    await appendAudit(ctx, st.id, { actor: 'system', type: 'bneg.started', data: { buyerUserId: userId, crop, groupId: st.groupId, openingAskPerKg: st.askPerKg } });
    const withNeg: LineSession = { ...session, buyerNeg: st, buyerDraft: undefined };
    await this.save(userId, { buyerNeg: st, buyerDraft: undefined });
    // ผู้ซื้อมีคำขอซื้อพืชนี้อยู่แล้ว → ใช้ราคาที่เขาเสนอเป็นข้อเสนอแรก
    const req = (await ctx.store.listBuyerRequests(userId, 5)).find((r) => r.crop === crop);
    if (req) return reply([negotiationIntro(g), ...(await this.negRound(userId, withNeg, `ผู้ซื้อเสนอ ${req.offerPerKg} บาท/กก. ตามคำขอซื้อ`, req.offerPerKg))]);
    return reply([negotiationIntro(g), ...(await this.negRound(userId, withNeg, 'ขอทราบราคาที่กลุ่มเสนอ', undefined))]);
  }

  private async askEndBuyerNeg(userId: string, session: LineSession, reply: (m: LineMessage[]) => Promise<void>) {
    const st = session.buyerNeg!;
    await this.save(userId, { buyerNeg: { ...st, status: 'confirming_end' } });
    return reply([negotiationConfirmEnd(st.lastOfferPerKg, st.askPerKg)]);
  }

  /** ผู้ซื้อยืนยันราคาแล้ว → เกษตรกรในกลุ่ม (ตัวจำลอง) อนุมัติ → ตกลง · บันทึกทุกขั้นใน ledger */
  private async finalizeBuyerNeg(userId: string, session: LineSession, pricePerKg: number, reply: (m: LineMessage[]) => Promise<void>) {
    const ctx = this.getCtx();
    const st = session.buyerNeg!;
    const terms = groupTerms(st.crop)!;
    const g = this.negGroup(st.crop)!;
    if (pricePerKg < st.minPassPerKg) return reply([text('ราคานี้กลุ่มรับไม่ได้ค่ะ ขอเจรจาต่อนะคะ')]); // กันไว้อีกชั้น (ไม่ควรเกิด)
    await appendAudit(ctx, st.id, { actor: 'buyer', actorId: userId, type: 'bneg.buyer_confirmed', data: { pricePerKg } });
    for (const m of terms.members) await appendAudit(ctx, st.id, { actor: 'farmer', actorId: m.farmerId, type: 'bneg.approval', data: { decision: 'approve', simulated: true } });
    await appendAudit(ctx, st.id, { actor: 'system', type: 'bneg.agreed', data: { agreedPerKg: pricePerKg, deliveryStatus: 'not_started', paymentStatus: 'not_due' } });
    const done: BuyerNegState = { ...st, status: 'agreed', agreedPerKg: pricePerKg };
    delete done.pendingPerKg;
    await this.save(userId, { buyerNeg: done });
    return reply([text(`ยืนยันแล้วค่ะ ตกลงที่ ${pricePerKg.toFixed(2)} บาท/กก. ขอบคุณมากนะคะ 🙏`), negotiationAgreed(g, pricePerKg, terms.members.length)]);
  }

  private async endBuyerNeg(userId: string, session: LineSession, reply: (m: LineMessage[]) => Promise<void>) {
    const st = session.buyerNeg!;
    await appendAudit(this.getCtx(), st.id, { actor: 'buyer', actorId: userId, type: 'bneg.ended', data: { rounds: st.rounds, lastAskPerKg: st.askPerKg } });
    await this.save(userId, { buyerNeg: { ...st, status: 'ended' } });
    return reply([text(`จบการเจรจาแล้วค่ะ ขอบคุณที่สนใจนะคะ ถ้าเปลี่ยนใจ กด “สนใจ เจรจากับกลุ่มนี้” หรือพิมพ์ “สนใจ” ได้เสมอค่ะ (ราคาล่าสุดที่หนูเสนอ ${st.askPerKg.toFixed(2)} บาท/กก.)`)]);
  }

  /** 1 รอบการเจรจา: โค้ดตัดสินราคา → บันทึก ledger → Nova เขียนข้อความตามการตัดสิน (หรือใช้ข้อความสำเร็จรูป) */
  private async negRound(userId: string, session: LineSession, message: string, offerOverride?: number): Promise<LineMessage[]> {
    const ctx = this.getCtx();
    const st = session.buyerNeg!;
    const offer = offerOverride ?? extractOffer(message, st.askPerKg);
    const d = decide(st, offer);
    const next = apply(st, offer, d);
    if (offer !== undefined) await appendAudit(ctx, st.id, { actor: 'buyer', actorId: userId, type: 'bneg.buyer_offer', data: { offerPerKg: offer, round: next.rounds } });
    if (d.kind !== 'question') await appendAudit(ctx, st.id, { actor: 'agent', type: `bneg.${d.kind}`, data: d.kind === 'accept' ? { agreedPerKg: d.agreedPerKg } : { askPerKg: d.askPerKg } });
    const g = this.negGroup(st.crop)!;
    const say = await this.negotiatorText(userId, session, next, d, offer, message, g);
    if (d.kind === 'accept') {
      // ยังไม่ตกลง: ให้ผู้ซื้อยืนยันราคาที่ระบบตีความจากข้อความก่อน
      await this.save(userId, { buyerNeg: next });
      return [text(`รอบ ${next.rounds} · คุณเสนอ ${d.agreedPerKg.toFixed(2)} บาท/กก. · กลุ่มรับได้\n${say}`), negotiationConfirmDeal(g, d.agreedPerKg)];
    }
    await this.save(userId, { buyerNeg: next });
    const status = d.kind === 'question' ? `ราคาที่หนูเสนออยู่: ${next.askPerKg.toFixed(2)} บาท/กก.` : negotiationStatusLine(offer, next.askPerKg, next.rounds) + (d.kind === 'final' ? ' (ราคาสุดท้าย)' : '');
    return [negotiationText(`${status}\n${say}`, next.askPerKg)];
  }

  private async negotiatorText(userId: string, session: LineSession, st: BuyerNegState, d: BuyerNegDecision, offer: number | undefined, message: string, g: GroupForBuyer): Promise<string> {
    const ctx = this.getCtx();
    const price = d.kind === 'accept' ? d.agreedPerKg : d.askPerKg;
    const median = (st as BuyerNegState & { marketMedianPerKg?: number }).marketMedianPerKg;
    const terms = groupTerms(st.crop)!;
    const evidence = [
      ...(median !== undefined ? [{ id: 'market', text: `ราคากลางตลาด NABC ${median.toFixed(2)} บาท/กก.` }] : []),
      { id: 'volume', text: `ปริมาณรวม ${g.totalKg.toLocaleString('en-US')} กก. จาก ${g.members} ราย ส่งเป็นล็อตเดียว` },
      { id: 'logistics', text: `จัดรถรวม ${terms.trips.length} เที่ยว ผู้ซื้อไม่ต้องรับทีละแปลง` },
      { id: 'grade', text: `เกรด ${g.grade} ทุกราย (ตามที่เกษตรกรแจ้ง) ยินดีให้ตรวจคุณภาพก่อนรับ` },
      { id: 'delivery', text: `ส่งมอบได้ ${g.window.from} ถึง ${g.window.to}` },
    ];
    let out: string | undefined;
    const llm = ctx.chatLlm?.();
    if (llm) {
      try {
        if (await ctx.store.takeDailyQuota(`chat-${bangkokDate((ctx.now ?? (() => new Date()))())}`, ctx.chatDailyLimit ?? 300)) {
          const context = {
            group: { crop: g.cropLabel, province: g.province, members: g.members, totalKg: g.totalKg, grade: g.grade },
            evidence,
            decision: { kind: d.kind, ...(d.kind === 'accept' ? { agreedPerKg: d.agreedPerKg } : { askPerKg: d.askPerKg }), ...(offer !== undefined ? { buyerOfferPerKg: offer } : {}), round: st.rounds, maxRounds: MAX_BUYER_ROUNDS },
          };
          const r = await smartChat(llm, { role: 'negotiator', context, history: session.chat ?? [], message });
          out = r.text;
          await this.save(userId, { chat: [...(session.chat ?? []), { r: 'u' as const, t: message.slice(0, 500) }, { r: 'a' as const, t: r.text.slice(0, 500) }].slice(-MAX_HISTORY) });
        }
      } catch (e) {
        console.error('negotiator chat failed:', (e as Error).message);
      }
    }
    const template = () => {
      const ev = evidence[st.rounds % evidence.length]!.text;
      return d.kind === 'accept' ? `ราคา ${price.toFixed(2)} บาท/กก. กลุ่มรับได้ค่ะ กดยืนยันด้านล่างเพื่อตกลงนะคะ`
        : d.kind === 'final' ? `${price.toFixed(2)} บาท/กก. เป็นราคาสุดท้ายที่กลุ่มรับได้ค่ะ เพราะ${ev}`
        : d.kind === 'question' ? `ตอนนี้หนูเสนอ ${price.toFixed(2)} บาท/กก. ค่ะ เพราะ${ev}`
        : `${offer !== undefined ? `ราคา ${offer.toFixed(2)} บาท/กก. กลุ่มยังรับไม่ได้ค่ะ ` : ''}หนูขอเสนอ ${price.toFixed(2)} บาท/กก. เพราะ${ev}`;
    };
    if (!out) return template();
    // ข้อความของ AI ต้องตรงกับการตัดสินของโค้ด: พูดราคาที่ตัดสิน และไม่ฟังเหมือนรับราคาผู้ซื้อในรอบที่ยังไม่รับ ไม่งั้นใช้ข้อความสำเร็จรูป
    const shown = [price.toFixed(2), String(price)].some((p) => out!.includes(p));
    const contradicts = d.kind !== 'accept' && SOUNDS_ACCEPTING.test(out);
    return shown && !contradicts ? out : template();
  }

  private async buyerChatReply(userId: string, chat: ChatAction, reply: (m: LineMessage[]) => Promise<void>, reAsk?: LineMessage) {
    if (chat.kind === 'buyer_request') {
      await this.save(userId, { buyerDraft: { step: 'confirm', ...chat.draft } });
      return reply([text(chat.text), buyerConfirmMessage(chat.draft, this.transportFor(chat.draft.crop, chat.draft.location, chat.draft.quantityKg))]);
    }
    return reply([text(chat.text), ...(reAsk ? [reAsk] : [])]);
  }

  private async onGroupCode(userId: string, t: string, reply: (m: LineMessage[]) => Promise<void>) {
    const code = t.replace(/[๐-๙]/g, (d) => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d))).replace(/\s|-/g, '');
    if (!/^\d{4,6}$/.test(code)) return reply([text('รหัสกลุ่มเป็นตัวเลข 4–6 หลักค่ะ ลองพิมพ์ใหม่อีกครั้ง หรือพิมพ์ “ยกเลิก”')]);
    if (MOCK_GROUP_CODES.includes(code)) {
      await this.save(userId, { awaiting: undefined, groupMode: 'mock', groupCode: code, groupName: undefined });
      return reply([joinedMockGroupMessage(code, mockGroupInfo())]);
    }
    const g = await this.getCtx().store.joinFarmerGroup(code, userId);
    if (!g) return reply([groupNotFound()]);
    await this.save(userId, { awaiting: undefined, groupMode: 'joined', groupCode: g.code, groupName: g.name });
    return reply([joinedGroupMessage(g.name, g.code, g.members.length)]);
  }

  private async onGroupName(userId: string, t: string, reply: (m: LineMessage[]) => Promise<void>) {
    const name = t.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 40) return reply([text('ชื่อกลุ่มยาว 2–40 ตัวอักษรค่ะ ลองตั้งใหม่อีกครั้งนะคะ')]);
    const { store } = this.getCtx();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(randomInt(10_000, 100_000));
      if (MOCK_GROUP_CODES.includes(code)) continue;
      if (await store.createFarmerGroup({ code, name, ownerUserId: userId, members: [userId], createdAt: this.now() })) {
        await this.save(userId, { awaiting: undefined, groupMode: 'created', groupCode: code, groupName: name });
        return reply(createdGroupMessages(name, code));
      }
    }
    throw new Error('สุ่มรหัสกลุ่มไม่สำเร็จ');
  }

  /** ผู้ซื้อ (คนจริง) ตอบทีละข้อ: พืช → ปริมาณ → สถานที่ส่ง → ราคาที่เสนอ → ยืนยัน */
  private async onBuyerText(userId: string, t: string, session: LineSession, reply: (m: LineMessage[]) => Promise<void>) {
    if (MY_REQUESTS.test(t)) return reply([buyerRequestsMessage(await this.getCtx().store.listBuyerRequests(userId, 5))]);
    // กำลังเจรจาราคากับกลุ่มเกษตรกร → ทุกข้อความเป็นส่วนหนึ่งของการเจรจา
    const neg = session.buyerNeg;
    if (neg?.status === 'confirming' && neg.pendingPerKg !== undefined) {
      if (YES.test(t)) return this.finalizeBuyerNeg(userId, session, neg.pendingPerKg, reply);
      const reopened = { ...neg, status: 'open' as const };
      delete reopened.pendingPerKg;
      return reply(await this.negRound(userId, { ...session, buyerNeg: reopened }, t));
    }
    if (neg?.status === 'confirming_end') {
      if (YES.test(t) || END_NEG.test(t)) return this.endBuyerNeg(userId, session, reply);
      return reply(await this.negRound(userId, { ...session, buyerNeg: { ...neg, status: 'open' } }, t));
    }
    if (neg?.status === 'open') {
      if (END_NEG.test(t)) return this.askEndBuyerNeg(userId, session, reply);
      return reply(await this.negRound(userId, session, t));
    }
    if (INTEREST.test(t)) {
      const latest = (await this.getCtx().store.listBuyerRequests(userId, 1))[0];
      return this.startBuyerNeg(userId, session, latest?.crop ?? session.buyerDraft?.crop ?? 'rice_hommali', reply);
    }
    const d = session.buyerDraft;
    if (!d) {
      // ไม่มีคำขอที่กำลังกรอก → คุยกับน้องมะระได้ (ถามเรื่องกลุ่มเกษตรกร/ราคา) หรือพิมพ์ “ซื้อ” เพื่อลงทะเบียน
      if (!NEW_REQUEST.test(t)) {
        const chat = await this.tryChat(userId, session, 'buyer', t);
        if (chat) return this.buyerChatReply(userId, chat, reply);
      }
      await this.save(userId, { buyerDraft: { step: 'crop' } });
      return reply([buyerCropMessage()]);
    }
    // ตอบไม่ตรงคำถามของขั้นนี้ (เช่น ถามกลับ) → ให้น้องมะระตอบ แล้วถามคำถามเดิมซ้ำ
    const reAsk = d.step === 'crop' ? buyerCropMessage() : d.step === 'quantity' && d.crop ? buyerAskQuantity(d.crop) : d.step === 'location' ? buyerAskLocation() : d.step === 'price' ? buyerAskPrice(d.crop && CROP_LABEL_TH[d.crop]) : undefined;
    const answers = d.step === 'crop' ? parseBuyerCrop(t).ok : d.step === 'quantity' ? parseBuyerQuantity(t).ok : d.step === 'location' ? parseBuyerLocation(t).ok && !/[?？]|ไหม|อะไร|ทำไม|เท่าไร|อย่างไร/.test(t) : d.step === 'price' ? parseBuyerPrice(t).ok : false;
    if (!answers && reAsk) {
      const chat = await this.tryChat(userId, session, 'buyer', t);
      if (chat) return this.buyerChatReply(userId, chat, reply, reAsk);
    }
    switch (d.step) {
      case 'crop': {
        const r = parseBuyerCrop(t);
        if (!r.ok) return reply([text(r.problem), buyerCropMessage()]);
        await this.save(userId, { buyerDraft: { step: 'quantity', crop: r.value } });
        return reply([buyerAskQuantity(r.value)]);
      }
      case 'quantity': {
        const r = parseBuyerQuantity(t);
        if (!r.ok) return reply([text(r.problem)]);
        await this.save(userId, { buyerDraft: { ...d, step: 'location', quantityKg: r.value } });
        return reply([buyerAskLocation()]);
      }
      case 'location': {
        const r = parseBuyerLocation(t);
        if (!r.ok) return reply([text(r.problem)]);
        await this.save(userId, { buyerDraft: { ...d, step: 'price', location: r.value } });
        return reply([buyerAskPrice(d.crop && CROP_LABEL_TH[d.crop], d.crop ? await this.priceHint(d.crop) : undefined, d.crop ? this.transportFor(d.crop, r.value, d.quantityKg) : undefined)]);
      }
      case 'price': {
        const r = parseBuyerPrice(t);
        if (!r.ok) return reply([text(r.problem)]);
        const next: BuyerDraft = { ...d, step: 'confirm', offerPerKg: r.value };
        await this.save(userId, { buyerDraft: next });
        const full = completeBuyerDraft(next);
        return reply(full ? [buyerConfirmMessage(full, this.transportFor(full.crop, full.location, full.quantityKg))] : [text('ข้อมูลไม่ครบค่ะ ขอเริ่มใหม่นะคะ'), buyerCropMessage()]);
      }
      default:
        return reply([text('กดปุ่ม “ยืนยันคำขอซื้อ” หรือ “แก้ไข” ในข้อความด้านบนได้เลยค่ะ หรือพิมพ์ “ยกเลิก”')]);
    }
  }

  private async onPostback(userId: string, data: string, reply: (m: LineMessage[]) => Promise<void>, client: Pick<LineClient, 'push'>) {
    const pb = parsePostback(data);
    if (!pb) return;
    const ctx = this.getCtx();
    const { store } = ctx;

    if (pb.act === 'role_farmer') {
      await this.save(userId, { role: 'farmer', buyerDraft: undefined, awaiting: undefined });
      return reply([groupChoiceMessage()]);
    }
    if (pb.act === 'group_join') {
      await this.save(userId, { role: 'farmer', awaiting: 'group_code' });
      return reply([askGroupCode()]);
    }
    if (pb.act === 'group_create') {
      await this.save(userId, { role: 'farmer', awaiting: 'group_name' });
      return reply([askGroupName()]);
    }
    if (pb.act === 'group_auto') {
      await this.save(userId, { role: 'farmer', awaiting: undefined, groupMode: 'auto', groupCode: undefined, groupName: undefined });
      return reply([autoGroupMessage()]);
    }
    if (pb.act === 'role_buyer' || pb.act === 'buyer_edit') {
      await this.save(userId, { role: 'buyer', draft: undefined, buyerDraft: { step: 'crop' } });
      return reply([buyerCropMessage()]);
    }
    if (pb.act === 'buyer_crop') {
      if (!pb.crop) return;
      await this.save(userId, { role: 'buyer', draft: undefined, buyerDraft: { step: 'quantity', crop: pb.crop } });
      return reply([buyerAskQuantity(pb.crop)]);
    }
    if (pb.act === 'buyer_negotiate') {
      const session = (await store.getLineSession(userId)) ?? { updatedAt: this.now() };
      await this.save(userId, { role: 'buyer' });
      return this.startBuyerNeg(userId, { ...session, role: 'buyer' }, pb.crop ?? 'rice_hommali', reply);
    }
    if (['buyer_accept', 'buyer_end', 'buyer_deal_confirm', 'buyer_deal_back', 'buyer_end_confirm'].includes(pb.act)) {
      const session = await store.getLineSession(userId);
      const neg = session?.buyerNeg;
      if (!session || !neg || neg.status === 'agreed' || neg.status === 'ended') {
        return reply([text(neg?.status === 'agreed' ? `การเจรจานี้ตกลงไปแล้วที่ ${neg.agreedPerKg?.toFixed(2)} บาท/กก. ค่ะ` : 'ตอนนี้ไม่มีการเจรจาที่เปิดอยู่ค่ะ กด “สนใจ เจรจากับกลุ่มนี้” ในการ์ดกลุ่มเกษตรกรเพื่อเริ่มใหม่ได้เลย')]);
      }
      // ปุ่มที่ระบุราคาชัดเจน (ยอมรับราคาที่หนูเสนอ) = ผู้ซื้อยืนยันเองแล้ว ไม่ต้องถามซ้ำ
      if (pb.act === 'buyer_accept') return this.finalizeBuyerNeg(userId, session, neg.askPerKg, reply);
      if (pb.act === 'buyer_deal_confirm' && neg.status === 'confirming' && neg.pendingPerKg !== undefined) return this.finalizeBuyerNeg(userId, session, neg.pendingPerKg, reply);
      if (pb.act === 'buyer_end') return this.askEndBuyerNeg(userId, session, reply);
      if (pb.act === 'buyer_end_confirm' && neg.status === 'confirming_end') return this.endBuyerNeg(userId, session, reply);
      // ยังไม่ตกลง / เจรจาต่อ
      const reopened = { ...neg, status: 'open' as const };
      delete reopened.pendingPerKg;
      await this.save(userId, { buyerNeg: reopened });
      return reply([negotiationText(`ได้ค่ะ เจรจาต่อได้เลย ตอนนี้หนูเสนอ ${neg.askPerKg.toFixed(2)} บาท/กก. เสนอราคาหรือถามอะไรก็ได้ค่ะ`, neg.askPerKg)]);
    }
    if (pb.act === 'buyer_confirm') {
      const session = await store.getLineSession(userId);
      const full = session?.buyerDraft?.step === 'confirm' ? completeBuyerDraft(session.buyerDraft) : undefined;
      if (!full) return reply([text('ไม่มีคำขอซื้อที่รอยืนยันค่ะ พิมพ์อะไรมาก็ได้เพื่อเริ่มลงทะเบียนใหม่')]);
      await this.save(userId, { buyerDraft: undefined }); // ล้างก่อน กันกดยืนยันซ้ำแล้วบันทึกสองรายการ
      try {
        await store.createBuyerRequest({ id: (ctx.newId ?? randomUUID)(), userId, ...full, status: 'open', createdAt: this.now() });
      } catch (e) {
        await this.save(userId, { buyerDraft: session!.buyerDraft });
        throw e;
      }
      return reply(buyerMatchesMessages(full, groupsFor(full.crop)));
    }

    if (pb.act === 'edit') {
      await this.save(userId, { draft: undefined });
      return reply([text('ได้ค่ะ พิมพ์ผลผลิตใหม่ได้เลย เช่น “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”')]);
    }

    if (pb.act === 'confirm') {
      const session = await store.getLineSession(userId);
      const draft = session?.draft;
      if (!draft) return reply([text('ไม่มีรายการรอยืนยันค่ะ พิมพ์ผลผลิตของคุณมาใหม่ได้เลย')]);
      // ล้างร่างก่อนเริ่ม กันกดยืนยันซ้ำแล้วเกิดสองดีล
      await this.save(userId, { draft: undefined });
      let dealId: string;
      try {
        const { id } = await startDeal(ctx, {}, { line: { userId, draft, ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}) } });
        await this.save(userId, { lastDealId: id });
        dealId = id;
      } catch (e) {
        await this.save(userId, { draft }); // ให้กดยืนยันซ้ำได้ (เช่น โควตาเต็ม)
        throw e;
      }
      await reply([...(await this.groupSummary(dealId, session)), startedMessage()]);
      await this.alertBuyers(dealId, userId, client);
      return;
    }

    // อนุมัติ / ไม่เอา / ต่อรองใหม่ ต้องมี dealId และต้องเป็นดีลของผู้ใช้คนนี้เท่านั้น
    if (!pb.dealId) return;
    const deal = await store.getDeal(pb.dealId);
    if (!deal || deal.lineUserId !== userId || !deal.lineFarmerId) return reply([text('ไม่พบดีลนี้ในรายการของคุณค่ะ')]);
    const farmerId = deal.lineFarmerId;

    if (pb.act === 'renegotiate') {
      const { id } = await renegotiate(ctx, pb.dealId, userId, this.baseUrl);
      await this.save(userId, { lastDealId: id });
      return reply([text('ได้ค่ะ น้องมะระเริ่มเจรจาใหม่ให้แล้ว 🔁 ใช้เวลาประมาณ 1–2 นาที หนูจะส่งผลให้ดูอีกครั้ง')]);
    }

    if (deal.status !== 'pending_approval') return reply([text(`ดีลนี้${STATUS_TH[deal.status] ?? deal.status}แล้ว กดอนุมัติหรือไม่เอาอีกไม่ได้ค่ะ`)]);
    const decided = deal.approvals[farmerId];
    if (decided) return reply([text(`คุณตอบดีลนี้ไปแล้ว (${decided === 'approve' ? 'อนุมัติ' : 'ไม่เอา'}) ค่ะ`)]);

    await recordApproval(ctx, pb.dealId, { farmerId, decision: pb.act });
    const r = await approveSimulatedMembers(ctx, pb.dealId, farmerId);

    if (pb.act === 'approve') {
      if (r.status === 'agreed') {
        return reply([text(['อนุมัติแล้ว ✓ ดีลตกลงครบทุกคน 🎉', 'สถานะ: ตกลงดีลแล้ว · ส่งมอบ: ยังไม่เริ่ม · ชำระเงิน: ยังไม่ถึงกำหนด (แยกสถานะกัน)', 'ผู้ซื้อโอนเงินตรงเข้าบัญชีของคุณหลังส่งมอบ ระบบไม่ถือเงิน', 'ทุกขั้นถูกบันทึกใน ledger แบบ hash chain', '', MOCK_NOTE].join('\n'))]);
      }
      return reply(this.notAgreed('อนุมัติแล้ว ✓ แต่ดีลยังปิดไม่ได้', r, pb.dealId));
    }
    // ไม่เอา: ถอนตัว กลุ่มที่เหลือ (จำลอง) ไปต่อได้ถ้ายังผ่านราคาขั้นต่ำและปริมาณขั้นต่ำของผู้ซื้อ
    if (r.status === 'agreed') {
      return reply([text('บันทึกแล้ว ✓ คุณไม่เอาดีลนี้และถอนตัวจากกลุ่ม\nกลุ่มที่เหลือ (ตัวจำลอง) ผ่านเกณฑ์ราคาและปริมาณ จึงไปต่อและตกลงดีลได้โดยไม่รวมผลผลิตของคุณ\n\n' + MOCK_NOTE)]);
    }
    return reply(this.notAgreed('บันทึกแล้ว ✓ คุณไม่เอาดีลนี้และถอนตัวจากกลุ่ม', r, pb.dealId));
  }

  /** มีกลุ่มเกษตรกรพร้อมขาย → แจ้งผู้ซื้อที่มีคำขอซื้อพืชนี้เปิดอยู่ (คนละ 1 ข้อความ) — ล้มเหลวได้โดยไม่กระทบเกษตรกร */
  private async alertBuyers(dealId: string, farmerUserId: string, client: Pick<LineClient, 'push'>) {
    try {
      const ctx = this.getCtx();
      const v = await getDeal(ctx, dealId);
      const g: GroupForBuyer = { crop: v.group.crop as Crop, cropLabel: v.group.cropLabel, grade: v.group.grade, province: v.group.province, members: v.group.members, totalKg: v.group.totalKg, window: v.group.window };
      const crop = (await ctx.store.getDeal(dealId))!.crop;
      const seen = new Set<string>([farmerUserId]);
      const requests = (await ctx.store.listOpenBuyerRequestsByCrop(crop, 50)).filter((r) => !seen.has(r.userId) && (seen.add(r.userId), true)).slice(0, MAX_BUYER_ALERTS);
      for (const r of requests) {
        try {
          await client.push(r.userId, [buyerAlertMessage(g, r)]);
        } catch (e) {
          console.error('buyer alert failed:', (e as Error).message);
        }
      }
    } catch (e) {
      console.error('buyer alerts skipped:', (e as Error).message);
    }
  }

  /** บอกเกษตรกรว่าผลผลิตถูกรวมกับกลุ่มไหน — ล้มเหลวได้โดยไม่กระทบการเจรจา */
  private async groupSummary(dealId: string, session: LineSession): Promise<LineMessage[]> {
    try {
      const v = await getDeal(this.getCtx(), dealId);
      const g = { members: v.group.members, province: v.group.province, totalKg: v.group.totalKg };
      const prefix =
        session.groupMode === 'mock' ? `กลุ่มรหัส ${session.groupCode}` :
        session.groupMode === 'created' || session.groupMode === 'joined' ? `กลุ่ม “${session.groupName}” (ต้นแบบ: รวมกับเกษตรกรจำลองในพื้นที่)` :
        'หนูหากลุ่มให้แล้ว';
      return [groupSummaryText(prefix, g)];
    } catch {
      return [];
    }
  }

  private notAgreed(head: string, r: { reason?: string | undefined; needsRenegotiation: boolean }, dealId: string): LineMessage[] {
    const msg = text(`${head}\nเหตุผล: ${r.reason ?? 'ยังรอสมาชิกอื่น'}`);
    return r.needsRenegotiation ? [msg, ...failedMessage(dealId, r.reason ?? 'ต้องเจรจาใหม่', true).slice(1)] : [msg];
  }

  /** worker เรียกเมื่อเจรจาเสร็จ — push ผลหาเกษตรกรครั้งเดียว (ดีลที่ไม่ได้เริ่มจาก LINE ไม่ทำอะไร) */
  async notifyDealReady(dealId: string): Promise<void> {
    const ctx = this.getCtx();
    const deal = await ctx.store.getDeal(dealId);
    if (!deal?.lineUserId || !deal.lineFarmerId) return;
    const { channelAccessToken } = await this.secrets();
    const client = this.makeClient(channelAccessToken);
    if (deal.status === 'pending_approval' && deal.outcome?.kind === 'prepared') {
      const offer = await getFarmerOffer(ctx, dealId, deal.lineFarmerId);
      const others = offer.group.memberCount - 1;
      const events = await ctx.store.listEvents(dealId);
      const extras: OfferExtras = {
        rounds: negotiationRounds(events),
        chosenBuyerId: deal.outcome.buyerId,
        blocks: events.filter((e) => e.type === 'agent.guardrail_blocked').length,
        ...(deal.lineBaseUrl ? { detailsUrl: `${deal.lineBaseUrl.replace(/\/?$/, '/')}?deal=${encodeURIComponent(dealId)}` } : {}),
      };
      await client.push(deal.lineUserId, [offerMessage(dealId, offer, `เพื่อนในกลุ่มอีก ${others} คนเป็นตัวจำลอง จะอนุมัติให้อัตโนมัติเมื่อคุณกดตอบ`, extras)]);
    } else if (deal.status === 'failed') {
      const reason = deal.outcome && 'reason' in deal.outcome ? deal.outcome.reason : (deal.error ?? 'ไม่ทราบสาเหตุ');
      await client.push(deal.lineUserId, failedMessage(dealId, reason, (deal.round ?? 0) < MAX_LINE_ROUNDS));
    }
  }

  private async safeReply(client: Pick<LineClient, 'reply'>, token: string | undefined, messages: LineMessage[]) {
    if (!token) return;
    try {
      await client.reply(token, messages);
    } catch (e) {
      console.error('line reply failed:', (e as Error).message);
    }
  }

  private now() {
    return (this.getCtx().now ?? (() => new Date()))().toISOString();
  }
}
