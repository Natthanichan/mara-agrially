// Tools ที่ Agent เรียกใช้ได้ — ทุก tool เป็นโค้ด deterministic
// LLM เลือกว่าจะเรียกอะไร แต่ "ผล" มาจากโค้ดเสมอ (ราคาสุทธิ, floor, การส่งข้อเสนอ)
// ไม่มี tool สำหรับปิดดีล: Agent ทำได้แค่ prepare_deal_for_approval แล้วรอเกษตรกรอนุมัติ

import { MockBuyerApi, MockBuyerError, type BuyerResponse } from '../buyer/mockBuyer.js';
import { checkPriceFloor } from '../core/pricing.js';
import { activeMembers } from '../core/grouping.js';
import type { Deduction, DealTerms, Farmer, Group, Listing } from '../core/types.js';
import type { MarketReference } from '../market/nabcClient.js';
import type { KnowledgeIndex } from '../rag/search.js';
import { checkCounterPrice, checkMessageLeak, extractNumbers, numbersNeedingEvidence, type GuardrailViolation } from './guardrails.js';
import { dateNumbers, EvidenceRegistry, STRATEGIES, thaiDay, unverifiedNumbers, type Evidence, type Strategy } from './evidence.js';
import { CROP_LABEL_TH } from '../data/synthetic.js';
import type { ToolSpec } from './llm/types.js';
import { planTrips } from './transport.js';

export interface MarketProvider {
  getReference(crop: Group['crop'], date: string, province?: string): Promise<MarketReference | undefined>;
}

/** ผลการเจรจาที่ระบบเคยบันทึกไว้กับผู้ซื้อรายหนึ่ง (จากดีลก่อน ๆ) */
export interface HistoryRecord {
  dealId: string;
  at: string;
  openingPerKg: number;
  finalPerKg: number;
  decision: string;
  chosen: boolean;
}

export interface HistoryProvider {
  forBuyer(buyerId: string, crop: Group['crop']): Promise<HistoryRecord[]>;
}

export interface AgentDeps {
  buyers: MockBuyerApi;
  market: MarketProvider;
  knowledge: KnowledgeIndex;
  /** ประวัติการเจรจาจริงในระบบ (ไม่บังคับ — ถ้าไม่มี tool จะตอบว่ายังไม่มีประวัติ) */
  history?: HistoryProvider;
}

export interface NegotiationInput {
  dealId: string;
  group: Group;
  farmers: Farmer[];
  listings: Listing[];
  /** วันที่ใช้ดึงราคาตลาด (YYYY-MM-DD) */
  date: string;
  maxRoundsPerBuyer?: number;
}

export interface BuyerSession {
  sessionId: string;
  buyerId: string;
  buyerName: string;
  last: BuyerResponse;
  rounds: number;
  history: BuyerResponse[];
  /** ผู้ซื้อถอนตัว/ปิดรอบ */
  closed: boolean;
  /** กลยุทธ์และหลักฐานที่ใช้แต่ละรอบ (ไว้เตือนเมื่อใช้เหตุผลซ้ำ) */
  moves: { strategy: Strategy; evidenceIds: string[] }[];
}

export type Terminal =
  | { kind: 'prepared'; sessionId: string; buyerId: string; buyerName: string; terms: DealTerms; summary: string; evaluation: OfferEvaluation }
  | { kind: 'escalated'; reason: string };

export interface OfferEvaluation {
  sessionId: string;
  buyerId: string;
  buyerDecision: BuyerResponse['decision'];
  pricePerKg: number;
  deductions: string[];
  passesAllFloors: boolean;
  membersBelowFloor: number;
  netPerKgMin: number;
  netPerKgMax: number;
  /** ราคาสุทธิเฉลี่ยถ่วงน้ำหนักทั้งกลุ่ม */
  netPerKgAvg: number;
  totalNetBaht: number;
  /** ราคาเสนอต่ำสุดที่ทุกคนผ่านขั้นต่ำ ภายใต้ส่วนหักของผู้ซื้อรายนี้ — ข้อมูลภายใน ห้ามบอกผู้ซื้อ */
  minGrossPriceToPassAll: number;
}

export type TraceFn = (type: string, data: Record<string, unknown>) => void;

const r2 = (n: number) => Math.round(n * 100) / 100;

const describeDeduction = (d: Deduction) =>
  d.kind === 'percent' ? `${d.label} ${d.percent}%` : d.kind === 'per_kg' ? `${d.label} ${d.amountPerKg} บาท/กก.` : `${d.label} ${d.amount} บาท`;

