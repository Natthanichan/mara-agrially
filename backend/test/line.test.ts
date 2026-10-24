import { readFileSync } from 'node:fs';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { RuleBasedMockLlm } from '../src/agent/llm/mock.js';
import { runDeal, type AppContext } from '../src/app/service.js';
import { handleHttp } from '../src/aws/http.js';
import { MockBuyerApi } from '../src/buyer/mockBuyer.js';
import { Ledger } from '../src/core/ledger.js';
import { KNOWLEDGE_FILES } from '../src/generated/knowledge.js';
import { LineBot } from '../src/line/bot.js';
import { LineApiError, LineClient, type LineMessage } from '../src/line/client.js';
import { parsePostback, postbackData } from '../src/line/flex.js';
import { parseListing } from '../src/line/parse.js';
import { secretsLoader } from '../src/line/secrets.js';
import { signLineBody, verifyLineSignature } from '../src/line/signature.js';
import { summarize } from '../src/market/nabcClient.js';
import { chunkFiles } from '../src/rag/chunker.js';
import { KnowledgeIndex } from '../src/rag/search.js';
import { MemoryDealStore } from '../src/store/memory.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/nabc-2026-10-19.json', import.meta.url), 'utf8'));
const knowledge = new KnowledgeIndex(chunkFiles(KNOWLEDGE_FILES));
const SECRET = 'test-channel-secret';
const TOKEN = 'test-access-token';

describe('อ่านข้อความผลผลิตจาก LINE', () => {
  it('ข้อความปกติ: พืช ปริมาณ เกรด ราคาขั้นต่ำ', () => {
    expect(parseListing('ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.')).toMatchObject({ ok: true, gradeAssumed: false, draft: { crop: 'rice_hommali', quantityKg: 12_000, grade: 'A', floorPricePerKg: 17 } });
    expect(parseListing('มะระจีน 1,800 กก. ไม่ต่ำกว่า 18.5 บาท')).toMatchObject({ ok: true, draft: { crop: 'bitter_gourd', quantityKg: 1800, floorPricePerKg: 18.5, grade: 'A' }, gradeAssumed: true });
    expect(parseListing('มันสำปะหลัง 25 ตัน เกรดบี ราคา 3.7')).toMatchObject({ ok: true, draft: { crop: 'cassava', quantityKg: 25_000, grade: 'B', floorPricePerKg: 3.7 } });
  });

  it('เลขไทย และเลขปริมาณไม่ถูกอ่านเป็นราคา', () => {
    expect(parseListing('ข้าว ๑๒ ตัน ขั้นต่ำ ๑๗.๕ บาท/กก.')).toMatchObject({ ok: true, draft: { quantityKg: 12_000, floorPricePerKg: 17.5 } });
    // "ขั้นต่ำ 10 ตัน" คือปริมาณ ไม่ใช่ราคา → ต้องถามราคา
    const r = parseListing('ข้าวหอมมะลิ 10 ตัน ขั้นต่ำ 10 ตัน');
    expect(r.ok).toBe(false);
  });

  it('ข้อมูลไม่ครบ/ผิดปกติ → บอกว่าขาดอะไร ไม่เดา', () => {
    const missing = parseListing('ข้าวหอมมะลิ 12 ตัน');
    expect(missing).toMatchObject({ ok: false });
    expect(!missing.ok && missing.problems.join(' ')).toContain('ราคาสุทธิขั้นต่ำ');
    expect(parseListing('สวัสดี')).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String)]) });
    expect(parseListing('ข้าว 12 ตัน ขั้นต่ำ 0 บาท').ok).toBe(false); // ราคา 0
    expect(parseListing('ข้าว 5 กก. ขั้นต่ำ 17 บาท').ok).toBe(false); // น้อยเกินไป
    expect(parseListing('ข้าว มะระ 12 ตัน ขั้นต่ำ 17 บาท').ok).toBe(false); // หลายพืช
  });
});

describe('ตรวจลายเซ็น LINE', () => {
  const body = '{"destination":"U1","events":[]}';
  it('ลายเซ็นถูกต้องผ่าน ผิด/ว่าง/ถูกแก้ body ไม่ผ่าน', () => {
    const sig = signLineBody(body, SECRET);
    expect(verifyLineSignature(body, sig, SECRET)).toBe(true);
    expect(verifyLineSignature(body + ' ', sig, SECRET)).toBe(false);
    expect(verifyLineSignature(body, signLineBody(body, 'other'), SECRET)).toBe(false);
    expect(verifyLineSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyLineSignature(body, '', SECRET)).toBe(false);
    expect(verifyLineSignature(body, 'not-base64!!', SECRET)).toBe(false);
    expect(verifyLineSignature(body, sig, '')).toBe(false);
  });
});

describe('postback data', () => {
  it('สร้างและอ่านกลับได้ ข้อมูลแปลกปลอมถูกปฏิเสธ', () => {
    expect(parsePostback(postbackData('approve', 'deal-1'))).toEqual({ act: 'approve', dealId: 'deal-1' });
    expect(parsePostback(postbackData('confirm'))).toEqual({ act: 'confirm' });
    expect(parsePostback('act=drop_table&d=x')).toBeUndefined();
    expect(parsePostback('')).toBeUndefined();
  });
});

describe('LINE client / secrets', () => {
  it('ส่ง Bearer token และไม่ใส่ token ใน error', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const ok = new LineClient(TOKEN, async (url, init) => (calls.push({ url, headers: init.headers, body: init.body }), { ok: true, status: 200, text: async () => '' }));
    await ok.push('U1', [{ type: 'text', text: 'hi' }]);
    expect(calls[0]).toMatchObject({ url: 'https://api.line.me/v2/bot/message/push', headers: { authorization: `Bearer ${TOKEN}` } });

    const bad = new LineClient(TOKEN, async () => ({ ok: false, status: 401, text: async () => 'Authentication failed' }));
    const err = await bad.reply('rt', []).catch((e) => e);
    expect(err).toBeInstanceOf(LineApiError);
    expect(err.message).not.toContain(TOKEN);
  });

  it('อ่านจาก SSM ด้วย WithDecryption และแคชไว้ ถ้าขาดค่าก็ error บอกชื่อที่ขาด', async () => {
    const send = vi.fn(async () => ({ Parameters: [{ Name: '/mara-agrially/line/channel-secret', Value: SECRET }, { Name: '/mara-agrially/line/channel-access-token', Value: TOKEN }] }));
    const load = secretsLoader({}, { send } as never);
    expect(await load()).toEqual({ channelSecret: SECRET, channelAccessToken: TOKEN });
    await load();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((send.mock.calls[0] as unknown[])[0])).toContain('"WithDecryption":true');

    const missing = secretsLoader({}, { send: async () => ({ Parameters: [{ Name: '/mara-agrially/line/channel-secret', Value: SECRET }] }) } as never);
    await expect(missing()).rejects.toThrow('channel-access-token');
    expect(await secretsLoader({ LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't' }, { send } as never)()).toEqual({ channelSecret: 's', channelAccessToken: 't' });
  });
});

// ---------- ทั้ง flow ผ่าน webhook (ที่เก็บข้อมูลใน memory, LLM จำลอง, LINE client ปลอม) ----------

type Sent = { kind: 'reply' | 'push'; to: string; messages: LineMessage[] };

function setup(opts: { dailyLimit?: number } = {}) {
  const store = new MemoryDealStore();
  const sent: Sent[] = [];
  const client = {
    reply: async (to: string, messages: LineMessage[]) => void sent.push({ kind: 'reply', to, messages }),
    push: async (to: string, messages: LineMessage[]) => void sent.push({ kind: 'push', to, messages }),
  };
  let n = 0;
  const ctx: AppContext = {
    store,
    dailyLimit: opts.dailyLimit ?? 20,
    newId: () => `deal-${++n}`,
    now: () => new Date('2026-10-19T03:00:00Z'),
    llm: () => new RuleBasedMockLlm(),
    agentDeps: () => ({ buyers: new MockBuyerApi(), knowledge, market: { getReference: async (c, d, p) => summarize(fixture.data, c, d, false, p) } }),
    invokeWorker: async (id) => {
      await runDeal(ctx, id);
    },
    line: new LineBot(() => ctx, async () => ({ channelSecret: SECRET, channelAccessToken: TOKEN }), () => client),
  };
  let e = 0;
  const post = async (events: unknown[]) => {
    const raw = JSON.stringify({ destination: 'Ubot', events: events.map((x) => ({ webhookEventId: `ev-${++e}`, mode: 'active', source: { type: 'user', userId: 'U-farmer' }, replyToken: `rt-${e}`, ...(x as object) })) });
    return ctx.line!.handleWebhook(raw, signLineBody(raw, SECRET));
  };
  const say = (t: string, userId = 'U-farmer') => post([{ type: 'message', source: { type: 'user', userId }, message: { type: 'text', text: t } }]);
  const tap = (data: string, userId = 'U-farmer') => post([{ type: 'postback', source: { type: 'user', userId }, postback: { data } }]);
  const last = () => sent.at(-1)!;
  return { ctx, store, sent, post, say, tap, last };
}

