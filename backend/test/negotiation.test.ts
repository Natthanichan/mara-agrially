// เครื่องเจรจา v2: ผู้ซื้อจำลองตอบสนองต่อหลักฐาน + ทะเบียนหลักฐาน + กลยุทธ์ใน submit_counter
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUYERS, MockBuyerApi, type BuyerConfig, type CounterRequest, type QuoteRequest } from '../src/buyer/mockBuyer.js';
import { groupListings } from '../src/core/grouping.js';
import type { Crop } from '../src/core/types.js';
import { farmers, listings } from '../src/data/synthetic.js';
import { KNOWLEDGE_FILES } from '../src/generated/knowledge.js';
import { summarize } from '../src/market/nabcClient.js';
import { chunkFiles } from '../src/rag/chunker.js';
import { KnowledgeIndex } from '../src/rag/search.js';
import { NegotiationState, ToolError, executeTool, type AgentDeps, type HistoryProvider } from '../src/agent/tools.js';
import { runNegotiation } from '../src/agent/index.js';
import { RuleBasedMockLlm } from '../src/agent/llm/mock.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/nabc-2026-10-19.json', import.meta.url), 'utf8'));
const knowledge = new KnowledgeIndex(chunkFiles(KNOWLEDGE_FILES));
const DATE = '2026-10-19';
const req = (quantityKg = 41_500): QuoteRequest => ({ groupId: 'G', crop: 'rice_hommali', grade: 'A', quantityKg, deliveryWindow: { from: '2026-11-20', to: '2026-11-24' } });

describe('ผู้ซื้อจำลอง v2: ตอบสนองต่อหลักฐาน ไม่ใช่แค่ตัวเลข', () => {
  const quote = (api: MockBuyerApi, id = 'B-A') => api.requestQuote(id, req()).sessionId;

  it('ขอราคาเดียวกัน: อ้างราคาตลาดที่สูงกว่าข้อเสนอจริง → ผู้ซื้อขยับมากกว่าไม่อ้าง และบอกว่าเหตุผลนั้นมีน้ำหนัก', () => {
    const a = new MockBuyerApi();
    const b = new MockBuyerApi();
    const plain = a.submitCounter(quote(a), { pricePerKg: 17.2 });
    const backed = b.submitCounter(quote(b), { pricePerKg: 17.2, arguments: [{ tag: 'market_reference', value: 17.65 }] });
    expect(plain.pricePerKg).toBe(16);
    expect(backed.pricePerKg).toBeGreaterThan(plain.pricePerKg);
    expect(backed.acknowledged).toContain('market_reference');
    expect(plain.acknowledged).toBeUndefined();
  });

  it('อ้างราคาที่ไม่ได้สูงกว่าที่ผู้ซื้อให้ → ไม่มีน้ำหนักเลย', () => {
    const a = new MockBuyerApi();
    const r = a.submitCounter(quote(a), { pricePerKg: 17.2, arguments: [{ tag: 'market_reference', value: 15.0 }] });
    expect(r.pricePerKg).toBe(16);
    expect(r.acknowledged).toBeUndefined();
  });

  it('เหตุผลเดิมซ้ำ → น้ำหนักลดลง (ขยับน้อยกว่ารอบแรก)', () => {
    const a = new MockBuyerApi();
    const id = quote(a);
    const claim: CounterRequest = { pricePerKg: 17.4, arguments: [{ tag: 'market_reference', value: 17.65 }] };
    const r1 = a.submitCounter(id, claim);
    const r2 = a.submitCounter(id, claim);
    expect(r2.pricePerKg - r1.pricePerKg).toBeLessThan(r1.pricePerKg - 15.8);
  });

  it('ขอสูงเกินงบมาก → ไม่ขยับเลย พร้อมข้อโต้แย้ง unrealistic_ask', () => {
    const a = new MockBuyerApi();
    const r = a.submitCounter(quote(a), { pricePerKg: 25, arguments: [{ tag: 'market_reference', value: 17.65 }] });
    expect(r.pricePerKg).toBe(15.8);
    expect(r.objection?.code).toBe('unrealistic_ask');
  });

  it('ยกข้อกังวลที่ยังไม่ถูกตอบก่อน ตามลำดับความสำคัญของผู้ซื้อแต่ละราย', () => {
    const a = new MockBuyerApi();
    expect(a.submitCounter(quote(a, 'B-B'), { pricePerKg: 17.5 }).objection?.code).toBe('need_quality_grade');
    const b = new MockBuyerApi();
    const id = quote(b, 'B-B');
    b.submitCounter(id, { pricePerKg: 17.5, arguments: [{ tag: 'quality_grade' }] });
    expect(b.submitCounter(id, { pricePerKg: 17.6 }).objection?.code).toBe('need_delivery_ready');
  });

  it('ถูกโน้มน้าวด้วยหลักฐานต่อเนื่อง → งบยืดเกินราคาสูงสุดตั้งต้นได้ (ไม่มีหลักฐาน = ไม่เกิน)', () => {
    const cfg: BuyerConfig = { ...DEFAULT_BUYERS[1]!, id: 'T', style: 'fair', maxRounds: 6, concedeRatio: 0.5, flexPerKg: 1, responsiveness: { market_reference: 1, volume: 1, quality_grade: 1 }, concerns: [], books: { rice_hommali: { A: { openingPerKg: 10, reservationPerKg: 11, deductions: [] } } } };
    const run = (withArgs: boolean) => {
      const api = new MockBuyerApi({ buyers: [cfg] });
      const id = api.requestQuote('T', req()).sessionId;
      let last = 0;
      const tags = ['market_reference', 'volume', 'quality_grade'] as const;
      for (let i = 0; i < 5; i++) {
        const r = api.submitCounter(id, { pricePerKg: 11.8, ...(withArgs ? { arguments: [{ tag: tags[i % 3]!, value: 12 }] } : {}) });
        last = r.pricePerKg;
        if (r.decision === 'accept' || r.decision === 'walk_away') break;
      }
      return last;
    };
    expect(run(false)).toBeLessThanOrEqual(11);
    expect(run(true)).toBeGreaterThan(11);
  });

  it('ยังไม่ยอมรับข้อเสนอสุดท้ายของ AI อัตโนมัติ: เกินจำนวนรอบ → ถอนตัว', () => {
    const a = new MockBuyerApi();
    const id = quote(a, 'B-B');
    let last;
    for (let i = 0; i < 6; i++) {
      try {
        last = a.submitCounter(id, { pricePerKg: 19.5 });
      } catch {
        break;
      }
    }
    expect(['walk_away', 'final_offer']).toContain(last!.decision);
    expect(last!.pricePerKg).toBeLessThan(19.5);
  });
});

