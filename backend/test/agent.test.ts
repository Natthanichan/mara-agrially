import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockBuyerApi, type CounterRequest, type QuoteRequest } from '../src/buyer/mockBuyer.js';
import { groupListings } from '../src/core/grouping.js';
import { Ledger } from '../src/core/ledger.js';
import { checkPriceFloor } from '../src/core/pricing.js';
import type { Crop } from '../src/core/types.js';
import { farmers, listings } from '../src/data/synthetic.js';
import { summarize } from '../src/market/nabcClient.js';
import { loadKnowledgeDir } from '../src/rag/chunker.js';
import { KnowledgeIndex } from '../src/rag/search.js';
import { runNegotiation, type AgentDeps } from '../src/agent/index.js';
import { RuleBasedMockLlm } from '../src/agent/llm/mock.js';
import type { ContentBlock, LlmClient, LlmRequest } from '../src/agent/llm/types.js';
import { checkMessageLeak, extractNumbers } from '../src/agent/guardrails.js';
import { planTrips } from '../src/agent/transport.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/nabc-2026-10-19.json', import.meta.url), 'utf8'));
const knowledge = new KnowledgeIndex(loadKnowledgeDir(fileURLToPath(new URL('../knowledge', import.meta.url))));
const DATE = '2026-10-19';
const groups = groupListings(listings, farmers);
const groupOf = (crop: Crop) => groups.find((g) => g.crop === crop)!;
const input = (crop: Crop = 'rice_hommali') => ({ dealId: `D-${crop}`, group: groupOf(crop), farmers, listings, date: DATE });

/** ผู้ซื้อจำลองที่จดทุกอย่างที่ได้รับ — ใช้ตรวจว่าข้อมูลส่วนตัวไม่หลุด */
class SpyBuyerApi extends MockBuyerApi {
  received: unknown[] = [];
  override requestQuote(id: string, req: QuoteRequest) {
    this.received.push(req);
    return super.requestQuote(id, req);
  }
  override submitCounter(id: string, c: CounterRequest) {
    this.received.push(c);
    return super.submitCounter(id, c);
  }
}

const deps = (buyers = new MockBuyerApi()): AgentDeps => ({
  buyers,
  knowledge,
  market: { getReference: async (crop, date, province) => summarize(fixture.data, crop, date, false, province) },
});

/** LLM ที่ทำตามสคริปต์: แต่ละ step คืน content จากฟังก์ชัน (เห็นผล tool ก่อนหน้าได้) */
function scripted(steps: ((req: LlmRequest) => ContentBlock[])[]): LlmClient & { calls: number } {
  let i = 0;
  let id = 0;
  return {
    name: 'scripted',
    calls: 0,
    async converse(req) {
      this.calls++;
      const step = steps[Math.min(i++, steps.length - 1)]!;
      return { content: step(req).map((b) => ('toolUse' in b ? { toolUse: { ...b.toolUse, toolUseId: `s-${++id}` } } : b)) };
    },
  };
}
const tool = (name: string, inp: Record<string, unknown> = {}): ContentBlock => ({ toolUse: { toolUseId: '', name, input: inp } });
/** หา session_id จากผล request_quote ในประวัติข้อความ */
const sessionIdOf = (req: LlmRequest, buyer: string) => {
  for (const m of req.messages)
    for (const b of m.content)
      if ('toolResult' in b) {
        const j = b.toolResult.content[0].json as { session_id?: string };
        if (j.session_id?.includes(buyer)) return j.session_id;
      }
  throw new Error('no session');
};
const lastResults = (req: LlmRequest) =>
  req.messages[req.messages.length - 1]!.content.filter((b) => 'toolResult' in b).map((b) => (b as { toolResult: { content: [{ json: Record<string, unknown> }] } }).toolResult.content[0].json);

