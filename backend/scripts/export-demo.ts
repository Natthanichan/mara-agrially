// รัน Agent จริง 3 สถานการณ์ แล้วแปลง trace เป็นข้อมูลสำหรับหน้าเดโม (web/demo-data.json)
//   npm run demo:export
// ทุกตัวเลขบนหน้าเดโมมาจากไฟล์นี้ — ไม่มีการพิมพ์ตัวเลขเองในหน้าเว็บ

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MockBuyerApi } from '../src/buyer/mockBuyer.js';
import { groupListings } from '../src/core/grouping.js';
import { checkPriceFloor, computeNetPerFarmer } from '../src/core/pricing.js';
import type { Crop } from '../src/core/types.js';
import { CROP_LABEL_TH, farmers, listings } from '../src/data/synthetic.js';
import { summarize, NABC_SOURCE_LABEL } from '../src/market/nabcClient.js';
import { loadKnowledgeDir } from '../src/rag/chunker.js';
import { KnowledgeIndex } from '../src/rag/search.js';
import { runNegotiation, type AgentDeps, type AgentResult } from '../src/agent/index.js';
import { RuleBasedMockLlm } from '../src/agent/llm/mock.js';
import type { ContentBlock, LlmClient, LlmRequest } from '../src/agent/llm/types.js';

const DATE = '2026-10-19';
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../test/fixtures/nabc-2026-10-19.json', import.meta.url)), 'utf8'));
const knowledge = new KnowledgeIndex(loadKnowledgeDir(fileURLToPath(new URL('../knowledge', import.meta.url))));
const groups = groupListings(listings, farmers);
const deps = (): AgentDeps => ({
  buyers: new MockBuyerApi(),
  knowledge,
  market: { getReference: async (crop, date, province) => summarize(fixture.data, crop, date, false, province) },
});
let clock = Date.parse('2026-10-21T09:00:00+07:00');
const now = () => new Date((clock += 1400));

/** สถานการณ์ทดสอบระบบป้องกัน: จำลองว่า AI ตัดสินใจผิด 3 ครั้ง (บันทึกชัดเจนในหน้าเดโม) */
function careless(): LlmClient {
  let i = 0;
  let id = 0;
  const sid = (req: LlmRequest) => {
    for (const m of req.messages) for (const b of m.content) if ('toolResult' in b) {
      const j = b.toolResult.content[0].json as { session_id?: string };
      if (j.session_id) return j.session_id;
    }
    return '';
  };
  const t = (name: string, input: Record<string, unknown>): ContentBlock => ({ toolUse: { toolUseId: `c-${++id}`, name, input } });
  const steps: ((r: LlmRequest) => ContentBlock[])[] = [
    () => [{ text: 'แผน (จำลองความผิดพลาด): ขอราคาจากโรงสี A รายเดียว แล้วรีบปิดให้จบเร็ว' }, t('request_quote', { buyer_id: 'B-A' })],
    (r) => [{ text: 'ผู้ซื้อเปิด 15.80 ลองเสนอ 16.50 ให้ใกล้ ๆ จะได้จบเร็ว' }, t('submit_counter', { session_id: sid(r), price_per_kg: 16.5, message: 'ขอ 16.50 บาท/กก. ครับ' })],
    (r) => [{ text: 'โดนบล็อก ลองบอกผู้ซื้อตรง ๆ ว่าสมาชิกรับได้ต่ำสุดเท่าไร' }, t('submit_counter', { session_id: sid(r), price_per_kg: 18.2, message: 'สมาชิกบางคนรับได้ต่ำสุด 17.00 บาท ช่วยให้ 18.20 ได้ไหม' })],
    (r) => [{ text: 'ยังโดนบล็อก งั้นส่งข้อเสนอแรกของโรงสี A ให้เกษตรกรอนุมัติเลย' }, t('prepare_deal_for_approval', { session_id: sid(r), summary_for_farmers: 'แนะนำโรงสี A 15.80 บาท/กก.' })],
    () => [{ text: 'ทุกทางลัดถูกบล็อก ส่งเรื่องให้กลุ่มตัดสินใจ' }, t('escalate_to_farmers', { reason: 'ข้อเสนอของโรงสี A ต่ำกว่าขั้นต่ำของสมาชิก และ AI ไม่สามารถข้ามระบบป้องกันได้' })],
  ];
  return { name: 'scripted:careless-ai-test', converse: async (req) => ({ content: steps[Math.min(i++, steps.length - 1)]!(req) }) };
}