export class NegotiationState {
  readonly sessions = new Map<string, BuyerSession>();
  readonly violations: GuardrailViolation[] = [];
  /** จำนวนครั้งที่ค้นความรู้ไปแล้ว (จำกัดไว้ ไม่งั้นโมเดลค้นวนจนหมดขั้นก่อนได้เจรจา) */
  searches = 0;
  /** กันส่งเรื่องให้เกษตรกรก่อนลองต่อรอง — บล็อกได้ครั้งเดียว (ไม่ให้วนจนหมดขั้น) */
  escalateBlocked = false;
  terminal?: Terminal;
  market?: MarketReference | null;
  readonly members;
  readonly trips;
  readonly maxRoundsPerBuyer: number;
  readonly evidence = new EvidenceRegistry();
  /** จำนวนครั้งที่ใช้แต่ละกลยุทธ์ (ตัวชี้วัด) */
  readonly strategyCounts: Partial<Record<Strategy, number>> = {};
  /** ใช้เหตุผลชุดเดิมซ้ำกับผู้ซื้อรายเดิมกี่ครั้ง (ตัวชี้วัด) */
  repeatedMoves = 0;

  constructor(readonly input: NegotiationInput) {
    this.members = activeMembers(input.group).map((m) => ({ farmerId: m.farmerId, quantityKg: m.quantityKg }));
    this.trips = planTrips(this.members, input.farmers);
    this.maxRoundsPerBuyer = input.maxRoundsPerBuyer ?? 5;
    this.addBaseEvidence();
  }

  /** ข้อเท็จจริงของกลุ่มที่มีตั้งแต่ต้น (จากข้อมูลที่เกษตรกรลงทะเบียน — ไม่มีราคาขั้นต่ำ) */
  private addBaseEvidence() {
    const g = this.input.group;
    const src = 'ข้อมูลกลุ่มที่เกษตรกรลงทะเบียน';
    const routes = new Set(this.trips.map((t) => t.id)).size;
    const [from, to] = [g.deliveryWindow.from, g.deliveryWindow.to];
    const day = (iso: string) => Number(iso.slice(8, 10));
    this.evidence.add({ id: 'E-VOL', kind: 'volume', label: `ปริมาณรวม ${this.totalKg.toLocaleString('en-US')} กก. (${(this.totalKg / 1000).toLocaleString('en-US')} ตัน) จาก ${this.members.length} ราย ส่งเป็นล็อตเดียว`, say: `กลุ่มเรามีปริมาณรวม ${this.totalKg.toLocaleString('en-US')} กก. ส่งเป็นล็อตเดียว`, value: this.totalKg, unit: 'กก.', verified: true, source: src, tag: 'volume', extraNumbers: [this.members.length] });
    this.evidence.add({ id: 'E-GRADE', kind: 'grade', label: `${CROP_LABEL_TH[g.crop]} เกรด ${g.grade} ทุกราย (ตามที่เกษตรกรแจ้ง ยังไม่ได้ตรวจโดยบุคคลที่สาม)`, say: `ผลผลิตเกรด ${g.grade} ทุกราย ยินดีให้ตรวจคุณภาพก่อนรับ`, verified: true, source: src, tag: 'quality_grade' });
    this.evidence.add({ id: 'E-DELIVERY', kind: 'delivery', label: `ส่งมอบได้ ${thaiDay(from)}${from === to ? '' : ` – ${thaiDay(to)}`} ${from.slice(0, 4)}`, say: 'ส่งมอบได้ตามช่วงที่ตกลง พร้อมนัดวันชัดเจน', verified: true, source: src, tag: 'delivery_ready', extraNumbers: [day(from), day(to), Number(from.slice(0, 4)), Number(from.slice(0, 4)) + 543] });
    this.evidence.add({ id: 'E-LOGISTICS', kind: 'logistics', label: `จัดรถรวม ${this.trips.length} เที่ยว จาก ${routes} เส้นทาง (ผู้ซื้อไม่ต้องรับทีละแปลง)`, say: 'เราจัดรถรวมส่งให้ ผู้ซื้อไม่ต้องรับทีละแปลง', value: this.trips.length, verified: true, source: 'แผนขนส่งของระบบ', tag: 'consolidated_logistics', extraNumbers: [routes] });
  }

  /** บันทึกข้อเสนอของผู้ซื้อเป็นหลักฐาน และอัปเดตหลักฐาน "ข้อเสนอของรายอื่น" */
  recordOffer(s: BuyerSession, r: BuyerResponse): Evidence {
    const extra = [r.paymentTermDays, ...r.deductions.map((d) => (d.kind === 'percent' ? d.percent : d.kind === 'per_kg' ? d.amountPerKg : d.amount))];
    const e = this.evidence.add({ id: `E-OFFER-${s.buyerId}-${r.round}`, kind: 'buyer_offer', label: `${s.buyerName} รอบ ${r.round}: ${r.pricePerKg.toFixed(2)} บาท/กก.${r.deductions.length ? ` (${r.deductions.map(describeDeduction).join(', ')})` : ''}`, value: r.pricePerKg, verified: true, source: 'ข้อเสนอของผู้ซื้อในการเจรจานี้', extraNumbers: [...extra, r.round] });
    this.refreshCompetition();
    return e;
  }