const asText = (m: LineMessage) => JSON.stringify(m);
const buttons = (m: LineMessage): { label: string; data: string }[] => {
  const footer = ((m.contents as { footer?: { contents?: { action?: { label: string; data: string } }[] } })?.footer?.contents ?? []).flatMap((b) => (b.action ? [b.action] : []));
  return footer.map((a) => ({ label: a.label, data: a.data }));
};
const ROOF = 'ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 16.8 บาท/กก.';

describe('บทสนทนา LINE ตั้งแต่พิมพ์ผลผลิตถึงอนุมัติ', () => {
  it('ลายเซ็นผิด → 401 ไม่ทำอะไร, Verify (events ว่าง) → 200', async () => {
    const { ctx, sent, store } = setup();
    const raw = JSON.stringify({ events: [{ type: 'message', replyToken: 'rt', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: ROOF } }] });
    expect((await ctx.line!.handleWebhook(raw, 'bad-signature')).status).toBe(401);
    expect((await ctx.line!.handleWebhook(raw, undefined)).status).toBe(401);
    expect(sent).toHaveLength(0);
    expect(store.deals.size).toBe(0);
    const empty = JSON.stringify({ destination: 'U', events: [] });
    expect((await ctx.line!.handleWebhook(empty, signLineBody(empty, SECRET))).status).toBe(200);
  });

  it('ยังไม่ตั้งค่า secret → 503 (ไม่ล้มทั้งระบบ)', async () => {
    const bot = new LineBot(() => ({}) as AppContext, async () => { throw new Error('missing'); });
    expect(await bot.handleWebhook('{}', 'x')).toMatchObject({ status: 503 });
  });

  it('follow/ทักทาย → เลือกบทบาท, เกษตรกรข้อมูลไม่ครบ → ถามเพิ่ม', async () => {
    const { post, say, tap, last } = setup();
    await post([{ type: 'follow' }]);
    expect(buttons(last().messages[0]!).map((b) => b.label)).toEqual(['ฉันเป็นเกษตรกร', 'ฉันเป็นผู้ซื้อ']);
    await tap(postbackData('role_farmer'));
    expect(buttons(last().messages[0]!).map((b) => b.label)).toEqual(['มีรหัสกลุ่ม', 'สร้างกลุ่มใหม่', 'ให้น้องมะระหากลุ่มให้']);
    await tap(postbackData('group_auto'));
    expect(asText(last().messages[0]!)).toContain('ขั้นต่ำ');
    await say('ข้าวหอมมะลิ 12 ตัน');
    expect(asText(last().messages[0]!)).toContain('ราคาสุทธิขั้นต่ำ');
    await say('สวัสดี');
    expect(buttons(last().messages[0]!).map((b) => b.label)).toContain('ฉันเป็นผู้ซื้อ');
  });

  it('พิมพ์ผลผลิต → ปุ่มยืนยัน → เจรจา → push ผลครั้งเดียวพร้อม 3 ปุ่ม → อนุมัติ → ตกลงดีล', async () => {
    const { say, tap, sent, store, ctx, last } = setup();
    await say(ROOF);
    expect(last().kind).toBe('reply');
    expect(buttons(last().messages[0]!).map((b) => b.label)).toEqual(['ยืนยัน เริ่มเจรจา', 'แก้ไข']);
    expect(store.deals.size).toBe(0); // ยังไม่เริ่มจนกว่าจะกดยืนยัน

    await tap(postbackData('confirm'));
    expect(last().messages.map(asText).join(' ')).toContain('เริ่มเจรจา');
    expect(asText(last().messages[0]!)).toContain('รวมกับเพื่อนเกษตรกรอีก 3 คน'); // บอกกลุ่มที่ถูกรวม
    const pushes = sent.filter((s) => s.kind === 'push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.to).toBe('U-farmer');
    const offer = pushes[0]!.messages[0]!;
    expect(buttons(offer).map((b) => b.label)).toEqual(['อนุมัติ', 'ไม่เอา', 'ต่อรองใหม่']);
    expect(asText(offer)).toContain('จำลอง');

    const deal = (await store.getDeal('deal-1'))!;
    expect(deal).toMatchObject({ status: 'pending_approval', lineUserId: 'U-farmer', lineFarmerId: 'F01' });
    expect(deal.listingOverrides?.[0]).toMatchObject({ farmerId: 'F01', quantityKg: 12_000, floorPricePerKg: 16.8 });

    await tap(buttons(offer)[0]!.data);
    expect(asText(last().messages[0]!)).toContain('ตกลงครบทุกคน');
    const after = (await store.getDeal('deal-1'))!;
    expect(after).toMatchObject({ status: 'agreed', deliveryStatus: 'not_started', paymentStatus: 'not_due' });
    expect(Object.keys(after.approvals).sort()).toEqual(['F01', 'F02', 'F03', 'F04']);

    // ledger ยังต่อ hash chain ถูกต้อง และคนที่เป็นตัวจำลองถูกติดป้ายไว้
    const events = await store.listEvents('deal-1');
    expect(() => Ledger.from(events)).not.toThrow();
    const approvals = events.filter((e) => e.type === 'approval.approve');
    expect(approvals.find((e) => e.data.farmerId === 'F01')!.data.simulated).toBeUndefined();
    expect(approvals.filter((e) => e.data.simulated === true).map((e) => e.data.farmerId).sort()).toEqual(['F02', 'F03', 'F04']);
    void ctx;
  });

  it('กดยืนยันซ้ำ/ส่ง event ซ้ำ → ไม่เกิดสองดีล', async () => {
    const { say, tap, post, store, last } = setup();
    await say(ROOF);
    await tap(postbackData('confirm'));
    await tap(postbackData('confirm'));
    expect(asText(last().messages[0]!)).toContain('ไม่มีรายการรอยืนยัน');
    expect(store.deals.size).toBe(1);

    // LINE ส่ง webhookEventId เดิมซ้ำ
    const ev = { webhookEventId: 'dup-1', type: 'message', replyToken: 'r', source: { type: 'user', userId: 'U-farmer' }, message: { type: 'text', text: ROOF } };
    await post([ev]);
    const before = (await store.getLineSession('U-farmer'))?.updatedAt;
    await post([ev]);
    expect((await store.getLineSession('U-farmer'))?.updatedAt).toBe(before);
  });

  it('ไม่เอา → ถอนตัว กลุ่มที่เหลือ (จำลอง) ไปต่อได้', async () => {
    const { say, tap, sent, store, last } = setup();
    await say(ROOF);
    await tap(postbackData('confirm'));
    const reject = buttons(sent.find((s) => s.kind === 'push')!.messages[0]!)[1]!;
    await tap(reject.data);
    expect((await store.getDeal('deal-1'))!.approvals.F01).toBe('reject');
    expect(asText(last().messages[0]!)).toContain('ถอนตัว');
    const status = (await store.getDeal('deal-1'))!.status;
    expect(['agreed', 'pending_approval']).toContain(status);
    // ตอบซ้ำไม่ได้
    await tap(reject.data);
    expect(asText(last().messages[0]!)).toMatch(/แล้ว/);
  });

  it('ต่อรองใหม่ → ดีลเดิมถูกยกเลิก เริ่มดีลใหม่ ส่งผลใหม่อีกครั้ง', async () => {
    const { say, tap, sent, store } = setup();
    await say(ROOF);
    await tap(postbackData('confirm'));
    const renego = buttons(sent.find((s) => s.kind === 'push')!.messages[0]!)[2]!;
    await tap(renego.data);
    expect((await store.getDeal('deal-1'))!.status).toBe('cancelled');
    expect(await store.getDeal('deal-2')).toMatchObject({ round: 1, lineUserId: 'U-farmer' });
    expect(sent.filter((s) => s.kind === 'push')).toHaveLength(2);
    // ledger ของดีลเดิมบันทึกการต่อรองใหม่
    expect((await store.listEvents('deal-1')).some((e) => e.type === 'deal.renegotiation_requested')).toBe(true);
  });

  it('ต่อรองใหม่ได้ไม่เกิน 3 ครั้ง', async () => {
    const { say, tap, sent, last } = setup();
    await say(ROOF);
    await tap(postbackData('confirm'));
    for (let i = 0; i < 3; i++) {
      const latest = [...sent].reverse().find((s) => s.kind === 'push')!;
      await tap(buttons(latest.messages[0]!)[2]!.data);
    }
    const latest = [...sent].reverse().find((s) => s.kind === 'push')!;
    await tap(buttons(latest.messages[0]!)[2]!.data);
    expect(asText(last().messages[0]!)).toContain('ไม่เกิน 3 ครั้ง');
  });

  it('คนอื่นกดปุ่มของดีลคนอื่นไม่ได้', async () => {
    const { say, tap, sent, store, last } = setup();
    await say(ROOF);
    await tap(postbackData('confirm'));
    const approve = buttons(sent.find((s) => s.kind === 'push')!.messages[0]!)[0]!;
    await tap(approve.data, 'U-intruder');
    expect(asText(last().messages[0]!)).toContain('ไม่พบดีลนี้');
    expect((await store.getDeal('deal-1'))!.approvals).toEqual({});
    await tap(postbackData('approve', 'no-such-deal'));
    expect(asText(last().messages[0]!)).toContain('ไม่พบดีลนี้');
  });

  it('จัดกลุ่มไม่ได้ (เกรด B มะระไม่มีเพื่อน) → แจ้งตรงๆ ไม่หักโควตา และกดยืนยันใหม่ได้', async () => {
    const { say, tap, store, last } = setup();
    await say('มะระจีน 1.8 ตัน เกรด B ขั้นต่ำ 18 บาท/กก.');
    await tap(postbackData('confirm'));
    expect(asText(last().messages[0]!)).toContain('เกรด A');
    expect(store.deals.size).toBe(0);
    expect(store.counters.size).toBe(0);
    expect((await store.getLineSession('U-farmer'))?.draft).toBeDefined();
  });

  it('โควตาเต็ม → แจ้งผู้ใช้ และไม่สร้างดีล', async () => {
    const { say, tap, store, last } = setup({ dailyLimit: 0 });
    await say(ROOF);
    await tap(postbackData('confirm'));
    expect(asText(last().messages[0]!)).toContain('โควตา');
    expect(store.deals.size).toBe(0);
  });

  it('เจรจาไม่ได้ข้อสรุป (ราคาขั้นต่ำสูงเกินตลาด) → แจ้งเหตุผล ไม่มีดีล มีปุ่มลองใหม่', async () => {
    const { say, tap, sent, store } = setup();
    await say('ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 60 บาท/กก.');
    await tap(postbackData('confirm'));
    const deal = (await store.getDeal('deal-1'))!;
    expect(deal.status).toBe('failed');
    const msgs = sent.filter((s) => s.kind === 'push').flatMap((s) => s.messages);
    expect(msgs.map(asText).join(' ')).toContain('ไม่มีดีลใดถูกสร้าง');
    expect(msgs.flatMap(buttons).map((b) => b.label)).toContain('ต่อรองใหม่');
  });

  it('ผลที่ส่งให้เกษตรกรไม่เปิดเผยราคาขั้นต่ำของคนอื่นในกลุ่ม', async () => {
    const { say, tap, sent } = setup();
    await say(ROOF);
    await tap(postbackData('confirm'));
    const text = sent.filter((s) => s.kind === 'push').map((s) => asText(s.messages[0]!)).join(' ');
    for (const others of ['16.50', '17.00', '16.20', '15.50']) expect(text).not.toContain(`${others} บาท/กก. ✓`);
    expect(text).toContain('16.80 บาท/กก. ✓ ผ่าน'); // ของตัวเองเท่านั้น
  });

  it('สถานะ → บอกสถานะดีลล่าสุด', async () => {
    const { say, tap, last } = setup();
    await say('สถานะ');
    expect(asText(last().messages[0]!)).toContain('ยังไม่มีดีล');
    await say(ROOF);
    await tap(postbackData('confirm'));
    await say('สถานะ');
    expect(asText(last().messages[0]!)).toContain('รอคุณอนุมัติ');
  });

  it('ข้อความที่ไม่ใช่ตัวอักษร และแชตกลุ่ม ไม่ทำให้พัง', async () => {
    const { post, sent, last } = setup();
    await post([{ type: 'message', message: { type: 'image' } }]);
    expect(asText(last().messages[0]!)).toContain('ข้อความตัวอักษร');
    const before = sent.length;
    await post([{ type: 'message', source: { type: 'group', groupId: 'G1' }, message: { type: 'text', text: ROOF } }]);
    expect(sent.length).toBe(before);
  });
});

