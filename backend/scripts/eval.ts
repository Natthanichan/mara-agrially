// ประเมินคุณภาพการเจรจาหลายสถานการณ์ — วัดราคาสุทธิที่เพิ่มขึ้นเทียบกับข้อเสนอแรกของผู้ซื้อ
//   npm run eval                                  # ไม่มีค่าใช้จ่าย: เทียบ 3 แบบด้วยผู้ซื้อจำลอง
//   npm run eval -- --out eval-report.md          # บันทึกรายงานเป็นไฟล์
//   LLM_PROVIDER=bedrock BEDROCK_MODEL_ID=... AWS_REGION=ap-southeast-1 npm run eval -- --nova --limit 6
//                                                 # เพิ่ม Nova จริง (มีค่าใช้จ่ายต่อ token จำกัดจำนวนสถานการณ์ด้วย --limit)
//
// แบบที่เทียบ:
//   opening  — รับข้อเสนอแรกที่ดีที่สุดที่ผ่านขั้นต่ำทุกคน (ไม่เจรจา)
//   numbers  — AI สำรองแบบกฎ เจรจาด้วยตัวเลขอย่างเดียว ไม่อ้างหลักฐาน
//   evidence — AI สำรองแบบกฎ เลือกกลยุทธ์และอ้างหลักฐานตามข้อโต้แย้งของผู้ซื้อ
//   nova     — Amazon Nova บน Bedrock (ถ้าใส่ --nova)
// ทั้งหมดเป็นข้อมูลจำลอง + ราคา NABC ตัวอย่างวันที่ 19 ต.ค. 2569 — ผลเป็นการทดสอบ ไม่ใช่ผลในตลาดจริง

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLlm, runNegotiation, type AgentDeps } from '../src/agent/index.js';
import type { LlmClient } from '../src/agent/llm/types.js';
import { RuleBasedMockLlm } from '../src/agent/llm/mock.js';
import { NegotiationState } from '../src/agent/tools.js';
import { DEFAULT_BUYERS, MockBuyerApi, type BuyerConfig } from '../src/buyer/mockBuyer.js';
import { groupListings } from '../src/core/grouping.js';
import type { Crop, Listing } from '../src/core/types.js';
import { CROP_LABEL_TH, farmers, listings } from '../src/data/synthetic.js';
import { KNOWLEDGE_FILES } from '../src/generated/knowledge.js';
import { summarize } from '../src/market/nabcClient.js';
import { chunkFiles } from '../src/rag/chunker.js';
import { KnowledgeIndex } from '../src/rag/search.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../test/fixtures/nabc-2026-10-19.json', import.meta.url)), 'utf8'));
const knowledge = new KnowledgeIndex(chunkFiles(KNOWLEDGE_FILES));
const DATE = '2026-10-19';
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------- สถานการณ์ ----------

type Variant = 'default' | 'tight' | 'generous' | 'stubborn';
const VARIANT_TH: Record<Variant, string> = { default: 'ผู้ซื้อตั้งต้น', tight: 'งบตึง', generous: 'งบหลวม', stubborn: 'ไม่ค่อยฟังเหตุผล' };

/** ปรับผู้ซื้อทั้งชุดตามบุคลิกของสถานการณ์ */
function buyersFor(v: Variant): BuyerConfig[] {
  return DEFAULT_BUYERS.map((b) => {
    const books = structuredClone(b.books);
    for (const grades of Object.values(books)) for (const book of Object.values(grades ?? {})) {
      if (!book) continue;
      if (v === 'tight') book.reservationPerKg = r2(Math.max(book.openingPerKg, book.reservationPerKg - 0.2));
      if (v === 'generous') book.reservationPerKg = r2(book.reservationPerKg + 0.3);
    }
    const responsiveness = v === 'stubborn' ? Object.fromEntries(Object.entries(b.responsiveness).map(([k, w]) => [k, r2((w ?? 0) * 0.3)])) : b.responsiveness;
    return { ...b, books, responsiveness, flexPerKg: v === 'tight' ? b.flexPerKg / 2 : b.flexPerKg };
  });
}

interface Scenario {
  id: string;
  crop: Crop;
  variant: Variant;
  market: boolean;
  /** ราคาขั้นต่ำที่ต่างจากข้อมูลจำลอง (เช่น เกษตรกรใน LINE ตั้งสูง) */
  floors?: Record<string, number>;
}

const SCENARIOS: Scenario[] = [];
for (const crop of ['rice_hommali', 'cassava', 'bitter_gourd'] as Crop[])
  for (const variant of ['default', 'tight', 'generous', 'stubborn'] as Variant[])
    for (const market of [true, false]) SCENARIOS.push({ id: `${crop}/${variant}/${market ? 'nabc' : 'no-nabc'}`, crop, variant, market });