  /** หลักฐาน "ข้อเสนอของรายอื่น" ที่อ้างกับผู้ซื้อรายนี้ได้จริง (รายอื่นให้ราคาสุทธิสูงกว่า) */
  leverageFor(s: BuyerSession): Evidence[] {
    const own = this.evaluate(s).netPerKgAvg;
    return [...this.sessions.values()]
      .filter((o) => o !== s && o.last.decision !== 'walk_away' && this.evaluate(o).netPerKgAvg > own)
      .flatMap((o) => this.evidence.get(`E-COMP-${o.buyerId}`) ?? []);
  }

  /** ข้อเสนอปัจจุบันของผู้ซื้อแต่ละรายใช้อ้างกับรายอื่นได้ (ห้ามระบุชื่อ เพื่อไม่ละเมิดความลับทางการค้า) */
  refreshCompetition() {
    for (const s of this.sessions.values()) {
      const id = `E-COMP-${s.buyerId}`;
      if (s.last.decision === 'walk_away') {
        this.evidence.remove(id);
        continue;
      }
      const ev = this.evaluate(s);
      this.evidence.add({
        id,
        kind: 'competing',
        label: `มีผู้ซื้อรายอื่นเสนอ ${ev.pricePerKg.toFixed(2)} บาท/กก.${ev.deductions.length ? ` (${ev.deductions.join(', ')})` : ''} ราคาสุทธิเฉลี่ย ${ev.netPerKgAvg.toFixed(2)} บาท/กก. — อ้างได้กับผู้ซื้อที่ให้ราคาสุทธิต่ำกว่านี้เท่านั้น`,
        say: `ตอนนี้มีผู้ซื้อรายอื่นเสนอ ${ev.pricePerKg.toFixed(2)} บาท/กก.${ev.deductions.length ? ` (${ev.deductions.join(', ')})` : ''}`,
        value: ev.pricePerKg,
        verified: true,
        source: 'ข้อเสนอจริงในการเจรจานี้',
        tag: 'competing_offer',
        excludeBuyerId: s.buyerId,
        extraNumbers: [ev.netPerKgAvg],
      });
    }
  }

  get totalKg() {
    return this.members.reduce((s, m) => s + m.quantityKg, 0);
  }

  floors() {
    const ids = new Set(this.members.map((m) => m.farmerId));
    return this.input.listings.filter((l) => ids.has(l.farmerId)).map((l) => ({ farmerId: l.farmerId, floorPricePerKg: l.floorPricePerKg }));
  }

  termsOf(r: Pick<BuyerResponse, 'pricePerKg' | 'deductions'>): DealTerms {
    return { pricePerKg: r.pricePerKg, deductions: r.deductions, trips: this.trips };
  }

  evaluate(s: BuyerSession, override?: Partial<Pick<BuyerResponse, 'pricePerKg' | 'deductions'>>): OfferEvaluation {
    const r = { ...s.last, ...override };
    const check = checkPriceFloor(this.members, this.floors(), this.termsOf(r));
    const nets = check.nets.map((n) => n.netPerKg);
    const total = check.nets.reduce((t, n) => t + n.netTotal, 0);
    return {
      sessionId: s.sessionId,
      buyerId: s.buyerId,
      buyerDecision: s.last.decision,
      pricePerKg: r.pricePerKg,
      deductions: r.deductions.map(describeDeduction),
      passesAllFloors: check.passes,
      membersBelowFloor: check.violations.length,
      netPerKgMin: Math.min(...nets),
      netPerKgMax: Math.max(...nets),
      netPerKgAvg: r2(total / this.totalKg),
      totalNetBaht: r2(total),
      minGrossPriceToPassAll: check.minGrossPriceToPassAll,
    };
  }

