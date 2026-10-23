// Tools ที่ Agent เรียกใช้ได้ — ทุก tool เป็นโค้ด deterministic
// LLM เลือกว่าจะเรียกอะไร แต่ "ผล" มาจากโค้ดเสมอ (ราคาสุทธิ, floor, การส่งข้อเสนอ)
// ไม่มี tool สำหรับปิดดีล: Agent ทำได้แค่ prepare_deal_for_approval แล้วรอเกษตรกรอนุมัติ

import { MockBuyerApi, MockBuyerError, type BuyerResponse } from '../buyer/mockBuyer.js';
import { checkPriceFloor } from '../core/pricing.js';
import { activeMembers } from '../core/grouping.js';
import type { Deduction, DealTerms, Farmer, Group, Listing } from '../core/types.js';
import type { MarketReference } from '../market/nabcClient.js';
import type { KnowledgeIndex } from '../rag/search.js';
import { checkCounterPrice, checkMessageLeak, type GuardrailViolation } from './guardrails.js';
import type { ToolSpec } from './llm/types.js';
import { planTrips } from './transport.js';

export interface MarketProvider {
  getReference(crop: Group['crop'], date: string, province?: string): Promise<MarketReference | undefined>;
}

export interface AgentDeps {
  buyers: MockBuyerApi;
  market: MarketProvider;
  knowledge: KnowledgeIndex;
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
  terminal?: Terminal;
  market?: MarketReference | null;
  readonly members;
  readonly trips;
  readonly maxRoundsPerBuyer: number;

  constructor(readonly input: NegotiationInput) {
    this.members = activeMembers(input.group).map((m) => ({ farmerId: m.farmerId, quantityKg: m.quantityKg }));
    this.trips = planTrips(this.members, input.farmers);
    this.maxRoundsPerBuyer = input.maxRoundsPerBuyer ?? 5;
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
  publicNumbers(): number[] {
    const nums = [this.totalKg];
    if (this.market) {
      nums.push(this.market.minPerKg, this.market.maxPerKg, this.market.medianPerKg, ...this.market.provinceQuotes.map((q) => q.pricePerKg));
    }
    for (const s of this.sessions.values()) nums.push(...s.history.map((h) => h.pricePerKg));
    return nums;
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
      'ยื่นข้อเสนอโต้กลับให้ผู้ซื้อ ระบุราคาต่อกก. และขอให้ลดส่วนหักได้ (contest_deductions เช่น ["หักความชื้น"]) พร้อมข้อความภาษาไทยถึงผู้ซื้อ ห้ามใส่ราคาขั้นต่ำของกลุ่มในข้อความ ระบบจะบล็อกราคาที่ต่ำกว่าขั้นต่ำ',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          price_per_kg: { type: 'number' },
          contest_deductions: { type: 'array', items: { type: 'string' } },
          message: { type: 'string', description: 'ข้อความถึงผู้ซื้อ ให้เหตุผลจากราคาตลาด ปริมาณ และคุณภาพ' },
        },
        required: ['session_id', 'price_per_kg', 'message'],
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
      if (!ref) return { available: false, note: 'ไม่มีราคาอ้างอิงจาก NABC สำหรับพืชนี้ ให้ใช้ search_knowledge' };
      return {
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
      return { mode: r.mode, results: r.hits.map((h) => ({ source: `${h.source} › ${h.heading}`, text: h.text, disclaimer: h.disclaimer })) };
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
      st.sessions.set(res.sessionId, { sessionId: res.sessionId, buyerId, buyerName: name, last: res, rounds: 0, history: [res], closed: false });
      trace('buyer_response', { ...res, buyerName: name });
      return { session_id: res.sessionId, buyer: name, decision: res.decision, pricePerKg: res.pricePerKg, deductions: res.deductions.map(describeDeduction), paymentTermDays: res.paymentTermDays, message: res.message };
    }

    case 'evaluate_offer': {
      return st.evaluate(session(input.session_id));
    }

    case 'submit_counter': {
      const s = session(input.session_id);
      if (s.closed) throw new ToolError('ผู้ซื้อรายนี้ปิดการเจรจาแล้ว');
      const price = Number(input.price_per_kg);
      const message = typeof input.message === 'string' ? input.message : '';
      const contest = Array.isArray(input.contest_deductions) ? input.contest_deductions.filter((x): x is string => typeof x === 'string') : [];

      // floor ภายใต้ส่วนหักปัจจุบัน (ระมัดระวัง: ยังไม่นับส่วนหักที่ขอลด เพราะผู้ซื้ออาจไม่ยอม)
      const ev = st.evaluate(s);
      const violation =
        checkCounterPrice({
          pricePerKg: price,
          minGrossPriceToPassAll: ev.minGrossPriceToPassAll,
          buyerCurrentPerKg: s.last.pricePerKg,
          roundsUsed: s.rounds,
          maxRounds: st.maxRoundsPerBuyer,
        }) ?? checkMessageLeak(message, st.privateNumbers(), [price, ...st.publicNumbers()]);
      if (violation) {
        st.violations.push(violation);
        trace('guardrail_blocked', { buyerId: s.buyerId, attemptedPricePerKg: price, code: violation.code, reason: violation.message });
        return { blocked: true, code: violation.code, reason: violation.message };
      }

      let res: BuyerResponse;
      try {
        res = deps.buyers.submitCounter(s.sessionId, { pricePerKg: price, contestDeductions: contest, message });
      } catch (e) {
        if (e instanceof MockBuyerError) {
          s.closed = true;
          throw new ToolError(e.message);
        }
        throw e;
      }
      trace('counter_sent', { buyerId: s.buyerId, pricePerKg: price, contestDeductions: contest, message });
      s.rounds += 1;
      s.last = res;
      s.history.push(res);
      if (res.decision === 'walk_away' || res.decision === 'accept') s.closed = true;
      trace('buyer_response', { ...res, buyerName: s.buyerName });
      return {
        buyer: s.buyerName,
        decision: res.decision,
        pricePerKg: res.pricePerKg,
        deductions: res.deductions.map(describeDeduction),
        message: res.message,
        roundsUsed: s.rounds,
        roundsLeft: Math.max(0, st.maxRoundsPerBuyer - s.rounds),
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
      st.terminal = { kind: 'escalated', reason: str(input.reason, 'reason') };
      for (const s of st.sessions.values()) deps.buyers.close(s.sessionId);
      return { escalated: true };
    }

    default:
      throw new ToolError(`ไม่มี tool ชื่อ ${name}`);
  }
}
