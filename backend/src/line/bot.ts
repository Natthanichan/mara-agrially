// บทสนทนา LINE ของน้องมะระ
//   พิมพ์ผลผลิต → สรุป + ปุ่มยืนยัน → เริ่มเจรจา → (เจรจาเสร็จ) ส่งผลครั้งเดียวพร้อมปุ่ม [อนุมัติ] [ไม่เอา] [ต่อรองใหม่]
// ตัวเลขเงินทั้งหมดมาจาก service (โค้ดคำนวณ) — ไฟล์นี้แค่แปลงเป็นข้อความ ไม่คิดเงินเอง
// สมาชิกกลุ่มคนอื่นเป็นตัวจำลอง อนุมัติอัตโนมัติและติดป้าย simulated ใน ledger

import {
  AppError,
  approveSimulatedMembers,
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
import { confirmMessage, failedMessage, helpMessage, offerMessage, parsePostback, problemsMessage, startedMessage, text, MOCK_NOTE } from './flex.js';
import { parseListing } from './parse.js';
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
const MAX_EVENTS = 20;

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
        await this.safeReply(client, ev.replyToken, [text('ขอโทษครับ ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งได้เลย')]);
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
      if (ev.type === 'follow') return await reply([helpMessage()]);
      if (ev.type === 'message') {
        if (ev.message?.type !== 'text' || typeof ev.message.text !== 'string') return await reply([text('ส่งเป็นข้อความตัวอักษรนะครับ เช่น “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”')]);
        return await this.onText(userId, ev.message.text.slice(0, 1000), reply);
      }
      if (ev.type === 'postback' && ev.postback?.data) return await this.onPostback(userId, ev.postback.data, reply);
    } catch (e) {
      if (e instanceof AppError) return await reply([text(e.message)]);
      throw e;
    }
  }

  private async onText(userId: string, raw: string, reply: (m: LineMessage[]) => Promise<void>) {
    const t = raw.trim();
    const { store } = this.getCtx();
    if (GREETING.test(t)) return reply([helpMessage()]);
    if (STATUS.test(t)) {
      const s = await store.getLineSession(userId);
      const deal = s?.lastDealId ? await store.getDeal(s.lastDealId) : undefined;
      return reply([text(deal ? `ดีลล่าสุดของคุณ: ${STATUS_TH[deal.status] ?? deal.status}` : 'ยังไม่มีดีลครับ พิมพ์ผลผลิตของคุณมาได้เลย')]);
    }
    const r = parseListing(t);
    if (!r.ok) return reply([r.problems.length >= 3 ? helpMessage() : problemsMessage(r.problems)]);
    const prev = await store.getLineSession(userId);
    await store.putLineSession(userId, { draft: r.draft, ...(prev?.lastDealId ? { lastDealId: prev.lastDealId } : {}), updatedAt: this.now() });
    return reply([confirmMessage(r.draft, r.gradeAssumed)]);
  }

  private async onPostback(userId: string, data: string, reply: (m: LineMessage[]) => Promise<void>) {
    const pb = parsePostback(data);
    if (!pb) return;
    const ctx = this.getCtx();
    const { store } = ctx;

    if (pb.act === 'edit') {
      const prev = await store.getLineSession(userId);
      await store.putLineSession(userId, { ...(prev?.lastDealId ? { lastDealId: prev.lastDealId } : {}), updatedAt: this.now() });
      return reply([text('ได้ครับ พิมพ์ผลผลิตใหม่ได้เลย เช่น “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”')]);
    }

    if (pb.act === 'confirm') {
      const session = await store.getLineSession(userId);
      const draft = session?.draft;
      if (!draft) return reply([text('ไม่มีรายการรอยืนยันครับ พิมพ์ผลผลิตของคุณมาใหม่ได้เลย')]);
      // ล้างร่างก่อนเริ่ม กันกดยืนยันซ้ำแล้วเกิดสองดีล
      await store.putLineSession(userId, { ...(session.lastDealId ? { lastDealId: session.lastDealId } : {}), updatedAt: this.now() });
      try {
        const { id } = await startDeal(ctx, {}, { line: { userId, draft } });
        await store.putLineSession(userId, { lastDealId: id, updatedAt: this.now() });
      } catch (e) {
        await store.putLineSession(userId, { ...session, updatedAt: this.now() }); // ให้กดยืนยันซ้ำได้ (เช่น โควตาเต็ม)
        throw e;
      }
      return reply([startedMessage()]);
    }

    // อนุมัติ / ไม่เอา / ต่อรองใหม่ ต้องมี dealId และต้องเป็นดีลของผู้ใช้คนนี้เท่านั้น
    if (!pb.dealId) return;
    const deal = await store.getDeal(pb.dealId);
    if (!deal || deal.lineUserId !== userId || !deal.lineFarmerId) return reply([text('ไม่พบดีลนี้ในรายการของคุณครับ')]);
    const farmerId = deal.lineFarmerId;

    if (pb.act === 'renegotiate') {
      const { id } = await renegotiate(ctx, pb.dealId, userId);
      await store.putLineSession(userId, { lastDealId: id, updatedAt: this.now() });
      return reply([text('ได้ครับ น้องมะระเริ่มเจรจาใหม่ให้แล้ว 🔁 ใช้เวลาประมาณ 1–2 นาที ผมจะส่งผลให้ดูอีกครั้ง')]);
    }

    if (deal.status !== 'pending_approval') return reply([text(`ดีลนี้${STATUS_TH[deal.status] ?? deal.status}แล้ว กดอนุมัติหรือไม่เอาอีกไม่ได้ครับ`)]);
    const decided = deal.approvals[farmerId];
    if (decided) return reply([text(`คุณตอบดีลนี้ไปแล้ว (${decided === 'approve' ? 'อนุมัติ' : 'ไม่เอา'}) ครับ`)]);

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