describe('HTTP: /line/webhook', () => {
  const evt = (body: string, headers: Record<string, string>, path = '/line/webhook') =>
    ({ rawPath: path, headers, requestContext: { http: { method: 'POST' } }, body, isBase64Encoded: false }) as unknown as APIGatewayProxyEventV2;

  it('ตรวจลายเซ็นจาก header (ตัวพิมพ์เล็ก) ทั้งสอง path', async () => {
    const { ctx } = setup();
    const raw = JSON.stringify({ destination: 'U', events: [] });
    for (const path of ['/line/webhook', '/api/line/webhook']) {
      expect((await handleHttp(ctx, evt(raw, { 'x-line-signature': signLineBody(raw, SECRET) }, path))).statusCode).toBe(200);
    }
    expect((await handleHttp(ctx, evt(raw, { 'x-line-signature': 'nope' }))).statusCode).toBe(401);
    expect((await handleHttp(ctx, evt(raw, {}))).statusCode).toBe(401);
  });

  it('body ที่ถูก base64 โดย API Gateway ก็ตรวจลายเซ็นกับ body ดิบได้', async () => {
    const { ctx } = setup();
    const raw = JSON.stringify({ destination: 'U', events: [] });
    const e = { rawPath: '/line/webhook', headers: { 'x-line-signature': signLineBody(raw, SECRET) }, requestContext: { http: { method: 'POST' } }, body: Buffer.from(raw).toString('base64'), isBase64Encoded: true };
    expect((await handleHttp(ctx, e as unknown as APIGatewayProxyEventV2)).statusCode).toBe(200);
  });

  it('ไม่ได้ตั้ง LINE → 503', async () => {
    const { ctx } = setup();
    delete ctx.line;
    expect((await handleHttp(ctx, evt('{}', {}))).statusCode).toBe(503);
  });
});