describe('Agent + LLM จำลอง: เจรจาครบวงจร', () => {
  it('ข้าว: เทียบราคาสุทธิ จับค่าหักแฝง แล้วเตรียมดีลที่ดีที่สุดให้อนุมัติ', async () => {
    const ledger = new Ledger(() => new Date('2026-10-20T00:00:00Z'));
    const res = await runNegotiation(input(), deps(), new RuleBasedMockLlm(), { ledger });

    expect(res.status).toBe('pending_approval'); // ไม่ใช่ agreed — รอเกษตรกร
    expect(res.outcome).toMatchObject({ kind: 'prepared', buyerId: 'B-C' });
    if (res.outcome.kind !== 'prepared') throw new Error();
    expect(res.outcome.terms.deductions).toEqual([{ kind: 'percent', label: 'หักความชื้น', percent: 1.5 }]);

    // ตรวจซ้ำด้วย engine อิสระ: ทุกคนได้สุทธิ ≥ ขั้นต่ำ
    const g = groupOf('rice_hommali');
    const check = checkPriceFloor(g.members, listings, res.outcome.terms);
    expect(check.passes).toBe(true);

    // เห็นพฤติกรรม agentic ใน trace
    const types = res.trace.map((t) => t.type);
    for (const t of ['plan', 'tool_call', 'buyer_response', 'counter_sent', 'reasoning', 'outcome']) expect(types).toContain(t);
    expect(res.trace.some((t) => t.type === 'tool_call' && t.data.tool === 'search_knowledge')).toBe(true);
    expect(res.trace.some((t) => t.type === 'reasoning' && String(t.data.text).includes('หยุดเจรจากับรายนี้'))).toBe(true); // อ่านนิสัย A

    expect(res.metrics).toMatchObject({ buyersContacted: 3, guardrailBlocks: 0, marketMedianPerKg: 17.65 });
    expect(res.metrics.upliftVsBestOpeningPerKg).toBeGreaterThan(0);
    expect(ledger.verify().ok).toBe(true);
    expect(ledger.list().length).toBe(res.trace.length);
  });

  it('privacy: ผู้ซื้อไม่เคยได้รับตัวเลขราคาขั้นต่ำของใครเลย', async () => {
    const spy = new SpyBuyerApi();
    await runNegotiation(input(), deps(spy), new RuleBasedMockLlm());
    const floors = listings.map((l) => l.floorPricePerKg);
    const sent = JSON.stringify(spy.received);
    expect(sent).not.toMatch(/floor/i);
    for (const c of spy.received.filter((x): x is CounterRequest => 'message' in (x as object))) {
      const allowed = [c.pricePerKg, 17.65, 41_500];
      expect(extractNumbers(c.message ?? '').filter((n) => !allowed.includes(n) && floors.includes(n))).toEqual([]);
    }
  });

  it('มะระ: ไม่มีข้อเสนอผ่านขั้นต่ำทุกคน → ส่งเรื่องให้กลุ่ม ไม่ฝืนเตรียมดีล', async () => {
    const res = await runNegotiation(input('bitter_gourd'), deps(), new RuleBasedMockLlm());
    expect(res.status).toBe('failed');
    expect(res.outcome.kind).toBe('escalated');
  });

  it('มันสำปะหลัง: ผู้ซื้อรายเดียวก็ยังเจรจาขึ้นได้', async () => {
    const res = await runNegotiation(input('cassava'), deps(), new RuleBasedMockLlm());
    expect(res.status).toBe('pending_approval');
    expect(res.metrics.upliftVsBestOpeningPerKg).toBeGreaterThan(0);
  });

  it('ผลเหมือนเดิมทุกครั้ง (deterministic)', async () => {
    const run = async () => {
      const r = await runNegotiation(input(), deps(), new RuleBasedMockLlm(), { now: () => new Date(0) });
      return r.trace.map((t) => [t.type, t.data]);
    };
    expect(await run()).toEqual(await run());
  });
});