// ---------- ทะเบียนหลักฐานและการตรวจใน submit_counter ----------

class SpyBuyers extends MockBuyerApi {
  sent: CounterRequest[] = [];
  override submitCounter(id: string, c: CounterRequest) {
    this.sent.push(c);
    return super.submitCounter(id, c);
  }
}

function setup(opts: { crop?: Crop; floorOverride?: Record<string, number>; history?: HistoryProvider } = {}) {
  const ls = listings.map((l) => (opts.floorOverride?.[l.farmerId] !== undefined ? { ...l, floorPricePerKg: opts.floorOverride[l.farmerId]! } : l));
  const group = groupListings(ls, farmers).find((g) => g.crop === (opts.crop ?? 'rice_hommali'))!;
  const st = new NegotiationState({ dealId: 'D', group, farmers, listings: ls, date: DATE });
  const buyers = new SpyBuyers();
  const deps: AgentDeps = { buyers, knowledge, market: { getReference: async (c, d, p) => summarize(fixture.data, c, d, false, p) }, ...(opts.history ? { history: opts.history } : {}) };
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const call = (name: string, input: Record<string, unknown>) => executeTool(name, input, st, deps, (type, data) => events.push({ type, data }));
  const quote = async (id: string) => ((await call('request_quote', { buyer_id: id })) as { session_id: string }).session_id;
  const counter = (sid: string, extra: Record<string, unknown>) => call('submit_counter', { session_id: sid, strategy: 'evidence_value', rationale: 'ทดสอบ', evidence_ids: [], price_per_kg: 18.9, message: 'ขอเสนอ 18.90 บาท/กก.', ...extra });
  return { st, buyers, call, quote, counter, events };
}