  /** ตัวเลขสาธารณะที่ได้จาก tool อยู่แล้ว (ราคาตลาด, ราคาที่ผู้ซื้อเสนอ, ปริมาณ) — พูดถึงได้ ไม่ถือว่าหลุด */
  publicNumbers(to?: BuyerSession): number[] {
    const nums = [this.totalKg];
    if (this.market) {
      nums.push(this.market.minPerKg, this.market.maxPerKg, this.market.medianPerKg, ...this.market.provinceQuotes.map((q) => q.pricePerKg));
    }
    // ข้อเสนอของผู้ซื้อรายนี้เองยกเว้นได้ (เขาพูดเอง) ส่วนข้อเสนอของรายอื่นไม่ยกเว้น
    for (const s of this.sessions.values()) if (!to || s === to) nums.push(...s.history.map((h) => h.pricePerKg));
    // ไม่ยกเว้น: ความรู้จำลอง (RAG) และข้อเสนอของผู้ซื้อรายอื่น — ถ้าตัวเลขบังเอิญตรงกับราคาขั้นต่ำ ให้บล็อกไว้ก่อน
    // (ผู้ซื้อไม่ควรได้รับตัวเลขใดที่ตรงกับราคาขั้นต่ำเลย ไม่ว่าตัวเลขนั้นจะมาจากไหน)
    const fromEvidence = new EvidenceRegistry();
    for (const e of this.evidence.list()) {
      if (e.kind === 'knowledge' || e.kind === 'competing') continue;
      if (to && e.kind === 'buyer_offer' && !e.id.startsWith(`E-OFFER-${to.buyerId}-`)) continue;
      fromEvidence.add(e);
    }
    return [...nums, ...fromEvidence.numbers(false)];
  }

  /** ตัวเลขที่ห้ามหลุดไปถึงผู้ซื้อ */
  privateNumbers(): number[] {
    const nums = this.floors().map((f) => f.floorPricePerKg);
    for (const s of this.sessions.values()) nums.push(this.evaluate(s).minGrossPriceToPassAll);
    return nums;
  }
}

/** ค้นความรู้ได้กี่ครั้งต่อการเจรจา 1 ดีล */
export const MAX_KNOWLEDGE_SEARCHES = 3;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_market_price',
    description: 'ดูราคาอ้างอิงตลาดจริงของพืชในกลุ่ม (ศูนย์ข้อมูล NABC) ได้ราคาต่ำสุด สูงสุด ค่ากลาง และราคาในจังหวัดเดียวกัน ถ้าไม่มีข้อมูล (เช่น มะระ) ให้ใช้ search_knowledge แทน',
    inputSchema: { json: { type: 'object', properties: {} } },
  },
  {
    name: 'search_knowledge',
    description: 'ค้นความรู้: ประวัติผู้ซื้อ กติกาหักความชื้น เกรด และแนวทางการเจรจา คืนข้อความพร้อมแหล่งที่มา',
    inputSchema: {
      json: {
        type: 'object',
        properties: { query: { type: 'string', description: 'คำถามหรือคำค้นภาษาไทย' }, buyer_id: { type: 'string', description: 'กรองเฉพาะผู้ซื้อ เช่น B-C (ไม่บังคับ)' } },
        required: ['query'],
      },
    },
  },
  {
    name: 'get_negotiation_history',
    description: 'ดูผลการเจรจาที่ระบบเคยบันทึกไว้กับผู้ซื้อรายนี้ (ราคาเปิด ราคาสุดท้าย ผล) ถ้ามี จะได้หลักฐาน E-HIST ไว้อ้าง ถ้าไม่มีประวัติ ห้ามอ้างว่าเคยซื้อขายกัน',
    inputSchema: { json: { type: 'object', properties: { buyer_id: { type: 'string' } }, required: ['buyer_id'] } },
  },
  {
    name: 'list_buyers',
    description: 'รายชื่อผู้ซื้อที่รับพืช เกรด และปริมาณของกลุ่มนี้',
    inputSchema: { json: { type: 'object', properties: {} } },
  },
  {
    name: 'request_quote',
    description: 'ขอใบเสนอราคาเริ่มต้นจากผู้ซื้อ 1 ราย ได้ session_id สำหรับเจรจาต่อ',
    inputSchema: { json: { type: 'object', properties: { buyer_id: { type: 'string' } }, required: ['buyer_id'] } },
  },
  {
    name: 'evaluate_offer',
    description: 'คำนวณราคาสุทธิหลังหักค่าขนส่งและส่วนหักทั้งหมด และตรวจว่าสมาชิกทุกคนผ่านราคาขั้นต่ำหรือไม่ ใช้ทุกครั้งก่อนตัดสินใจ ห้ามคำนวณเอง',
    inputSchema: { json: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } },
  },
  {
    name: 'submit_counter',
    description:
      'ยื่นข้อเสนอโต้กลับให้ผู้ซื้อ 1 รอบ: เลือกกลยุทธ์ เหตุผลสั้น ๆ หลักฐานที่อ้าง (evidence_ids จากผล tool) ราคาต่อกก. และข้อความภาษาไทยถึงผู้ซื้อ ' +
      'ผู้ซื้อตัดสินใจจาก "หลักฐาน" ที่อ้าง ไม่ใช่คำพูด — หลักฐานที่ตรงข้อกังวลของผู้ซื้อมีน้ำหนักมากที่สุด เหตุผลซ้ำมีน้ำหนักน้อยลง ' +
      'ตัวเลขในข้อความต้องมาจากหลักฐานหรือราคาที่เสนอเท่านั้น ห้ามใส่ราคาขั้นต่ำ ระบบจะบล็อกราคาที่ต่ำกว่าขั้นต่ำ',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          strategy: { type: 'string', enum: [...STRATEGIES], description: 'กลยุทธ์ของรอบนี้' },
          rationale: { type: 'string', description: 'เหตุผลสั้น ๆ 1–2 ประโยคว่าทำไมเลือกกลยุทธ์และราคานี้ (แสดงบนหน้าเว็บ ไม่ส่งให้ผู้ซื้อ)' },
          evidence_ids: { type: 'array', items: { type: 'string' }, description: 'รหัสหลักฐานที่อ้าง เช่น ["E-MKT-MEDIAN","E-VOL"]' },
          price_per_kg: { type: 'number' },
          contest_deductions: { type: 'array', items: { type: 'string' } },
          message: { type: 'string', description: 'ข้อความถึงผู้ซื้อ ตอบข้อโต้แย้งล่าสุดของผู้ซื้อด้วยหลักฐานที่อ้าง' },
        },
        required: ['session_id', 'strategy', 'rationale', 'evidence_ids', 'price_per_kg', 'message'],
      },
    },
  },
  {
    name: 'prepare_deal_for_approval',
    description:
      'เตรียมข้อเสนอที่ดีที่สุดให้เกษตรกรอนุมัติ (Agent ปิดดีลเองไม่ได้) ใช้เมื่อผู้ซื้อตกลงหรือยื่นข้อเสนอสุดท้ายที่ผ่านขั้นต่ำทุกคน และดีกว่ารายอื่นแล้ว',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          summary_for_farmers: { type: 'string', description: 'สรุปภาษาง่ายสำหรับเกษตรกร: ทำไมเลือกผู้ซื้อรายนี้ เทียบกับรายอื่นและราคาตลาด' },
        },
        required: ['session_id', 'summary_for_farmers'],
      },
    },
  },
  {
    name: 'escalate_to_farmers',
    description: 'หยุดเจรจาและส่งเรื่องให้กลุ่มตัดสินใจ เมื่อไม่มีข้อเสนอใดผ่านขั้นต่ำทุกคน หรือข้อมูลไม่พอ',
    inputSchema: { json: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
  },
];