describe('Guardrails: โค้ดคุม LLM', () => {
  const quoteA = (req: LlmRequest) => [tool('request_quote', { buyer_id: 'B-A' })];

  it('LLM เสนอราคาต่ำกว่า floor → บล็อก ไม่ถึงผู้ซื้อ', async () => {
    const spy = new SpyBuyerApi();
    let blocked: Record<string, unknown> | undefined;
    const llm = scripted([
      quoteA,
      (req) => [tool('submit_counter', { session_id: sessionIdOf(req, 'B-A'), price_per_kg: 16.5, message: 'ขอ 16.50' })],
      (req) => ((blocked = lastResults(req)[0]), [tool('escalate_to_farmers', { reason: 'test' })]),
    ]);
    const res = await runNegotiation(input(), deps(spy), llm);
    expect(blocked).toMatchObject({ blocked: true, code: 'below_floor' });
    expect(spy.received.filter((x) => 'message' in (x as object))).toEqual([]); // ไม่ได้ส่งถึงผู้ซื้อ
    expect(res.metrics.guardrailBlocks).toBe(1);
    expect(res.trace.some((t) => t.type === 'guardrail_blocked')).toBe(true);
  });

  it('LLM ใส่ราคาขั้นต่ำของสมาชิกในข้อความ → บล็อก', async () => {
    let blocked: Record<string, unknown> | undefined;
    const llm = scripted([
      quoteA,
      (req) => [tool('submit_counter', { session_id: sessionIdOf(req, 'B-A'), price_per_kg: 18.5, message: 'สมาชิกบางคนรับได้ต่ำสุด 17.00 บาท' })],
      (req) => ((blocked = lastResults(req)[0]), [tool('escalate_to_farmers', { reason: 'test' })]),
    ]);
    await runNegotiation(input(), deps(), llm);
    expect(blocked).toMatchObject({ blocked: true, code: 'private_data_leak' });
  });

  it('LLM เสนอต่ำกว่าที่ผู้ซื้อให้อยู่แล้ว → บล็อก (กันเสียเงินฟรี)', async () => {
    let blocked: Record<string, unknown> | undefined;
    const llm = scripted([
      (req) => [tool('request_quote', { buyer_id: 'B-C' })],
      (req) => [tool('submit_counter', { session_id: sessionIdOf(req, 'B-C'), price_per_kg: 18.3, message: 'ขอ 18.30' })],
      (req) => ((blocked = lastResults(req)[0]), [tool('escalate_to_farmers', { reason: 'test' })]),
    ]);
    await runNegotiation(input(), deps(), llm);
    expect(blocked).toMatchObject({ blocked: true, code: 'below_buyer_offer' });
  });

  it('LLM พยายามเตรียมดีลที่ต่ำกว่า floor → บล็อก สถานะไม่เป็นรออนุมัติ', async () => {
    const llm = scripted([quoteA, (req) => [tool('prepare_deal_for_approval', { session_id: sessionIdOf(req, 'B-A'), summary_for_farmers: 'ดีลดี' })]]);
    const res = await runNegotiation(input(), deps(), llm, { limits: { maxSteps: 3 } });
    expect(res.status).toBe('failed');
    expect(res.trace.some((t) => t.type === 'guardrail_blocked' && t.data.code === 'below_floor')).toBe(true);
  });

  it('ไม่มี tool ปิดดีล: LLM เรียก accept_deal → error และดีลไม่เคยเป็น agreed', async () => {
    let result: Record<string, unknown> | undefined;
    const llm = scripted([
      () => [tool('accept_deal', { buyer_id: 'B-C' })],
      (req) => ((result = lastResults(req)[0]), [tool('escalate_to_farmers', { reason: 'test' })]),
    ]);
    const res = await runNegotiation(input(), deps(), llm);
    expect(result).toMatchObject({ error: expect.stringContaining('ไม่มี tool') });
    expect(res.trace.some((t) => t.type === 'status_changed' && t.data.to === 'agreed')).toBe(false);
  });

  it('เจรจาเกินจำนวนรอบต่อผู้ซื้อ → บล็อก', async () => {
    let blocked: Record<string, unknown> | undefined;
    const counter = (req: LlmRequest) => [tool('submit_counter', { session_id: sessionIdOf(req, 'B-A'), price_per_kg: 18.9, message: 'ขอ 18.90' })];
    // จำกัด 2 รอบ → ครั้งที่ 3 ต้องถูกบล็อก
    const llm = scripted([quoteA, counter, counter, counter, (req) => ((blocked = lastResults(req)[0]), [tool('escalate_to_farmers', { reason: 'x' })])]);
    await runNegotiation({ ...input(), maxRoundsPerBuyer: 2 }, deps(), llm);
    expect(blocked).toMatchObject({ blocked: true, code: 'round_limit' });
  });
});