describe('ฝั่งผู้ซื้อ (คนจริงใน LINE): บอทถามทีละข้อ แล้วบันทึกคำขอซื้อ', () => {
  const flow = async (h: ReturnType<typeof setup>, opts: { crop?: string } = {}) => {
    await h.tap(postbackData('role_buyer'));
    await h.tap(postbackData('buyer_crop', undefined, (opts.crop ?? 'rice_hommali') as never));
    await h.say('10 ตัน');
    await h.say('โรงสี ต.บางพลี จ.สมุทรปราการ');
    await h.say('18.5');
  };

  it('กดปุ่มผู้ซื้อ → ถามพืช (ปุ่ม 3 ชนิด) → จำนวน → สถานที่ → ราคา → สรุปให้ยืนยัน → บันทึก', async () => {
    const h = setup();
    await h.tap(postbackData('role_buyer'));
    expect(buttons(h.last().messages[0]!)).toHaveLength(3);
    await h.tap(postbackData('buyer_crop', undefined, 'rice_hommali'));
    expect(asText(h.last().messages[0]!)).toContain('เท่าไหร่');
    await h.say('10 ตัน');
    expect(asText(h.last().messages[0]!)).toContain('ส่งมอบที่ไหน');
    await h.say('โรงสี ต.บางพลี จ.สมุทรปราการ');
    expect(asText(h.last().messages[0]!)).toContain('กี่บาท');
    await h.say('18.5');
    const confirm = h.last().messages[0]!;
    expect(buttons(confirm).map((b) => b.label)).toEqual(['ยืนยันคำขอซื้อ', 'แก้ไข']);
    expect(asText(confirm)).toContain('ข้าวเปลือกหอมมะลิ');
    expect(asText(confirm)).toContain('18.50');
    expect(h.store.buyerRequests).toHaveLength(0); // ยังไม่บันทึกจนกว่าจะกดยืนยัน

    await h.tap(postbackData('buyer_confirm'));
    expect(h.store.buyerRequests).toHaveLength(1);
    expect(h.store.buyerRequests[0]).toMatchObject({ userId: 'U-farmer', crop: 'rice_hommali', quantityKg: 10_000, location: 'โรงสี ต.บางพลี จ.สมุทรปราการ', offerPerKg: 18.5, status: 'open' });
    const saved = h.last().messages.map(asText).join(' ');
    expect(saved).toContain('บันทึกคำขอซื้อแล้ว');
    // การ์ดกลุ่มเกษตรกรที่ตรงกับคำขอ: ข้าว เกรด A ร้อยเอ็ด 4 คน 41.5 ตัน พอสำหรับ 10 ตัน
    const carousel = h.last().messages[1]!;
    expect((carousel.contents as { type: string }).type).toBe('carousel');
    expect(saved).toContain('ร้อยเอ็ด');
    expect(saved).toContain('4 คน');
    expect(saved).toContain('41.5 ตัน');
    expect(saved).toContain('พอสำหรับ 10 ตัน');
    expect(saved).toContain('แจ้งเตือน');
    expect(saved).toContain('สนใจ เจรจากับกลุ่มนี้'); // การ์ดกลุ่มมีปุ่มเริ่มเจรจา
    // ไม่มีชื่อเกษตรกรหรือราคาขั้นต่ำหลุดไปถึงผู้ซื้อ
    for (const floor of ['16.80', '16.50', '17.00', '16.20', '15.50']) expect(saved).not.toContain(floor);
    expect(saved).not.toContain('สมศรี');
    expect((await h.store.getLineSession('U-farmer'))?.buyerDraft).toBeUndefined();
  });

  it('พิมพ์ชื่อพืชแทนการกดปุ่มได้ และคำตอบผิดรูปแบบจะถูกถามซ้ำโดยไม่ข้ามขั้น', async () => {
    const h = setup();
    await h.tap(postbackData('role_buyer'));
    await h.say('ทุเรียน');
    expect(asText(h.last().messages[0]!)).toContain('ยังไม่ทราบ');
    await h.say('มะระจีน');
    expect(asText(h.last().messages[0]!)).toContain('มะระจีน');
    await h.say('5'); // ไม่มีหน่วยและน้อยเกินไป
    expect(asText(h.last().messages[0]!)).toContain('ระบุหน่วย');
    await h.say('2 ตัน');
    await h.say('x');
    expect(asText(h.last().messages[0]!)).toContain('ขอสถานที่');
    await h.say('ตลาดไท จ.ปทุมธานี');
    await h.say('ฟรี');
    expect(asText(h.last().messages[0]!)).toContain('ตัวเลขราคา');
    await h.say('0');
    expect(asText(h.last().messages[0]!)).toContain('ระหว่าง');
    await h.say('ราคา 22 บาท/กก.');
    expect(buttons(h.last().messages[0]!).map((b) => b.label)).toContain('ยืนยันคำขอซื้อ');
  });

  it('กดยืนยันซ้ำไม่บันทึกซ้ำ · แก้ไขเริ่มถามใหม่ · ยกเลิกล้างร่าง', async () => {
    const h = setup();
    await flow(h);
    await h.tap(postbackData('buyer_confirm'));
    await h.tap(postbackData('buyer_confirm'));
    expect(h.store.buyerRequests).toHaveLength(1);
    expect(asText(h.last().messages[0]!)).toContain('ไม่มีคำขอซื้อที่รอยืนยัน');

    await flow(h, { crop: 'cassava' });
    await h.tap(postbackData('buyer_edit'));
    expect(buttons(h.last().messages[0]!)).toHaveLength(3);
    await h.say('ยกเลิก');
    expect((await h.store.getLineSession('U-farmer'))?.buyerDraft).toBeUndefined();
    expect(h.store.buyerRequests).toHaveLength(1);
  });

  it('คำขอของฉัน แสดงเฉพาะของตัวเอง · ผู้ใช้คนละคนไม่ปนกัน', async () => {
    const h = setup();
    await flow(h);
    await h.tap(postbackData('buyer_confirm'));
    await h.say('คำขอของฉัน');
    expect(asText(h.last().messages[0]!)).toContain('ส่งที่ โรงสี ต.บางพลี');
    await h.say('อะไรก็ได้', 'U-other'); // ผู้ใช้ใหม่ที่ยังไม่เลือกบทบาท → ให้เลือกบทบาทก่อน
    expect(buttons(h.last().messages[0]!).map((b) => b.label)).toEqual(['ฉันเป็นเกษตรกร', 'ฉันเป็นผู้ซื้อ']);
    await h.tap(postbackData('role_buyer'), 'U-other');
    await h.say('คำขอของฉัน', 'U-other');
    expect(asText(h.last().messages[0]!)).toContain('ยังไม่มีคำขอซื้อ');
  });

  it('เปลี่ยนบทบาทด้วย "เมนู" และบทบาทไม่หายตอนเกษตรกรใช้งานต่อ', async () => {
    const h = setup();
    await h.tap(postbackData('role_farmer'));
    await h.say(ROOF);
    await h.tap(postbackData('confirm'));
    expect((await h.store.getLineSession('U-farmer'))?.role).toBe('farmer');
    expect(h.store.deals.size).toBe(1);

    await h.say('เมนู');
    expect((await h.store.getLineSession('U-farmer'))?.role).toBeUndefined();
    await h.tap(postbackData('role_buyer'));
    // ผู้ซื้อพิมพ์ข้อความผลผลิตแบบเกษตรกรไม่ได้สร้างดีล
    await h.say(ROOF);
    expect(h.store.deals.size).toBe(1);
  });

  it('น้องมะระเป็นผู้หญิง: ข้อความของบอททุกแบบไม่มี "ครับ" หรือ "ผม"', async () => {
    const h = setup();
    await h.post([{ type: 'follow' }]);
    await h.tap(postbackData('role_farmer'));
    await h.say('ข้าวหอมมะลิ 12 ตัน');
    await h.say(ROOF);
    await h.tap(postbackData('confirm'));
    await h.tap(postbackData('confirm'));
    await h.tap(postbackData('edit'));
    await h.say('สถานะ');
    await h.tap(postbackData('role_buyer'));
    await h.say('ทุเรียน');
    await flow(h);
    await h.tap(postbackData('buyer_confirm'));
    await h.say('คำขอของฉัน');
    await h.post([{ type: 'message', message: { type: 'image' } }]);
    const all = h.sent.flatMap((m) => m.messages.map(asText)).join(' ');
    expect(all.length).toBeGreaterThan(2000);
    expect(all).not.toMatch(/ครับ|ผม(?!ลิต|ลไม้)/);
    expect(all).toContain('ค่ะ');
  });
});