type Step = Record<string, unknown> & { kind: string; at: string };

function toSteps(res: AgentResult): Step[] {
  const steps: Step[] = [];
  const buyerBySession = new Map<string, string>();
  let lastCall: { tool: string; input: Record<string, unknown> } | undefined;
  for (const e of res.trace) {
    const d = e.data as Record<string, any>;
    const at = e.at;
    switch (e.type) {
      case 'plan':
      case 'reasoning':
        steps.push({ kind: e.type, at, text: d.text });
        break;
      case 'tool_call':
        lastCall = { tool: d.tool, input: d.input };
        break;
      case 'buyer_response':
        buyerBySession.set(d.sessionId, d.buyerName);
        steps.push({ kind: 'buyer', at, buyer: d.buyerName, buyerId: d.buyerId, decision: d.decision, price: d.pricePerKg, deductions: d.deductions, message: d.message, round: d.round });
        break;
      case 'counter_sent':
        steps.push({ kind: 'counter', at, buyerId: d.buyerId, price: d.pricePerKg, contest: d.contestDeductions, message: d.message });
        break;
      case 'guardrail_blocked':
        steps.push({ kind: 'blocked', at, buyerId: d.buyerId, code: d.code, reason: d.reason, attemptedPrice: d.attemptedPricePerKg ?? d.pricePerKg });
        break;
      case 'tool_result': {
        const r = d.result as Record<string, any>;
        if (!r || d.ok === false) {
          if (r?.error) steps.push({ kind: 'tool_error', at, tool: d.tool, error: r.error });
          break;
        }
        if (d.tool === 'get_market_price') steps.push({ kind: 'market', at, ...r });
        if (d.tool === 'search_knowledge')
          steps.push({ kind: 'rag', at, query: lastCall?.input.query, mode: r.mode, hits: r.results.map((h: any) => ({ source: h.source, text: h.text.split('\n').slice(1).join(' '), disclaimer: h.disclaimer })) });
        if (d.tool === 'list_buyers') steps.push({ kind: 'buyers', at, buyers: r.buyers });
        const ev = d.tool === 'evaluate_offer' ? r : d.tool === 'submit_counter' ? r.evaluation : undefined;
        if (ev?.sessionId)
          steps.push({ kind: 'evaluation', at, buyer: buyerBySession.get(ev.sessionId), buyerId: ev.buyerId, price: ev.pricePerKg, deductions: ev.deductions, netAvg: ev.netPerKgAvg, netMin: ev.netPerKgMin, passes: ev.passesAllFloors, below: ev.membersBelowFloor, total: ev.totalNetBaht });
        break;
      }
      case 'outcome':
        steps.push({ ...d, outcomeKind: d.kind, kind: 'outcome', at });
        break;
      case 'llm_error':
        steps.push({ kind: 'llm_error', at, error: d.error });
        break;
    }
  }
  return steps;
}