describe('หยุดอย่างปลอดภัย', () => {
  it('LLM ล่ม → retry 1 ครั้ง แล้วหยุด ไม่มีดีล', async () => {
    const llm = { name: 'down', calls: 0, async converse() { this.calls++; throw new Error('ServiceUnavailable'); } };
    const res = await runNegotiation(input(), deps(), llm);
    expect(llm.calls).toBe(2);
    expect(res.status).toBe('failed');
    expect(res.outcome).toMatchObject({ kind: 'failed', reason: expect.stringContaining('ServiceUnavailable') });
    expect(res.trace.filter((t) => t.type === 'llm_error')).toHaveLength(2);
  });

  it('LLM ช้าเกิน timeout → หยุด', async () => {
    const llm: LlmClient = { name: 'slow', converse: () => new Promise(() => {}) };
    const res = await runNegotiation(input(), deps(), llm, { limits: { llmTimeoutMs: 20, llmRetries: 0 } });
    expect(res.outcome).toMatchObject({ kind: 'failed', reason: expect.stringContaining('ไม่ตอบภายใน 20 ms') });
  });

  it('LLM วนไม่จบ → หยุดเมื่อครบจำนวนขั้น', async () => {
    const llm = scripted([() => [tool('list_buyers')]]);
    const res = await runNegotiation(input(), deps(), llm, { limits: { maxSteps: 4 } });
    expect(res.metrics.steps).toBe(4);
    expect(res.outcome).toMatchObject({ kind: 'failed', reason: expect.stringContaining('ครบจำนวนขั้น') });
  });

  it('LLM ตอบแต่ข้อความ ไม่เลือกทำอะไร → เตือน 1 ครั้ง แล้วหยุด', async () => {
    const llm = scripted([() => [{ text: 'คิดอยู่…' }]]);
    const res = await runNegotiation(input(), deps(), llm);
    expect(llm.calls).toBe(2);
    expect(res.outcome).toMatchObject({ kind: 'failed', reason: expect.stringContaining('ไม่ได้เลือก') });
  });
});

describe('ส่วนประกอบย่อย', () => {
  it('จัดเที่ยวขนส่งตามเส้นทาง', () => {
    const trips = planTrips(groupOf('rice_hommali').members, farmers);
    expect(trips).toEqual([
      { id: 'T-RE-1', totalCost: 7000, farmerIds: ['F01', 'F02'] },
      { id: 'T-RE-2', totalCost: 8000, farmerIds: ['F03', 'F04'] },
    ]);
  });

  it('ตรวจตัวเลขในข้อความ: อนุญาตตัวเลขสาธารณะ บล็อกตัวเลขต้องห้าม', () => {
    expect(extractNumbers('รวม 41,500 กก. ราคา 17.65')).toEqual([41500, 17.65]);
    expect(checkMessageLeak('ราคาตลาด 17.65', [17.65], [17.65])).toBeUndefined();
    expect(checkMessageLeak('ต่ำสุด 17', [17.0])).toMatchObject({ code: 'private_data_leak' });
  });
});

describe('งบขั้นตอนของ Agent (เจอจริงบน Nova: ค้นข้อมูลวนจนหมด 14 ขั้นโดยไม่ได้สรุป)', () => {
  const noteOf = (req: LlmRequest) =>
    req.messages
      .at(-1)!
      .content.filter((b): b is { text: string } => 'text' in b)
      .map((b) => b.text)
      .join(' ');

  it('ค้นความรู้ได้ไม่เกิน 3 ครั้ง ครั้งที่ 4 ได้ error ที่บอกให้ไปต่อ (ขั้นยังเหลือสำหรับเจรจา)', async () => {
    const results: Record<string, unknown>[] = [];
    const search = (q: string) => (req: LlmRequest) => (req.messages.length > 1 && results.push(lastResults(req)[0]!), [tool('search_knowledge', { query: q })]);
    const llm = scripted([search('a'), search('b'), search('c'), search('d'), (req) => (results.push(lastResults(req)[0]!), [tool('escalate_to_farmers', { reason: 'test' })])]);
    await runNegotiation(input(), deps(), llm);
    expect(results.slice(0, 3).every((r) => Array.isArray(r.results))).toBe(true);
    expect(String(results[3]!.error)).toContain('ครบ 3 ครั้งแล้ว');
  });

  it('บอกจำนวนขั้นที่เหลือทุกขั้น และเมื่อเหลือ ≤ 3 ให้สั่งสรุปทันที', async () => {
    const notes: string[] = [];
    const step = (req: LlmRequest) => (req.messages.length > 1 && notes.push(noteOf(req)), [tool('list_buyers')]);
    const llm = scripted([step, step, step, step, step, step]);
    const res = await runNegotiation(input(), deps(), llm, { limits: { maxSteps: 6 } });
    expect(res.status).toBe('failed');
    expect(notes[0]).toContain('ใช้ไป 1/6 ขั้น เหลืออีก 5 ขั้น');
    expect(notes[1]).toContain('ใช้ไป 2/6 ขั้น เหลืออีก 4 ขั้น');
    expect(notes[2]).toContain('เหลืออีก 3 ขั้น ต้องสรุปตอนนี้');
    expect(notes[2]).toContain('prepare_deal_for_approval');
  });

  it('ค่าเริ่มต้น 18 ขั้น', async () => {
    const { DEFAULT_LIMITS } = await import('../src/agent/index.js');
    expect(DEFAULT_LIMITS.maxSteps).toBe(18);
  });
});