describe('ทะเบียนหลักฐาน + submit_counter', () => {
  it('มีข้อเท็จจริงของกลุ่มตั้งแต่ต้น และไม่มีราคาขั้นต่ำในทะเบียน', () => {
    const { st } = setup();
    expect(st.evidence.list().map((e) => e.id)).toEqual(['E-VOL', 'E-GRADE', 'E-DELIVERY', 'E-LOGISTICS']);
    const floors = listings.map((l) => l.floorPricePerKg);
    expect(st.evidence.numbers().filter((n) => floors.includes(n))).toEqual([]);
  });

  it('ต้องระบุกลยุทธ์ที่รู้จัก และหลักฐานที่มีอยู่จริง', async () => {
    const { quote, counter } = setup();
    const sid = await quote('B-C');
    await expect(counter(sid, { strategy: 'magic' })).rejects.toBeInstanceOf(ToolError);
    await expect(counter(sid, { evidence_ids: ['E-MIDDLEMAN'] })).rejects.toThrow('ไม่พบหลักฐาน E-MIDDLEMAN');
  });

  it('ตัวเลขที่ไม่มีหลักฐาน (เช่น ราคาคนกลางที่แต่งขึ้น) → บล็อก ไม่ถึงผู้ซื้อ', async () => {
    const { quote, counter, buyers, st } = setup();
    const sid = await quote('B-C');
    const r = (await counter(sid, { message: 'คนกลางรับซื้อที่ 21.50 บาท ขอเสนอ 18.90 บาท/กก.' })) as { blocked: boolean; code: string };
    expect(r).toMatchObject({ blocked: true, code: 'unverified_number' });
    expect(buyers.sent).toHaveLength(0);
    expect(st.violations.at(-1)?.code).toBe('unverified_number');
  });

  it('ตัวเลขจากหลักฐานที่ดึงมาแล้ว (ราคา NABC ปริมาณ) ส่งได้ และผู้ซื้อได้รับเหตุผลแบบมีโครงสร้าง', async () => {
    const { quote, counter, call, buyers } = setup();
    await call('get_market_price', {});
    const sid = await quote('B-A');
    const r = (await counter(sid, { evidence_ids: ['E-MKT-MEDIAN', 'E-VOL'], price_per_kg: 18.2, message: 'ราคากลาง NABC 17.65 บาท/กก. ปริมาณรวม 41.5 ตัน ขอเสนอ 18.20 บาท/กก.' })) as Record<string, unknown>;
    expect(r.blocked).toBeUndefined();
    expect(buyers.sent[0]!.arguments).toEqual([{ tag: 'market_reference', value: 17.65 }, { tag: 'volume', value: 41_500 }]);
    expect(r.objection).toBeDefined();
  });

  it('อ้างข้อเสนอของรายอื่นได้เฉพาะเมื่อดีกว่าจริง (ราคาสุทธิสูงกว่า) — ห้ามหลอกผู้ซื้อ', async () => {
    const { quote, counter, call } = setup();
    const a = await quote('B-A'); // 15.80
    const c = await quote('B-C'); // 18.40 หักความชื้น 4% → สุทธิสูงกว่า A
    await expect(counter(c, { strategy: 'competitive_leverage', evidence_ids: ['E-COMP-B-A'] })).rejects.toThrow('ไม่ได้ให้ราคาสุทธิดีกว่า');
    await expect(counter(c, { evidence_ids: ['E-COMP-B-C'] })).rejects.toThrow();
    const ev = (await call('evaluate_offer', { session_id: a })) as { leverage?: { id: string }[] };
    expect(ev.leverage?.map((x) => x.id)).toEqual(['E-COMP-B-C']);
    const r = (await counter(a, { strategy: 'competitive_leverage', evidence_ids: ['E-COMP-B-C'], price_per_kg: 18.0, message: 'ขอเสนอ 18.00 บาท/กก.' })) as Record<string, unknown>;
    expect(r.decision).toBeDefined();
  });

  it('ตัวเลขที่บังเอิญตรงกับราคาขั้นต่ำ (เช่น วันที่ของแหล่งข้อมูล) → บล็อกไว้ก่อน แม้มาจากหลักฐาน', async () => {
    const { quote, counter, call, buyers } = setup({ floorOverride: { F01: 19 } });
    await call('get_market_price', {}); // ข้อมูลวันที่ 19
    const sid = await quote('B-C');
    const r = (await counter(sid, { price_per_kg: 22, evidence_ids: ['E-MKT-MEDIAN'], message: 'ข้อมูล NABC วันที่ 19 ขอเสนอ 22.00 บาท/กก.' })) as { code: string };
    expect(r.code).toBe('private_data_leak');
    expect(buyers.sent).toHaveLength(0);
  });

  it('ความรู้จำลองจาก RAG ติดป้ายว่าไม่ใช่ข้อเท็จจริงยืนยัน และไม่ทำให้ผู้ซื้อขยับ', async () => {
    const { call, st } = setup();
    const r = (await call('search_knowledge', { query: 'หักความชื้น' })) as { evidence: { id: string; note?: string }[] };
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.evidence.every((e) => e.note?.includes('ข้อมูลจำลอง'))).toBe(true);
    expect(st.evidence.claims(r.evidence.map((e) => e.id))).toEqual([]);
  });

  it('ใช้กลยุทธ์+หลักฐานชุดเดิมซ้ำ → เตือน และนับเป็นตัวชี้วัด', async () => {
    const { quote, counter, st } = setup();
    const sid = await quote('B-A');
    await counter(sid, { evidence_ids: ['E-VOL'], price_per_kg: 17.5, message: 'ขอเสนอ 17.50 บาท/กก.' });
    const r2 = (await counter(sid, { evidence_ids: ['E-VOL'], price_per_kg: 17.5, message: 'ขอเสนอ 17.50 บาท/กก.' })) as { warning?: string };
    expect(r2.warning).toContain('ชุดเดิม');
    expect(st.repeatedMoves).toBe(1);
    expect(st.strategyCounts.evidence_value).toBe(2);
  });

  it('ประวัติการเจรจาจริงในระบบ → หลักฐาน E-HIST · ไม่มีประวัติ → ห้ามอ้าง', async () => {
    const history: HistoryProvider = { forBuyer: async (id) => (id === 'B-C' ? [{ dealId: 'old', at: '2026-10-01T00:00:00Z', openingPerKg: 18.3, finalPerKg: 18.7, decision: 'accept', chosen: true }] : []) };
    const { call, st } = setup({ history });
    const r = (await call('get_negotiation_history', { buyer_id: 'B-C' })) as { evidence: { id: string }[] };
    expect(r.evidence[0]!.id).toBe('E-HIST-B-C');
    expect(st.evidence.claims(['E-HIST-B-C'])).toEqual([{ tag: 'buyer_history', value: 18.7 }]);
    expect(((await call('get_negotiation_history', { buyer_id: 'B-A' })) as { note: string }).note).toContain('ห้ามอ้าง');
    expect(((await setup().call('get_negotiation_history', { buyer_id: 'B-C' })) as { records: unknown[] }).records).toEqual([]);
  });
});