SCENARIOS.push({ id: 'rice_hommali/default/nabc/high-floor-17.5', crop: 'rice_hommali', variant: 'default', market: true, floors: { F01: 17.5 } });

// ---------- ตัวเจรจา ----------

interface Result {
  deal: boolean;
  finalNet?: number;
  totalNet?: number;
  upliftVsBestOpening?: number;
  upliftVsChosenOpening?: number;
  upliftBaht?: number;
  rounds: number;
  blocks: number;
  unverified: number;
  repeated: number;
  strategies: Record<string, number>;
  error?: string;
}

function setup(sc: Scenario) {
  const ls: Listing[] = listings.map((l) => (sc.floors?.[l.farmerId] !== undefined ? { ...l, floorPricePerKg: sc.floors[l.farmerId]! } : l));
  const group = groupListings(ls, farmers).find((g) => g.crop === sc.crop)!;
  const deps: AgentDeps = {
    buyers: new MockBuyerApi({ buyers: buyersFor(sc.variant) }),
    knowledge,
    market: { getReference: async (c, d, p) => (sc.market ? summarize(fixture.data, c, d, false, p) : undefined) },
  };
  return { ls, group, deps };
}

/** ไม่เจรจา: ขอใบเสนอราคาทุกราย แล้วรับรายที่ราคาสุทธิดีที่สุดที่ผ่านขั้นต่ำ */
function openingBaseline(sc: Scenario): Result & { bestOpeningNet?: number } {
  const { ls, group, deps } = setup(sc);
  const st = new NegotiationState({ dealId: 'E', group, farmers, listings: ls, date: DATE });
  const evals = deps.buyers.listBuyers(group.crop, group.grade, st.totalKg).map((b) => {
    const res = deps.buyers.requestQuote(b.id, { groupId: group.id, crop: group.crop, grade: group.grade, quantityKg: st.totalKg, deliveryWindow: group.deliveryWindow });
    const s = { sessionId: res.sessionId, buyerId: b.id, buyerName: b.name, last: res, rounds: 0, history: [res], closed: false, moves: [] };
    return st.evaluate(s);
  });
  const best = evals.filter((e) => e.passesAllFloors).sort((a, b) => b.netPerKgAvg - a.netPerKgAvg)[0];
  return { deal: !!best, ...(best ? { finalNet: best.netPerKgAvg, totalNet: best.totalNetBaht } : {}), rounds: 0, blocks: 0, unverified: 0, repeated: 0, strategies: {} };
}

async function negotiate(sc: Scenario, llm: LlmClient): Promise<Result> {
  const { ls, group, deps } = setup(sc);
  try {
    const res = await runNegotiation({ dealId: 'E', group, farmers, listings: ls, date: DATE }, deps, llm);
    const m = res.metrics;
    return {
      deal: res.outcome.kind === 'prepared',
      ...(m.finalNetPerKgAvg !== undefined ? { finalNet: m.finalNetPerKgAvg } : {}),
      ...(res.outcome.kind === 'prepared' ? { totalNet: res.outcome.evaluation.totalNetBaht } : {}),
      ...(m.upliftVsBestOpeningPerKg !== undefined ? { upliftVsBestOpening: m.upliftVsBestOpeningPerKg, upliftBaht: m.upliftVsBestOpeningBaht } : {}),
      ...(m.upliftVsChosenOpeningPerKg !== undefined ? { upliftVsChosenOpening: m.upliftVsChosenOpeningPerKg } : {}),
      rounds: Object.values(m.roundsByBuyer).reduce((a, b) => a + b, 0),
      blocks: m.guardrailBlocks,
      unverified: m.unverifiedNumberBlocks ?? 0,
      repeated: m.repeatedMoves ?? 0,
      strategies: m.strategies ?? {},
    };
  } catch (e) {
    return { deal: false, rounds: 0, blocks: 0, unverified: 0, repeated: 0, strategies: {}, error: (e as Error).message };
  }
}

// ---------- รัน ----------

const agents: { id: string; th: string; make: () => LlmClient | 'opening' }[] = [
  { id: 'opening', th: 'รับข้อเสนอแรกที่ดีที่สุด (ไม่เจรจา)', make: () => 'opening' },
  { id: 'numbers', th: 'เจรจาด้วยตัวเลขอย่างเดียว', make: () => new RuleBasedMockLlm(5, { useEvidence: false }) },
  { id: 'evidence', th: 'เจรจาด้วยกลยุทธ์ + หลักฐาน (AI สำรอง)', make: () => new RuleBasedMockLlm(5) },
];
if (flag('nova')) {
  if (process.env.LLM_PROVIDER !== 'bedrock') throw new Error('--nova ต้องตั้ง LLM_PROVIDER=bedrock และ BEDROCK_MODEL_ID');
  agents.push({ id: 'nova', th: 'Amazon Nova (Bedrock)', make: () => createLlm(process.env, 5) });
}
const limit = Number(opt('limit') ?? (flag('nova') ? 6 : SCENARIOS.length));
const only = opt('only');
const scenarios = SCENARIOS.filter((s) => !only || s.id.includes(only)).slice(0, limit);