describe('กลุ่มเพื่อนเกษตรกร: ใส่รหัส / สร้างกลุ่ม / ให้น้องมะระหาให้', () => {
  const allText = (m: { messages: LineMessage[] }) => m.messages.map(asText).join(' ');

  it('รหัสจำลอง 12345 (และ 1234) → เข้ากลุ่มข้าว ร้อยเอ็ด แล้วเจรจาต่อได้ และสรุปบอกรหัสกลุ่ม', async () => {
    for (const code of ['12345', '1234']) {
      const h = setup();
      await h.tap(postbackData('role_farmer'));
      await h.tap(postbackData('group_join'));
      expect(asText(h.last().messages[0]!)).toContain('รหัสกลุ่ม');
      await h.say(code);
      const joined = asText(h.last().messages[0]!);
      expect(joined).toContain(`รหัส ${code}`);
      expect(joined).toContain('ร้อยเอ็ด');
      expect(joined).toContain('สมาชิก 4 คน');
      await h.say(ROOF);
      await h.tap(postbackData('confirm'));
      expect(allText(h.last())).toContain(`กลุ่มรหัส ${code}`);
      expect((await h.store.getDeal('deal-1'))!.status).toBe('pending_approval');
    }
  });

  it('รหัสผิดรูปแบบหรือไม่มีอยู่ → บอกและรอรหัสใหม่ · พิมพ์ "ยกเลิก" ออกได้', async () => {
    const h = setup();
    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_join'));
    await h.say('abc');
    expect(asText(h.last().messages[0]!)).toContain('4–6 หลัก');
    await h.say('99999');
    expect(asText(h.last().messages[0]!)).toContain('ไม่พบกลุ่ม');
    expect((await h.store.getLineSession('U-farmer'))?.awaiting).toBe('group_code');
    await h.say('ยกเลิก');
    expect((await h.store.getLineSession('U-farmer'))?.awaiting).toBeUndefined();
  });

  it('กลุ่มจำลองเป็นกลุ่มข้าว: พิมพ์มะระ → แนะนำให้หากลุ่มใหม่ ไม่เริ่มดีลผิดกลุ่ม', async () => {
    const h = setup();
    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_join'));
    await h.say('12345');
    await h.say('มะระจีน 1.8 ตัน ขั้นต่ำ 18 บาท/กก.');
    expect(asText(h.last().messages[0]!)).toContain('เป็นกลุ่มข้าวเปลือกหอมมะลิ');
    expect((await h.store.getLineSession('U-farmer'))?.draft).toBeUndefined();
  });

  it('สร้างกลุ่ม → ตั้งชื่อ → ได้รหัส 5 หลัก → เพื่อนใส่รหัสนั้นแล้วเข้ากลุ่มเดียวกัน (สมาชิก 2 คน)', async () => {
    const h = setup();
    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_create'));
    expect(asText(h.last().messages[0]!)).toContain('ตั้งชื่อกลุ่ม');
    await h.say('ก');
    expect(asText(h.last().messages[0]!)).toContain('2–40');
    await h.say('กลุ่มข้าวหอมบ้านโนนสูง');
    const created = allText(h.last());
    const code = /รหัสกลุ่ม: (\d{5})/.exec(created)?.[1];
    expect(code).toBeDefined();
    expect(['12345', '1234']).not.toContain(code);
    expect(created).toContain('ต้นแบบ'); // บอกตรงๆ ว่าการเจรจายังใช้กลุ่มจำลอง
    expect(h.store.groups.get(code!)).toMatchObject({ name: 'กลุ่มข้าวหอมบ้านโนนสูง', ownerUserId: 'U-farmer', members: ['U-farmer'] });

    await h.tap(postbackData('role_farmer'), 'U-friend');
    await h.tap(postbackData('group_join'), 'U-friend');
    await h.say(code!, 'U-friend');
    expect(asText(h.last().messages[0]!)).toContain('สมาชิก 2 คน');
    expect(h.store.groups.get(code!)!.members).toEqual(['U-farmer', 'U-friend']);

    // เจ้าของกลุ่มเจรจาต่อได้ตามปกติ และสรุปบอกชื่อกลุ่ม
    await h.say(ROOF);
    await h.tap(postbackData('confirm'));
    expect(allText(h.last())).toContain('กลุ่ม “กลุ่มข้าวหอมบ้านโนนสูง”');
  });
});

describe('DynamoDB: กลุ่มเพื่อนเกษตรกร', () => {
  it('สร้างแบบมีเงื่อนไข (รหัสซ้ำ → false) และเข้ากลุ่มด้วย ADD string set', async () => {
    const { DynamoDealStore } = await import('../src/store/dynamo.js');
    const sent: Record<string, any>[] = [];
    let exists = false;
    const db = {
      send: async (cmd: { input: Record<string, any> }) => {
        sent.push(cmd.input);
        if (cmd.input.ConditionExpression === 'attribute_not_exists(pk)' && exists) throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
        if (cmd.input.UpdateExpression) return { Attributes: { pk: 'FGROUP#55555', sk: 'META', code: '55555', name: 'ก', ownerUserId: 'U1', createdAt: 't', members: new Set(['U1', 'U2']) } };
        return {};
      },
    };
    const store = new DynamoDealStore(db as never, 'T');
    expect(await store.createFarmerGroup({ code: '55555', name: 'ก', ownerUserId: 'U1', members: ['U1'], createdAt: 't' })).toBe(true);
    expect(sent[0]!.Item.members).toEqual(new Set(['U1']));
    exists = true;
    expect(await store.createFarmerGroup({ code: '55555', name: 'ข', ownerUserId: 'U9', members: ['U9'], createdAt: 't' })).toBe(false);
    const g = await store.joinFarmerGroup('55555', 'U2');
    expect(sent.at(-1)!.UpdateExpression).toBe('ADD members :u');
    expect(g).toMatchObject({ code: '55555', members: ['U1', 'U2'] });
  });
});

describe('แจ้งเตือนผู้ซื้อเมื่อมีกลุ่มเกษตรกรที่ตรงกับคำขอ', () => {
  const register = async (h: ReturnType<typeof setup>, userId: string, crop: string, location: string) => {
    await h.tap(postbackData('role_buyer'), userId);
    await h.tap(postbackData('buyer_crop', undefined, crop as never), userId);
    await h.say('10 ตัน', userId);
    await h.say(location, userId);
    await h.say('18.5', userId);
    await h.tap(postbackData('buyer_confirm'), userId);
  };

  it('ผู้ซื้อลงทะเบียนข้าว → เกษตรกรใน LINE เริ่มดีลข้าว → ผู้ซื้อได้ push การ์ดกลุ่ม (ไม่มีขั้นต่ำ/ชื่อ) · ผู้ซื้อมันสำปะหลังไม่ได้', async () => {
    const h = setup();
    await register(h, 'U-mill', 'rice_hommali', 'โรงสี อ.เมือง จ.ร้อยเอ็ด');
    await register(h, 'U-cassava', 'cassava', 'ลานมัน จ.นครราชสีมา');
    const before = h.sent.length;

    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_join'));
    await h.say('12345');
    await h.say(ROOF);
    await h.tap(postbackData('confirm'));

    const alerts = h.sent.slice(before).filter((m) => m.kind === 'push' && m.to !== 'U-farmer');
    expect(alerts.map((a) => a.to)).toEqual(['U-mill']);
    const card = asText(alerts[0]!.messages[0]!);
    expect(card).toContain('มีกลุ่มเกษตรกรใหม่');
    expect(card).toContain('ร้อยเอ็ด (จังหวัดเดียวกับที่ส่งมอบ)');
    expect(card).toContain('41.5 ตัน');
    expect(card).toContain('18.50');
    expect(card).not.toContain('16.80');
    expect(card).not.toContain('สมศรี');
  });

  it('ผู้ซื้อคนเดียวมีหลายคำขอ ได้แจ้งครั้งเดียว · เกษตรกรไม่ถูกแจ้งเตือนตัวเอง · แจ้งไม่เกิน 5 คน', async () => {
    const h = setup();
    await register(h, 'U-mill', 'rice_hommali', 'ร้อยเอ็ด');
    await register(h, 'U-mill', 'rice_hommali', 'ร้อยเอ็ด');
    await register(h, 'U-farmer', 'rice_hommali', 'ร้อยเอ็ด'); // คนเดียวกับเกษตรกร
    for (let i = 0; i < 7; i++) await register(h, `U-b${i}`, 'rice_hommali', 'กรุงเทพ');
    const before = h.sent.length;
    await h.say('เมนู');
    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_auto'));
    await h.say(ROOF);
    await h.tap(postbackData('confirm'));
    const alerted = h.sent.slice(before).filter((m) => m.kind === 'push' && JSON.stringify(m.messages).includes('มีกลุ่มเกษตรกรใหม่')).map((m) => m.to);
    expect(alerted).toHaveLength(5);
    expect(new Set(alerted).size).toBe(5);
    expect(alerted).not.toContain('U-farmer');
  });

  it('push ไปผู้ซื้อล้มเหลว → เกษตรกรยังได้ข้อความเริ่มเจรจาและผลตามปกติ', async () => {
    const h = setup();
    await register(h, 'U-mill', 'rice_hommali', 'ร้อยเอ็ด');
    const bot = h.ctx.line as unknown as { makeClient: (t: string) => { reply: unknown; push: (to: string, m: LineMessage[]) => Promise<void> } };
    const orig = bot.makeClient;
    bot.makeClient = (t) => {
      const c = orig(t);
      return { ...c, push: async (to, m) => { if (to === 'U-mill') throw new Error('quota'); return c.push(to, m); } };
    };
    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_auto'));
    await h.say(ROOF);
    await h.tap(postbackData('confirm'));
    expect(h.sent.some((m) => m.kind === 'push' && m.to === 'U-farmer')).toBe(true);
    const deal = [...h.store.deals.values()].find((d) => d.lineUserId === 'U-farmer');
    expect(deal?.status).toBe('pending_approval');
  });

  it('ยังไม่มีกลุ่มของพืชนั้น → บอกว่าจะแจ้งเตือนเมื่อมี', async () => {
    const { buyerMatchesMessages } = await import('../src/line/flex.js');
    const msgs = buyerMatchesMessages({ crop: 'cassava', quantityKg: 1000, offerPerKg: 4, location: 'x' }, []);
    expect(msgs.map(asText).join(' ')).toContain('จะแจ้งเตือนคุณทันที');
  });
});