describe('หลักฐานทำให้ผลดีขึ้นจริง (AI สำรองแบบกฎ, ข้อมูลจำลอง)', () => {
  const run = async (crop: Crop, useEvidence: boolean) => {
    const group = groupListings(listings, farmers).find((g) => g.crop === crop)!;
    const deps: AgentDeps = { buyers: new MockBuyerApi(), knowledge, market: { getReference: async (c, d, p) => summarize(fixture.data, c, d, false, p) } };
    return runNegotiation({ dealId: 'D', group, farmers, listings, date: DATE }, deps, new RuleBasedMockLlm(5, { useEvidence }));
  };

  it('ข้าวและมันสำปะหลัง: เจรจาแบบมีหลักฐานได้ราคาสุทธิไม่ต่ำกว่าแบบตัวเลขอย่างเดียว และมันสำปะหลังดีกว่าชัดเจน', async () => {
    for (const crop of ['rice_hommali', 'cassava'] as Crop[]) {
      const [withEv, without] = [await run(crop, true), await run(crop, false)];
      expect(withEv.outcome.kind).toBe('prepared');
      expect(withEv.metrics.finalNetPerKgAvg!).toBeGreaterThanOrEqual(without.metrics.finalNetPerKgAvg ?? 0);
    }
    const [c1, c0] = [await run('cassava', true), await run('cassava', false)];
    expect(c1.metrics.finalNetPerKgAvg! - c0.metrics.finalNetPerKgAvg!).toBeGreaterThan(0.05);
  });
});

describe('การตรวจตัวเลขในข้อความ', () => {
  it('เลขไทยถูกตรวจเหมือนเลขอารบิก (กันหลบการตรวจการรั่ว)', async () => {
    const { checkMessageLeak, extractNumbers } = await import('../src/agent/guardrails.js');
    expect(extractNumbers('ขั้นต่ำ ๑๗.๐๐ บาท')).toEqual([17]);
    expect(checkMessageLeak('สมาชิกรับได้ ๑๖.๘๐ บาท', [16.8])?.code).toBe('private_data_leak');
  });

  it('จำนวนนับเล็ก ๆ (7 วัน, 2 เที่ยว) ไม่ต้องมีหลักฐาน แต่ราคา/เปอร์เซ็นต์ที่แต่งขึ้นยังถูกจับ', async () => {
    const { numbersNeedingEvidence } = await import('../src/agent/guardrails.js');
    expect(numbersNeedingEvidence('ส่งได้ภายใน 7 วัน รถ 2 เที่ยว')).toEqual([]);
    expect(numbersNeedingEvidence('ประหยัดต้นทุนได้ 12% และคนกลางให้ 21.50 บาท')).toEqual([12, 21.5]);
    expect(numbersNeedingEvidence('ภายใน ๗ วัน ราคา ๒๐.๕๐')).toEqual([20.5]);
  });

  it('ขั้นต่ำที่เป็นจำนวนเต็มยังถูกจับ แม้เขียนเป็นจำนวนวัน', async () => {
    const { quote, counter, buyers } = setup({ floorOverride: { F01: 19 } });
    const sid = await quote('B-C');
    const r = (await counter(sid, { price_per_kg: 22, message: 'ส่งได้ใน 19 วัน ขอเสนอ 22.00 บาท/กก.' })) as { code: string };
    expect(r.code).toBe('private_data_leak');
    expect(buyers.sent).toHaveLength(0);
  });
});