export const TOOL_NAMES = new Set(TOOL_SPECS.map((t) => t.name));

export class ToolError extends Error {}

const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`ต้องระบุ ${name}`);
  return v.trim();
};

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  st: NegotiationState,
  deps: AgentDeps,
  trace: TraceFn,
): Promise<unknown> {
  const { group } = st.input;
  const session = (id: unknown) => {
    const s = st.sessions.get(str(id, 'session_id'));
    if (!s) throw new ToolError(`ไม่พบ session ${String(id)} — ใช้ request_quote ก่อน`);
    return s;
  };

  switch (name) {
    case 'get_market_price': {
      const ref = await deps.market.getReference(group.crop, st.input.date, group.province);
      st.market = ref ?? null;
      if (!ref) return { available: false, note: 'ไม่มีราคาอ้างอิงจาก NABC สำหรับพืชนี้ ห้ามอ้างราคาตลาดเป็นตัวเลข ใช้หลักฐานอื่น (ปริมาณ คุณภาพ การส่งมอบ ข้อเสนอของรายอื่น)' };
      const src = `${ref.source} ${ref.date}${ref.stale ? ' (ข้อมูลวันก่อนหน้า)' : ''}`;
      const added = [
        st.evidence.add({ id: 'E-MKT-MEDIAN', kind: 'market', label: `ราคากลางตลาด (NABC) ${ref.medianPerKg.toFixed(2)} บาท/กก. ช่วง ${ref.minPerKg.toFixed(2)}–${ref.maxPerKg.toFixed(2)} จาก ${ref.quotes.length} แหล่ง ${src}`, say: `ราคากลางตลาดจาก NABC อยู่ที่ ${ref.medianPerKg.toFixed(2)} บาท/กก.`, value: ref.medianPerKg, verified: true, source: src, tag: 'market_reference', extraNumbers: [ref.minPerKg, ref.maxPerKg, ref.quotes.length, ...dateNumbers(ref.date)] }),
        ...ref.provinceQuotes.slice(0, 3).map((q, i) =>
          st.evidence.add({ id: `E-MKT-LOCAL-${i + 1}`, kind: 'market', label: `ราคาที่ ${q.market} (${q.province}) ${q.pricePerKg.toFixed(2)} บาท/กก. ${src}`, say: `ราคาในจังหวัด ${q.province} จาก NABC อยู่ที่ ${q.pricePerKg.toFixed(2)} บาท/กก.`, value: q.pricePerKg, verified: true, source: src, tag: 'market_reference', extraNumbers: dateNumbers(ref.date) }),
        ),
      ];
      return {
        evidence: st.evidence.brief(added),
        available: true,
        source: ref.source,
        date: ref.date,
        stale: ref.stale,
        minPerKg: ref.minPerKg,
        maxPerKg: ref.maxPerKg,
        medianPerKg: ref.medianPerKg,
        sameProvince: ref.provinceQuotes.map((q) => ({ market: q.market, pricePerKg: q.pricePerKg })),
        sampleCount: ref.quotes.length,
      };
    }

    case 'search_knowledge': {
      if (st.searches >= MAX_KNOWLEDGE_SEARCHES) {
        throw new ToolError(`ค้นความรู้ครบ ${MAX_KNOWLEDGE_SEARCHES} ครั้งแล้ว ให้ใช้ข้อมูลที่ได้ไปต่อ: ขอใบเสนอราคา ประเมิน และเจรจาได้เลย`);
      }
      st.searches += 1;
      const buyer = typeof input.buyer_id === 'string' && input.buyer_id ? input.buyer_id : undefined;
      const r = deps.knowledge.search(str(input.query, 'query'), { topK: 3, filter: { crop: group.crop, ...(buyer ? { buyer } : {}) } });
      const added = r.hits.map((h, i) =>
        st.evidence.add({ id: `E-KB-${st.searches}-${i + 1}`, kind: 'knowledge', label: `${h.source} › ${h.heading}`, verified: false, source: h.source, extraNumbers: extractNumbers(h.text) }),
      );
      return { mode: r.mode, evidence: st.evidence.brief(added), results: r.hits.map((h, i) => ({ evidence_id: added[i]!.id, source: `${h.source} › ${h.heading}`, text: h.text, disclaimer: h.disclaimer })) };
    }

    case 'get_negotiation_history': {
      const buyerId = str(input.buyer_id, 'buyer_id');
      const records = (await deps.history?.forBuyer(buyerId, group.crop)) ?? [];
      if (!records.length) return { buyer_id: buyerId, records: [], note: 'ยังไม่มีประวัติการเจรจากับผู้ซื้อรายนี้ในระบบ ห้ามอ้างว่าเคยซื้อขายกัน' };
      const last = records[0]!;
      const e = st.evidence.add({
        id: `E-HIST-${buyerId}`,
        kind: 'history',
        label: `ครั้งล่าสุดที่ระบบบันทึก (${last.at.slice(0, 10)}) ผู้ซื้อรายนี้ให้ราคาสุดท้าย ${last.finalPerKg.toFixed(2)} บาท/กก.`,
        say: last.chosen && last.decision === 'accept' ? `ครั้งก่อนเราตกลงกันที่ ${last.finalPerKg.toFixed(2)} บาท/กก.` : `ครั้งก่อนท่านให้ราคาสุดท้ายที่ ${last.finalPerKg.toFixed(2)} บาท/กก.`,
        value: last.finalPerKg,
        verified: true,
        source: 'บันทึกการเจรจาในระบบ',
        tag: 'buyer_history',
        extraNumbers: [...records.flatMap((r) => [r.openingPerKg, r.finalPerKg]), ...dateNumbers(last.at)],
      });
      return { buyer_id: buyerId, evidence: st.evidence.brief([e]), records: records.slice(0, 5) };
    }

    case 'list_buyers': {
      return { buyers: deps.buyers.listBuyers(group.crop, group.grade, st.totalKg) };
    }

    case 'request_quote': {
      const buyerId = str(input.buyer_id, 'buyer_id');
      const existing = [...st.sessions.values()].find((s) => s.buyerId === buyerId);
      if (existing) return { note: 'มีใบเสนอราคาจากผู้ซื้อรายนี้แล้ว', session_id: existing.sessionId, offer: existing.last };
      let res: BuyerResponse;
      try {
        res = deps.buyers.requestQuote(buyerId, {
          groupId: group.id,
          crop: group.crop,
          grade: group.grade,
          quantityKg: st.totalKg,
          deliveryWindow: group.deliveryWindow,
        });
      } catch (e) {
        if (e instanceof MockBuyerError) throw new ToolError(e.message);
        throw e;
      }
      const name = deps.buyers.listBuyers(group.crop, group.grade, st.totalKg).find((b) => b.id === buyerId)?.name ?? buyerId;
      const sess: BuyerSession = { sessionId: res.sessionId, buyerId, buyerName: name, last: res, rounds: 0, history: [res], closed: false, moves: [] };
      st.sessions.set(res.sessionId, sess);
      const offerEv = st.recordOffer(sess, res);
      trace('buyer_response', { ...res, buyerName: name });
      return { session_id: res.sessionId, buyer: name, decision: res.decision, pricePerKg: res.pricePerKg, deductions: res.deductions.map(describeDeduction), paymentTermDays: res.paymentTermDays, message: res.message, evidence: st.evidence.brief([offerEv]) };
    }

    case 'evaluate_offer': {
      const s = session(input.session_id);
      const leverage = st.leverageFor(s);
      return { ...st.evaluate(s), ...(leverage.length ? { leverage: st.evidence.brief(leverage) } : {}) };
    }

    case 'submit_counter': {
      const s = session(input.session_id);
      if (s.closed) throw new ToolError('ผู้ซื้อรายนี้ปิดการเจรจาแล้ว');
      const price = Number(input.price_per_kg);
      const message = typeof input.message === 'string' ? input.message : '';
      const contest = Array.isArray(input.contest_deductions) ? input.contest_deductions.filter((x): x is string => typeof x === 'string') : [];
      const strategy = input.strategy as Strategy;
      if (!STRATEGIES.includes(strategy)) throw new ToolError(`strategy ต้องเป็นหนึ่งใน ${STRATEGIES.join(', ')}`);
      const rationale = str(input.rationale, 'rationale').slice(0, 300);
      const evidenceIds = [...new Set((Array.isArray(input.evidence_ids) ? input.evidence_ids : []).filter((x): x is string => typeof x === 'string'))];
      const unknown = evidenceIds.filter((id) => !st.evidence.get(id));
      if (unknown.length) {
        throw new ToolError(`ไม่พบหลักฐาน ${unknown.join(', ')} — อ้างได้เฉพาะ: ${st.evidence.list().map((e) => e.id).join(', ')}`);
      }
      // อ้างข้อเสนอของรายอื่นได้เฉพาะเมื่อดีกว่าจริง (ราคาสุทธิสูงกว่า) และไม่ใช่ข้อเสนอของผู้ซื้อรายนี้เอง
      const ownEval = st.evaluate(s);
      for (const id of evidenceIds) {
        const e = st.evidence.get(id)!;
        if (e.kind !== 'competing') continue;
        const other = [...st.sessions.values()].find((x) => x.buyerId === e.excludeBuyerId);
        if (e.excludeBuyerId === s.buyerId || !other || st.evaluate(other).netPerKgAvg <= ownEval.netPerKgAvg) {
          throw new ToolError(`อ้าง ${id} กับผู้ซื้อรายนี้ไม่ได้ เพราะข้อเสนอนั้นไม่ได้ให้ราคาสุทธิดีกว่าข้อเสนอของรายนี้ (ห้ามหลอกผู้ซื้อ)`);
        }
      }

      // floor ภายใต้ส่วนหักปัจจุบัน (ระมัดระวัง: ยังไม่นับส่วนหักที่ขอลด เพราะผู้ซื้ออาจไม่ยอม)
      const allowed = [price, ...st.publicNumbers(s)];
      let violation =
        checkCounterPrice({
          pricePerKg: price,
          minGrossPriceToPassAll: ownEval.minGrossPriceToPassAll,
          buyerCurrentPerKg: s.last.pricePerKg,
          roundsUsed: s.rounds,
          maxRounds: st.maxRoundsPerBuyer,
        }) ?? checkMessageLeak(message, st.privateNumbers(), allowed);
      if (!violation) {
        const bad = unverifiedNumbers(numbersNeedingEvidence(message), [...allowed, ...st.evidence.numbers()]);
        if (bad.length) {
          violation = { code: 'unverified_number', message: `ข้อความมีตัวเลข ${bad.join(', ')} ที่ไม่มีในหลักฐาน ห้ามแต่งตัวเลข ใช้เฉพาะตัวเลขจากหลักฐานที่อ้าง หรือเขียนโดยไม่ระบุตัวเลข` };
        }
      }
      if (violation) {
        st.violations.push(violation);
        trace('guardrail_blocked', { buyerId: s.buyerId, attemptedPricePerKg: price, code: violation.code, reason: violation.message, strategy });
        return { blocked: true, code: violation.code, reason: violation.message };
      }

      const prevMove = s.moves.at(-1);
      const repeated = !!prevMove && prevMove.strategy === strategy && prevMove.evidenceIds.join() === [...evidenceIds].sort().join();
      if (repeated) st.repeatedMoves += 1;
      s.moves.push({ strategy, evidenceIds: [...evidenceIds].sort() });
      st.strategyCounts[strategy] = (st.strategyCounts[strategy] ?? 0) + 1;

      let res: BuyerResponse;
      try {
        res = deps.buyers.submitCounter(s.sessionId, { pricePerKg: price, contestDeductions: contest, message, arguments: st.evidence.claims(evidenceIds) });
      } catch (e) {
        if (e instanceof MockBuyerError) {
          s.closed = true;
          throw new ToolError(e.message);
        }
        throw e;
      }
      const cited = evidenceIds.map((id) => st.evidence.get(id)!);
      trace('counter_sent', {
        buyerId: s.buyerId,
        pricePerKg: price,
        contestDeductions: contest,
        message,
        strategy,
        rationale,
        evidence: cited.map((e) => ({ id: e.id, label: e.label, verified: e.verified })),
        round: s.rounds + 1,
      });
      s.rounds += 1;
      s.last = res;
      s.history.push(res);
      if (res.decision === 'walk_away' || res.decision === 'accept') s.closed = true;
      const offerEv = st.recordOffer(s, res);
      trace('buyer_response', { ...res, buyerName: s.buyerName });
      return {
        buyer: s.buyerName,
        decision: res.decision,
        pricePerKg: res.pricePerKg,
        deductions: res.deductions.map(describeDeduction),
        message: res.message,
        ...(res.objection ? { objection: res.objection } : {}),
        ...(res.acknowledged ? { acknowledged: res.acknowledged } : {}),
        ...(repeated ? { warning: 'ใช้กลยุทธ์และหลักฐานชุดเดิมกับรอบก่อน ผู้ซื้อให้น้ำหนักน้อยลง ลองตอบข้อโต้แย้งล่าสุดด้วยหลักฐานอื่น' } : {}),
        roundsUsed: s.rounds,
        roundsLeft: Math.max(0, st.maxRoundsPerBuyer - s.rounds),
        evidence: st.evidence.brief([offerEv]),
        ...(st.leverageFor(s).length ? { leverage: st.evidence.brief(st.leverageFor(s)) } : {}),
        evaluation: st.evaluate(s),
      };
    }

    case 'prepare_deal_for_approval': {
      const s = session(input.session_id);
      if (s.last.decision === 'walk_away') throw new ToolError('ผู้ซื้อรายนี้ถอนตัวแล้ว เตรียมดีลไม่ได้');
      const ev = st.evaluate(s);
      if (!ev.passesAllFloors) {
        const v: GuardrailViolation = { code: 'below_floor', message: 'ข้อเสนอนี้ทำให้สมาชิกบางคนได้สุทธิต่ำกว่าขั้นต่ำ เตรียมให้อนุมัติไม่ได้' };
        st.violations.push(v);
        trace('guardrail_blocked', { buyerId: s.buyerId, code: v.code, reason: v.message, pricePerKg: ev.pricePerKg });
        return { blocked: true, code: v.code, reason: v.message };
      }
      const summary = str(input.summary_for_farmers, 'summary_for_farmers');
      st.terminal = { kind: 'prepared', sessionId: s.sessionId, buyerId: s.buyerId, buyerName: s.buyerName, terms: st.termsOf(s.last), summary, evaluation: ev };
      deps.buyers.close(s.sessionId);
      for (const other of st.sessions.values()) if (other !== s) deps.buyers.close(other.sessionId);
      return { prepared: true, status: 'pending_approval', note: 'ส่งให้เกษตรกรอนุมัติแล้ว Agent จบงานรอบนี้' };
    }

    case 'escalate_to_farmers': {
      // เจอจริงบน Nova: ขอใบเสนอราคาแล้วส่งเรื่องเลยโดยไม่ต่อรองสักครั้ง ทั้งที่ผู้ซื้อยังขยับราคา/ส่วนหักได้
      const untried = [...st.sessions.values()].filter((x) => !x.closed && x.rounds === 0 && st.maxRoundsPerBuyer > 0);
      if (untried.length && !st.escalateBlocked) {
        st.escalateBlocked = true;
        throw new ToolError(
          `ยังส่งเรื่องให้เกษตรกรไม่ได้ เพราะยังไม่ได้ต่อรองกับผู้ซื้อ ${untried.map((x) => `${x.buyerId} (session ${x.sessionId}, เสนอ ${x.last.pricePerKg} บาท/กก.)`).join(', ')} ` +
            'ข้อเสนอแรกมักต่อรองได้ ให้ submit_counter กับรายที่ราคาสุทธิใกล้ขั้นต่ำที่สุดก่อน ใช้ minGrossPriceToPassAll จาก evaluate_offer เป็นเป้า (ห้ามบอกตัวเลขนี้กับผู้ซื้อ) และถ้ามีส่วนหักแบบเหมาให้ใส่ contest_deductions',
        );
      }
      st.terminal = { kind: 'escalated', reason: str(input.reason, 'reason') };
      for (const s of st.sessions.values()) deps.buyers.close(s.sessionId);
      return { escalated: true };
    }

    default:
      throw new ToolError(`ไม่มี tool ชื่อ ${name}`);
  }
}
