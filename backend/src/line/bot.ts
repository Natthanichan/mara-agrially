// บทสนทนา LINE ของน้องมะระ (ผู้หญิง: หนู/ค่ะ/คะ) — เลือกบทบาทเกษตรกรหรือผู้ซื้อ
// ฝั่งเกษตรกร:
//   พิมพ์ผลผลิต → สรุป + ปุ่มยืนยัน → เริ่มเจรจา → (เจรจาเสร็จ) ส่งผลครั้งเดียวพร้อมปุ่ม [อนุมัติ] [ไม่เอา] [ต่อรองใหม่]
// ตัวเลขเงินทั้งหมดมาจาก service (โค้ดคำนวณ) — ไฟล์นี้แค่แปลงเป็นข้อความ ไม่คิดเงินเอง
// สมาชิกกลุ่มคนอื่นเป็นตัวจำลอง อนุมัติอัตโนมัติและติดป้าย simulated ใน ledger
// ฝั่งผู้ซื้อ (คนจริง): บอทถามทีละข้อ ผลผลิต → ปริมาณ → สถานที่ส่ง → ราคาที่เสนอ → ยืนยัน แล้วบันทึกคำขอซื้อ

import {
  AppError,
  approveSimulatedMembers,
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
  buyerSavedMessage,
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
} from './flex.js';
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

/** ภาพรวมผลผลิตของพืชนี้ในระบบ (ข้อมูลจำลอง) — ไม่มีราคาขั้นต่ำของใคร */
function supplyOf(crop: Crop) {
  const ls = listings.filter((l) => l.crop === crop);
  const provinces = [...new Set(ls.flatMap((l) => farmers.find((f) => f.id === l.farmerId)?.province ?? []))];
  return { farmers: new Set(ls.map((l) => l.farmerId)).size, totalKg: ls.reduce((n, l) => n + l.quantityKg, 0), provinces };
}

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

  async handleWebhook(rawBody: string, signature: string | undefined): Promise<{ status: number; error?: string }> {
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
      if (ev.type === 'postback' && ev.postback?.data) return await this.onPostback(userId, ev.postback.data, reply);
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
      await this.save(userId, { role: undefined, draft: undefined, buyerDraft: undefined, awaiting: undefined });
      return reply([roleMessage()]);
    }
    if (CANCEL.test(t)) {
      await this.save(userId, { draft: undefined, buyerDraft: undefined, awaiting: undefined });
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
    const r = parseListing(t);
    // ยังไม่ได้เลือกบทบาท และข้อความไม่เกี่ยวกับผลผลิตเลย → ให้เลือกบทบาทก่อน
    if (!r.ok) return reply([r.problems.length >= 3 ? (session?.role ? helpMessage() : roleMessage()) : problemsMessage(r.problems)]);
    if (session?.groupMode === 'mock' && r.draft.crop !== MOCK_GROUP_CROP) {
      return reply([text(`กลุ่มรหัส ${session.groupCode} เป็นกลุ่ม${CROP_LABEL_TH[MOCK_GROUP_CROP]}ค่ะ ถ้าจะขาย${CROP_LABEL_TH[r.draft.crop]} พิมพ์ “เมนู” แล้วเลือก “ให้น้องมะระหากลุ่มให้” ได้เลยนะคะ`)]);
    }
    await this.save(userId, { draft: r.draft });
    return reply([confirmMessage(r.draft, r.gradeAssumed)]);
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
    const d = session.buyerDraft;
    if (!d) {
      await this.save(userId, { buyerDraft: { step: 'crop' } });
      return reply([buyerCropMessage()]);
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
        return reply([buyerAskPrice()]);
      }
      case 'price': {
        const r = parseBuyerPrice(t);
        if (!r.ok) return reply([text(r.problem)]);
        const next: BuyerDraft = { ...d, step: 'confirm', offerPerKg: r.value };
        await this.save(userId, { buyerDraft: next });
        const full = completeBuyerDraft(next);
        return reply(full ? [buyerConfirmMessage(full)] : [text('ข้อมูลไม่ครบค่ะ ขอเริ่มใหม่นะคะ'), buyerCropMessage()]);
      }
      default:
        return reply([text('กดปุ่ม “ยืนยันคำขอซื้อ” หรือ “แก้ไข” ในข้อความด้านบนได้เลยค่ะ หรือพิมพ์ “ยกเลิก”')]);
    }
  }

  private async onPostback(userId: string, data: string, reply: (m: LineMessage[]) => Promise<void>) {
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
      return reply([buyerSavedMessage(full, supplyOf(full.crop))]);
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
        const { id } = await startDeal(ctx, {}, { line: { userId, draft } });
        await this.save(userId, { lastDealId: id });
        dealId = id;
      } catch (e) {
        await this.save(userId, { draft }); // ให้กดยืนยันซ้ำได้ (เช่น โควตาเต็ม)
        throw e;
      }
      return reply([...(await this.groupSummary(dealId, session)), startedMessage()]);
    }

    // อนุมัติ / ไม่เอา / ต่อรองใหม่ ต้องมี dealId และต้องเป็นดีลของผู้ใช้คนนี้เท่านั้น
    if (!pb.dealId) return;
    const deal = await store.getDeal(pb.dealId);
    if (!deal || deal.lineUserId !== userId || !deal.lineFarmerId) return reply([text('ไม่พบดีลนี้ในรายการของคุณค่ะ')]);
    const farmerId = deal.lineFarmerId;

    if (pb.act === 'renegotiate') {
      const { id } = await renegotiate(ctx, pb.dealId, userId);
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
      await client.push(deal.lineUserId, [offerMessage(dealId, offer, `เพื่อนในกลุ่มอีก ${others} คนเป็นตัวจำลอง จะอนุมัติให้อัตโนมัติเมื่อคุณกดตอบ`)]);
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