// ---------- แชตอัจฉริยะ (LLM จำลองแบบสคริปต์) ----------
describe('แชตกับน้องมะระใน LINE (AI)', () => {
  type Step = (req: { system: string; messages: { role: string; content: unknown[] }[] }) => unknown[];
  const scriptedChat = (steps: Step[]) => {
    const seen: { system: string; messages: { role: string; content: unknown[] }[] }[] = [];
    let i = 0;
    return {
      seen,
      llm: { name: 'scripted-chat', converse: async (req: any) => (seen.push(req), { content: steps[Math.min(i++, steps.length - 1)]!(req) as any }) },
    };
  };
  const tool = (name: string, input: Record<string, unknown>) => ({ toolUse: { toolUseId: 't1', name, input } });
  const withChat = (steps: Step[], opts: { limit?: number } = {}) => {
    const h = setup();
    const c = scriptedChat(steps);
    h.ctx.chatLlm = () => c.llm as never;
    h.ctx.chatDailyLimit = opts.limit ?? 50;
    return { ...h, ...c };
  };
  const startDealAsFarmer = async (h: ReturnType<typeof setup>) => {
    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_join'));
    await h.say('12345');
    await h.say(ROOF); // พิมพ์ครบ → ไม่เรียก AI
    await h.tap(postbackData('confirm'));
  };

  it('เกษตรกรถาม "ทำไมได้ราคานี้" → AI ได้บริบทดีล (ข้อเสนอ, แต่ละรอบ) และตอบด้วยตัวเลขจากบริบท', async () => {
    let price = '';
    const h = withChat([
      (req) => {
        price = /"pricePerKg":([\d.]+)/.exec(req.system)![1]!;
        const net = /"netPerKg":([\d.]+)/.exec(req.system)![1]!;
        return [{ text: `น้องมะระต่อรองกับโรงสีจำลอง C จนได้ ${price} บาท/กก. คุณได้สุทธิ ${net} บาท/กก. ค่ะ` }];
      },
    ]);
    await startDealAsFarmer(h);
    expect(h.seen).toHaveLength(0); // พิมพ์ผลผลิตครบ ไม่เรียก AI
    await h.say('ทำไมได้ราคานี้');
    expect(asText(h.last().messages[0]!)).toContain(`ได้ ${price} บาท`);
    const sys = h.seen[0]!.system;
    expect(sys).toContain('"rounds"');
    expect(sys).toContain('โรงสีจำลอง C');
    expect(sys).toContain('"floorPerKg":16.8'); // ขั้นต่ำของตัวเองอยู่ในบริบทได้
    for (const other of ['บุญมา', 'คำปุน', 'ประยูร']) expect(sys).not.toContain(other); // ไม่มีชื่อ/ข้อมูลสมาชิกคนอื่น
    expect((await h.store.getLineSession('U-farmer'))?.chat?.length).toBe(2);
  });

  it('คำตอบมีตัวเลขที่ไม่มีในบริบท → ให้ตอบใหม่ 1 ครั้ง · ยังแต่งอีก → ตอบแบบปลอดภัย ไม่ส่งตัวเลขนั้น', async () => {
    const h = withChat([() => [{ text: 'พ่อค้าคนกลางให้ 21.50 บาทค่ะ' }], () => [{ text: 'ราคาตลาดวันนี้ 17.65 บาท/กก. ค่ะ' }]]);
    await startDealAsFarmer(h);
    await h.say('คนกลางให้เท่าไร');
    expect(asText(h.last().messages[0]!)).toContain('17.65');
    expect(String(h.seen[1]!.messages.at(-1)!.content[0] && (h.seen[1]!.messages.at(-1)!.content[0] as any).text)).toContain('21.5');

    const h2 = withChat([() => [{ text: 'คนกลางให้ 21.50 บาทค่ะ' }]]);
    await startDealAsFarmer(h2);
    await h2.say('คนกลางให้เท่าไร');
    const out = asText(h2.last().messages[0]!);
    expect(out).not.toContain('21.50');
    expect(out).toContain('ยืนยันได้');
  });

  it('เกษตรกรพิมพ์แบบภาษาพูด → AI เสนอรายการ → การ์ดยืนยัน (ยังไม่เริ่มเจรจา) · ราคาขั้นต่ำต้องมาจากผู้ใช้', async () => {
    const h = withChat([() => [tool('propose_listing', { crop: 'rice_hommali', quantity_kg: 8000, floor_price_per_kg: 17.2, reply: 'สรุปให้แล้วค่ะ' })]]);
    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_auto'));
    await h.say('ปีนี้ได้ข้าวหอมมะลิมาแปดตันค่ะ อยากได้อย่างน้อย 17.2');
    expect(buttons(h.last().messages[1]!).map((b) => b.label)).toEqual(['ยืนยัน เริ่มเจรจา', 'แก้ไข']);
    expect((await h.store.getLineSession('U-farmer'))?.draft).toMatchObject({ quantityKg: 8000, floorPricePerKg: 17.2 });
    expect(h.store.deals.size).toBe(0);

    const g = withChat([() => [tool('propose_listing', { crop: 'rice_hommali', quantity_kg: 8000, floor_price_per_kg: 17.9, reply: 'ok' })]]);
    await g.tap(postbackData('role_farmer'));
    await g.tap(postbackData('group_auto'));
    await g.say('มีข้าวหอมมะลิแปดตัน ช่วยตั้งราคาให้หน่อย'); // ไม่ได้บอกขั้นต่ำ → AI ห้ามเดา
    expect(asText(g.last().messages[0]!)).toContain('ราคาสุทธิขั้นต่ำ');
    expect((await g.store.getLineSession('U-farmer'))?.draft).toBeUndefined();
  });

  it('ผู้ซื้อถาม "ทำไมต้องจ่ายแพงกว่านี้" → AI ได้ราคาตลาด NABC และข้อมูลกลุ่มแบบรวม ไม่มีชื่อหรือราคาขั้นต่ำของเกษตรกร', async () => {
    const h = withChat([() => [{ text: 'ราคากลางตลาด NABC วันนี้ 17.65 บาท/กก. และกลุ่มส่งเป็นล็อตเดียว 41,500 กก. ค่ะ' }]]);
    await h.tap(postbackData('role_buyer'));
    await h.say('ยกเลิก');
    await h.say('ทำไมผมต้องจ่ายแพงกว่านี้');
    expect(asText(h.last().messages[0]!)).toContain('17.65');
    const sys = h.seen[0]!.system;
    expect(sys).toContain('"medianPerKg":17.65');
    expect(sys).toContain('ร้อยเอ็ด');
    for (const secret of ['สมศรี', 'บุญมา', 'floorPrice', '16.8', '16.2', 'bankAccount']) expect(sys).not.toContain(secret);
  });

  it('ผู้ซื้อถามกลับระหว่างกรอกคำขอ → AI ตอบ แล้วถามคำถามเดิมซ้ำ · AI เสนอคำขอซื้อ → การ์ดยืนยัน → บันทึกได้', async () => {
    const h = withChat([
      () => [{ text: 'กลุ่มข้าวที่ร้อยเอ็ดมี 41,500 กก. ค่ะ' }],
      () => [tool('propose_buyer_request', { crop: 'rice_hommali', quantity_kg: 10000, location: 'โรงสี จ.ร้อยเอ็ด', offer_per_kg: 18.2, reply: 'สรุปคำขอให้แล้วค่ะ' })],
    ]);
    await h.tap(postbackData('role_buyer'));
    await h.tap(postbackData('buyer_crop', undefined, 'rice_hommali'));
    await h.say('มีของเท่าไรบ้าง');
    expect(asText(h.last().messages[0]!)).toContain('41,500');
    expect(asText(h.last().messages[1]!)).toContain('เท่าไหร่'); // ถามปริมาณซ้ำ
    await h.say('ยกเลิก');
    await h.say('อยากได้ข้าวหอมมะลิ 10 ตัน ส่งโรงสีที่ร้อยเอ็ด ให้ 18.2');
    expect(buttons(h.last().messages[1]!).map((b) => b.label)).toEqual(['ยืนยันคำขอซื้อ', 'แก้ไข']);
    await h.tap(postbackData('buyer_confirm'));
    expect(h.store.buyerRequests[0]).toMatchObject({ quantityKg: 10_000, offerPerKg: 18.2 });
  });

  it('เกินโควตาแชตรายวัน หรือ AI ล้ม → กลับไปตอบแบบกฎ (ไม่เงียบ)', async () => {
    const h = withChat([() => [{ text: 'x' }]], { limit: 0 });
    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_auto'));
    await h.say('ข้าวหอมมะลิ 12 ตัน');
    expect(asText(h.last().messages[0]!)).toContain('ราคาสุทธิขั้นต่ำ');
    expect(h.seen).toHaveLength(0);

    const f = withChat([() => { throw new Error('Bedrock down'); }]);
    await f.tap(postbackData('role_farmer'));
    await f.tap(postbackData('group_auto'));
    await f.say('สวัสดีจ้า วันนี้ราคาเป็นไง');
    expect(f.last().messages.length).toBeGreaterThan(0);
  });

  it('การ์ดผลเจรจามี "น้องมะระต่อรองอย่างไร" (รอบ หลักฐาน ราคา) และปุ่มดูการเจรจาทั้งหมด', async () => {
    const h = setup();
    await h.tap(postbackData('role_farmer'));
    await h.tap(postbackData('group_auto'));
    await h.say(ROOF);
    const raw = JSON.stringify({ destination: 'U', events: [{ type: 'postback', webhookEventId: 'x-1', mode: 'active', replyToken: 'r', source: { type: 'user', userId: 'U-farmer' }, postback: { data: postbackData('confirm') } }] });
    await h.ctx.line!.handleWebhook(raw, signLineBody(raw, SECRET), 'https://example.test/');
    const card = h.sent.find((m) => m.kind === 'push' && m.to === 'U-farmer')!.messages[0]!;
    const json = asText(card);
    expect(json).toContain('น้องมะระต่อรองอย่างไร');
    expect(json).toMatch(/รอบ \d+ · /);
    expect(json).toContain('https://example.test/?deal=deal-1');
    expect(json).toContain('ทำไมได้ราคานี้');
  });
});