async function scenario(id: string, title: string, crop: Crop, llm: LlmClient, note: string) {
  const group = groups.find((g) => g.crop === crop)!;
  const res = await runNegotiation({ dealId: `D-${id}`, group, farmers, listings, date: DATE }, deps(), llm, { now });
  const ids = new Set(group.members.map((m) => m.farmerId));
  const farmerRows = (terms?: Parameters<typeof computeNetPerFarmer>[1]) => {
    const nets = terms ? computeNetPerFarmer(group.members, terms) : [];
    const pass = terms ? new Set(group.members.map((m) => m.farmerId).filter((fid) => !checkPriceFloor(group.members, listings, terms).violations.some((v) => v.farmerId === fid))) : new Set<string>();
    return group.members.map((m) => {
      const f = farmers.find((x) => x.id === m.farmerId)!;
      const n = nets.find((x) => x.farmerId === m.farmerId);
      return { id: f.id, name: f.name, district: f.district, route: f.routeId, kg: m.quantityKg, account: f.bankAccountMasked, ...(n ? { transportPerKg: n.transportPerKg, otherPerKg: n.otherDeductionsPerKg, netPerKg: n.netPerKg, netTotal: n.netTotal, passesFloor: pass.has(f.id) } : {}) };
    });
  };
  return {
    id,
    title,
    note,
    llm: llm.name,
    status: res.status,
    outcome: res.outcome.kind,
    group: { id: group.id, crop, cropLabel: CROP_LABEL_TH[crop], grade: group.grade, province: group.province, window: group.deliveryWindow, totalKg: group.members.reduce((s, m) => s + m.quantityKg, 0), members: ids.size },
    farmers: farmerRows(res.outcome.kind === 'prepared' ? res.outcome.terms : undefined),
    deal: res.outcome.kind === 'prepared' ? { buyer: res.outcome.buyerName, buyerId: res.outcome.buyerId, price: res.outcome.terms.pricePerKg, deductions: res.outcome.evaluation.deductions, netAvg: res.outcome.evaluation.netPerKgAvg, total: res.outcome.evaluation.totalNetBaht, summary: res.outcome.summary } : undefined,
    reason: res.outcome.kind !== 'prepared' ? res.outcome.reason : undefined,
    metrics: res.metrics,
    steps: toSteps(res),
  };
}

const data = {
  generatedAt: '2026-10-21',
  marketDate: DATE,
  marketSource: NABC_SOURCE_LABEL,
  disclaimer: 'เกษตรกร ผู้ซื้อ และประวัติผู้ซื้อเป็นข้อมูลจำลอง ราคาข้าวและมันสำปะหลังอ้างอิงข้อมูลจริงจาก NABC วันที่ 19 ต.ค. 2569 ตัวเลขผลลัพธ์เป็นผลทดสอบของต้นแบบ ไม่ใช่ผลจริงในตลาด',
  scenarios: [
    await scenario('rice', 'ข้าวหอมมะลิ · ร้อยเอ็ด', 'rice_hommali', new RuleBasedMockLlm(), 'Agent เทียบผู้ซื้อ 3 ราย ด้วยราคาสุทธิ จับค่าหักความชื้นแฝง แล้วเตรียมดีลให้เกษตรกรอนุมัติ'),
    await scenario('gourd', 'มะระจีน · ราชบุรี', 'bitter_gourd', new RuleBasedMockLlm(), 'ผู้ซื้อรายเดียวให้ราคาสุทธิไม่ถึงขั้นต่ำของสมาชิกบางคน Agent จึงส่งเรื่องให้กลุ่มตัดสินใจแทนการฝืนปิดดีล'),
    await scenario('guard', 'ทดสอบระบบป้องกัน', 'rice_hommali', careless(), 'จำลองว่า AI ตัดสินใจผิด 3 ครั้ง: เสนอต่ำกว่าขั้นต่ำ บอกราคาขั้นต่ำให้ผู้ซื้อ และพยายามส่งดีลที่ไม่ผ่านให้อนุมัติ ระบบบล็อกทุกครั้ง'),
  ],
};

const out = fileURLToPath(new URL('../../web/demo-data.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../../web/', import.meta.url)), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 1));
for (const s of data.scenarios) console.log(`${s.id}: ${s.status} (${s.outcome}) steps=${s.steps.length} blocks=${s.metrics.guardrailBlocks}`);

// สร้างหน้าเดโม: ฝังข้อมูลลงใน template (กัน </script> ในข้อมูลด้วยการ escape "<")
const tplPath = fileURLToPath(new URL('../../web/index.template.html', import.meta.url));
const html = readFileSync(tplPath, 'utf8').replace('__DEMO_DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'));
writeFileSync(fileURLToPath(new URL('../../web/index.html', import.meta.url)), html);
console.log('web/index.html สร้างแล้ว');
