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
    const saved = asText(h.last().messages[0]!);
    expect(saved).toContain('บันทึกคำขอซื้อแล้ว');
    expect(saved).toContain('เกษตรกร 5 ราย'); // ภาพรวมผลผลิตจำลอง
    expect(saved).toContain('กำลังพัฒนา'); // บอกตรงๆ ว่าการคุยต่อรองยังไม่เสร็จ
    // ไม่มีราคาขั้นต่ำของเกษตรกรหลุดไปถึงผู้ซื้อ
    for (const floor of ['16.80', '16.50', '17.00', '16.20', '15.50']) expect(saved).not.toContain(floor);
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