// ---------- ผู้ซื้อเจรจากับกลุ่มเกษตรกร ----------
describe('ผู้ซื้อเจรจาราคากับน้องมะระ (ตัวแทนกลุ่มเกษตรกร)', () => {
  const quick = (m: LineMessage) => ((m as { quickReply?: { items: { action: { label: string; data: string } }[] } }).quickReply?.items ?? []).map((i) => i.action);
  const register = async (h: ReturnType<typeof setup>, offer: string) => {
    await h.tap(postbackData('role_buyer'));
    await h.tap(postbackData('buyer_crop', undefined, 'rice_hommali'));
    await h.say('10 ตัน');
    await h.say('โรงสี จ.ร้อยเอ็ด');
    await h.say(offer);
    await h.tap(postbackData('buyer_confirm'));
  };

  it('ราคาที่น้องมะระขอไม่เคยต่ำกว่าเป้าของกลุ่ม ยอมลดเป็นขั้น และตกลงเมื่อผู้ซื้อเสนอถึง', async () => {
    const { decide, apply, groupTerms, openingAsk } = await import('../src/line/buyerNegotiation.js');
    const t = groupTerms('rice_hommali')!;
    let st = { id: 'x', crop: 'rice_hommali' as const, groupId: t.group.id, askPerKg: openingAsk(t.minPassPerKg, 17.65), minPassPerKg: t.minPassPerKg, rounds: 0, status: 'open' as const, startedAt: '' };
    expect(st.askPerKg).toBeGreaterThan(t.minPassPerKg);
    const asks: number[] = [];
    for (const offer of [15, 15.5, 16, 16.2, 16.4]) {
      const d = decide(st, offer);
      st = apply(st, offer, d) as typeof st;
      asks.push(st.askPerKg);
      expect(st.askPerKg).toBeGreaterThanOrEqual(t.minPassPerKg); // ไม่ต่ำกว่าเป้า แม้ผู้ซื้อกดราคา
    }
    expect(asks.every((a, i) => i === 0 || a <= asks[i - 1]!)).toBe(true); // ลดลงหรือคงที่ ไม่ขึ้นสลับ
    const accept = decide(st, st.askPerKg);
    expect(accept).toEqual({ kind: 'accept', agreedPerKg: st.askPerKg });
    expect(decide(st, undefined).kind).toBe('question');
  });

  it('อ่านราคาจากข้อความ: ไม่สับสนกับปริมาณหรือจำนวนวัน', async () => {
    const { extractOffer } = await import('../src/line/buyerNegotiation.js');
    expect(extractOffer('ให้ 18.2 บาทได้ไหม', 18.9)).toBe(18.2);
    expect(extractOffer('เอา 10 ตัน ส่งใน 7 วัน', 18.9)).toBeUndefined();
    expect(extractOffer('10 ตัน ราคา ๑๘.๕', 18.9)).toBe(18.5);
    expect(extractOffer('ทำไมแพงจัง', 18.9)).toBeUndefined();
  });

  it('กดสนใจจากการ์ดกลุ่ม → ใช้ราคาในคำขอเป็นข้อเสนอแรก → ต่อรอง → กดยอมรับ → ตกลง + เกษตรกรอนุมัติ (จำลอง) + ledger', async () => {
    const h = setup();
    await register(h, '16'); // ต่ำกว่าเป้าของกลุ่ม
    await h.tap(postbackData('buyer_negotiate', undefined, 'rice_hommali'));
    const [intro, counter] = h.last().messages;
    expect(asText(intro!)).toContain('เริ่มเจรจากับกลุ่ม');
    const st1 = (await h.store.getLineSession('U-farmer'))!.buyerNeg!;
    expect(st1.status).toBe('open');
    expect(st1.askPerKg).toBeGreaterThanOrEqual(st1.minPassPerKg);
    expect(asText(counter!)).toContain(st1.askPerKg.toFixed(2));
    expect(quick(counter!).map((a) => a.label)).toEqual([`ยอมรับ ${st1.askPerKg.toFixed(2)}`, 'จบการเจรจา']);

    await h.say('ขอ 16.5 ได้ไหม');
    const st2 = (await h.store.getLineSession('U-farmer'))!.buyerNeg!;
    expect(st2.rounds).toBe(2);
    expect(st2.askPerKg).toBeLessThanOrEqual(st1.askPerKg);
    expect(st2.askPerKg).toBeGreaterThanOrEqual(st2.minPassPerKg);

    await h.say('ทำไมแพงจัง'); // ไม่ได้เสนอราคา → ตอบและย้ำราคาเดิม
    expect((await h.store.getLineSession('U-farmer'))!.buyerNeg!.askPerKg).toBe(st2.askPerKg);
    expect(asText(h.last().messages[0]!)).toContain(st2.askPerKg.toFixed(2));

    await h.tap(postbackData('buyer_accept'));
    const msgs = h.last().messages.map(asText).join(' ');
    expect(msgs).toContain('ตกลงราคาเบื้องต้นแล้ว');
    expect(msgs).toContain(st2.askPerKg.toFixed(2));
    const done = (await h.store.getLineSession('U-farmer'))!.buyerNeg!;
    expect(done).toMatchObject({ status: 'agreed', agreedPerKg: st2.askPerKg });

    const events = await h.store.listEvents(done.id);
    expect(() => Ledger.from(events)).not.toThrow();
    expect(events.filter((e) => e.type === 'bneg.approval' && e.data.simulated === true)).toHaveLength(4);
    expect(events.at(-1)!.type).toBe('bneg.agreed');
    // ราคาภายในของกลุ่มไม่ถูกบันทึกหรือส่งออกไปที่ไหนเลย
    expect(JSON.stringify(events)).not.toContain('minPass');
  });

  it('เสนอสูงกว่าที่น้องมะระขอ → ขอให้ยืนยันราคาของผู้ซื้อก่อน (ไม่ลดให้เอง) → กดยืนยัน → ตกลง', async () => {
    const h = setup();
    await register(h, '25');
    await h.say('สนใจ');
    let st = (await h.store.getLineSession('U-farmer'))!.buyerNeg!;
    expect(st).toMatchObject({ status: 'confirming', pendingPerKg: 25 });
    expect(buttons(h.last().messages.at(-1)!).map((b) => b.label)).toEqual(['ยืนยันตกลงที่ 25.00', 'ยังไม่ตกลง เจรจาต่อ']);
    expect(h.last().messages.map(asText).join(' ')).not.toContain('ตกลงราคาเบื้องต้นแล้ว');
    await h.tap(postbackData('buyer_deal_confirm'));
    st = (await h.store.getLineSession('U-farmer'))!.buyerNeg!;
    expect(st).toMatchObject({ status: 'agreed', agreedPerKg: 25 });
    expect(h.last().messages.map(asText).join(' ')).toContain('ตกลงราคาเบื้องต้นแล้ว');
  });

  it('ยืนยันด้วยการพิมพ์ "ใช่" ได้ · กด "ยังไม่ตกลง" กลับไปเจรจาต่อ', async () => {
    const a = setup();
    await register(a, '25');
    await a.say('สนใจ');
    await a.say('ใช่');
    expect((await a.store.getLineSession('U-farmer'))!.buyerNeg!.status).toBe('agreed');

    const b = setup();
    await register(b, '25');
    await b.say('สนใจ');
    await b.tap(postbackData('buyer_deal_back'));
    const st = (await b.store.getLineSession('U-farmer'))!.buyerNeg!;
    expect(st.status).toBe('open');
    expect(st.pendingPerKg).toBeUndefined();
  });

  it('"จบ" → ถามยืนยันพร้อมราคาล่าสุดทั้งสองฝั่ง → จบไม่ตกลง หรือเลือกตกลงที่ราคาที่หนูเสนอ', async () => {
    const e = setup();
    await register(e, '16');
    await e.say('สนใจค่ะ');
    const ask = (await e.store.getLineSession('U-farmer'))!.buyerNeg!.askPerKg;
    await e.say('จบ');
    expect((await e.store.getLineSession('U-farmer'))!.buyerNeg!.status).toBe('confirming_end');
    const card = e.last().messages[0]!;
    expect(asText(card)).toContain('คุณเสนอล่าสุด');
    expect(asText(card)).toContain('16.00');
    expect(asText(card)).toContain(ask.toFixed(2));
    expect(buttons(card).map((b) => b.label)).toEqual(['จบ ไม่ตกลง', `ตกลงที่ ${ask.toFixed(2)}`, 'เจรจาต่อ']);
    await e.tap(postbackData('buyer_end_confirm'));
    expect((await e.store.getLineSession('U-farmer'))!.buyerNeg!.status).toBe('ended');

    const f = setup();
    await register(f, '16');
    await f.say('สนใจ');
    await f.say('จบ');
    await f.tap(postbackData('buyer_accept'));
    expect((await f.store.getLineSession('U-farmer'))!.buyerNeg!).toMatchObject({ status: 'agreed' });
  });

  it('ทุกรอบมีบรรทัดสถานะจากโค้ด: คุณเสนอเท่าไร หนูเสนอเท่าไร', async () => {
    const h = setup();
    await register(h, '16');
    await h.say('สนใจ');
    const st = (await h.store.getLineSession('U-farmer'))!.buyerNeg!;
    expect(asText(h.last().messages[1]!)).toContain(`รอบ 1 · คุณเสนอ 16.00 · หนูเสนอ ${st.askPerKg.toFixed(2)} บาท/กก.`);
  });

  it('มี AI: ข้อความของน้องมะระต้องตรงกับการตัดสินของโค้ด (ตัด markdown) · ถ้าพูดไม่ตรงหรือฟังเหมือนรับราคา → ใช้ข้อความสำเร็จรูป · บริบทไม่มีราคาภายใน', async () => {
    const run = async (reply: (sys: string) => string) => {
      const h = setup();
      const seen: string[] = [];
      h.ctx.chatLlm = () => ({ name: 's', converse: async (req: any) => (seen.push(req.system), { content: [{ text: reply(req.system) }] }) }) as never;
      h.ctx.chatDailyLimit = 50;
      await register(h, '16');
      await h.tap(postbackData('buyer_negotiate', undefined, 'rice_hommali'));
      const st = (await h.store.getLineSession('U-farmer'))!.buyerNeg!;
      return { h, st, sys: seen.at(-1)!, msg: asText(h.last().messages[1]!) };
    };
    const askOf = (sys: string) => /"askPerKg":([\d.]+)/.exec(sys)![1]!;

    const good = await run((sys) => `ราคา 16 บาทยังต่ำไปค่ะ ราคากลางตลาด **NABC** 17.65 บาท/กก. หนูขอเสนอ ${Number(askOf(sys)).toFixed(2)} บาท/กก. ค่ะ`);
    expect(good.sys).toContain(`"askPerKg":${good.st.askPerKg}`);
    expect(good.sys).not.toContain(String(good.st.minPassPerKg));
    expect(good.sys).not.toContain('minPass');
    expect(good.msg).toContain('17.65');
    expect(good.msg).not.toContain('**');

    const noPrice = await run(() => 'ราคากลางตลาด NABC 17.65 บาท/กก. ค่ะ');
    expect(noPrice.msg).toContain(`หนูขอเสนอ ${noPrice.st.askPerKg.toFixed(2)}`); // ใช้ข้อความสำเร็จรูป

    const contradicts = await run((sys) => `ขอบคุณที่เสนอ 16 บาทค่ะ หนูจะเสนอราคานี้ให้กลุ่มพิจารณา ${askOf(sys)}`);
    expect(contradicts.msg).not.toContain('ให้กลุ่มพิจารณา');
    expect(contradicts.msg).toContain('กลุ่มยังรับไม่ได้');
  });

  it('ตอนกรอกราคา: แสดงราคาแนะนำจาก NABC พร้อมปุ่มลัด · พืชที่ไม่มีใน NABC บอกตรง ๆ', async () => {
    const h = setup();
    await h.tap(postbackData('role_buyer'));
    await h.tap(postbackData('buyer_crop', undefined, 'rice_hommali'));
    await h.say('10 ตัน');
    await h.say('โรงสี จ.ร้อยเอ็ด');
    const m = h.last().messages[0]!;
    expect(asText(m)).toContain('ราคาแนะนำ');
    expect(asText(m)).toContain('17.65');
    expect(asText(m)).toContain('NABC');
    expect(quick(m).map((a) => a.label)).toContain('17.65 (ราคากลาง)');

    const g = setup();
    await g.tap(postbackData('role_buyer'));
    await g.tap(postbackData('buyer_crop', undefined, 'bitter_gourd'));
    await g.say('3 ตัน');
    await g.say('ตลาดไท');
    expect(asText(g.last().messages[0]!)).toContain('ยังไม่มีราคาอ้างอิงจาก NABC');
  });
});