const results: Record<string, Record<string, Result>> = {};
for (const sc of scenarios) {
  results[sc.id] = {};
  for (const a of agents) {
    const made = a.make();
    results[sc.id]![a.id] = made === 'opening' ? openingBaseline(sc) : await negotiate(sc, made);
    if (a.id === 'nova') process.stderr.write(`nova ${sc.id}: ${results[sc.id]!.nova!.deal ? 'deal' : 'no deal'}\n`);
  }
}

// ---------- รายงาน ----------

const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined);
const fmt = (n: number | undefined, sign = false) => (n === undefined ? '–' : `${sign && n > 0 ? '+' : ''}${n.toFixed(2)}`);
const lines: string[] = [];
lines.push('# ผลประเมินการเจรจา (ข้อมูลจำลอง)', '');
lines.push(`สถานการณ์ ${scenarios.length} แบบ: ${[...new Set(scenarios.map((s) => CROP_LABEL_TH[s.crop]))].join(', ')} × บุคลิกผู้ซื้อ (${Object.values(VARIANT_TH).join(', ')}) × มี/ไม่มีราคา NABC`, '');
lines.push('| แบบ | ได้ดีล | เพิ่มจาก "ไม่เจรจา" (บาท/กก.) | เพิ่มจากข้อเสนอแรกของรายที่เลือก (บาท/กก.) | รอบเฉลี่ย | ถูกบล็อก | ตัวเลขไม่มีหลักฐาน | เหตุผลซ้ำ |');
lines.push('|---|---|---|---|---|---|---|---|');
const summary: Record<string, { dealRate: number; uplift?: number }> = {};
for (const a of agents) {
  const rs = scenarios.map((s) => results[s.id]![a.id]!);
  const deals = rs.filter((r) => r.deal);
  // เทียบกับ "ไม่เจรจา" เฉพาะสถานการณ์ที่ทั้งสองแบบได้ดีล
  const uplift = avg(scenarios.flatMap((s) => {
    const r = results[s.id]![a.id]!;
    const base = results[s.id]!.opening!;
    return r.deal && base.deal && r.finalNet !== undefined && base.finalNet !== undefined ? [r2(r.finalNet - base.finalNet)] : [];
  }));
  summary[a.id] = { dealRate: deals.length / rs.length, ...(uplift !== undefined ? { uplift } : {}) };
  lines.push(
    `| ${a.th} | ${deals.length}/${rs.length} | ${a.id === 'opening' ? '0.00' : fmt(uplift, true)} | ${fmt(avg(deals.flatMap((r) => r.upliftVsChosenOpening ?? [])), true)} | ${fmt(avg(rs.map((r) => r.rounds)))} | ${rs.reduce((n, r) => n + r.blocks, 0)} | ${rs.reduce((n, r) => n + r.unverified, 0)} | ${rs.reduce((n, r) => n + r.repeated, 0)} |`,
  );
}
lines.push('', '"เพิ่มจาก ไม่เจรจา" = ราคาสุทธิเฉลี่ยทั้งกลุ่มที่ได้เพิ่มจากการรับข้อเสนอแรกที่ดีที่สุด เทียบเฉพาะสถานการณ์ที่ได้ดีลทั้งคู่ · ราคาสุทธิ = หลังค่าขนส่งและส่วนหัก', '');
lines.push('## รายสถานการณ์ (ราคาสุทธิเฉลี่ย บาท/กก. · – = ไม่ได้ดีล)', '');
lines.push(`| สถานการณ์ | ${agents.map((a) => a.id).join(' | ')} |`);
lines.push(`|---|${agents.map(() => '---').join('|')}|`);
for (const s of scenarios) lines.push(`| ${s.id} | ${agents.map((a) => { const r = results[s.id]![a.id]!; return r.error ? `error` : fmt(r.deal ? r.finalNet : undefined); }).join(' | ')} |`);
const strat: Record<string, number> = {};
for (const s of scenarios) for (const [k, v] of Object.entries(results[s.id]!.evidence?.strategies ?? {})) strat[k] = (strat[k] ?? 0) + v;
lines.push('', `กลยุทธ์ที่ AI สำรองใช้ (รวมทุกสถานการณ์): ${Object.entries(strat).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
lines.push('', '> ผลทดสอบจากข้อมูลจำลองและผู้ซื้อจำลอง ไม่ใช่ผลในตลาดจริง');

const report = lines.join('\n');
console.log(report);
const out = opt('out');
if (out) writeFileSync(out, report + '\n');
export { summary };
