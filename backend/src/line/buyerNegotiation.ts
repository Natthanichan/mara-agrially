// ผู้ซื้อ (คนจริงใน LINE) เจรจาราคากับน้องมะระที่เป็นตัวแทนกลุ่มเกษตรกร
// โค้ดเป็นคนตัดสินราคาทุกรอบ (deterministic) — Nova แค่เขียนข้อความโน้มน้าวตามการตัดสินนั้น
//  - ไม่ยอมต่ำกว่า "ราคาต่ำสุดที่สมาชิกทุกคนยังได้สุทธิ ≥ ขั้นต่ำ" (คิดจากค่าขนส่งจริงของกลุ่ม) และไม่บอกตัวเลขนี้กับใคร
//  - เปิดราคาสูงกว่าเป้าอย่างมีเหตุผล (ราคาตลาด NABC) แล้วยอมลดทีละขั้นตามที่ผู้ซื้อขยับ ไม่ลดฟรี
//  - ผู้ซื้อเสนอถึงราคาที่ขอ → ตกลง (รอเกษตรกรอนุมัติ) · ครบรอบ → ยื่นราคาสุดท้าย

import { checkPriceFloor } from '../core/pricing.js';
import { groupListings } from '../core/grouping.js';
import type { Crop } from '../core/types.js';
import { farmers, listings } from '../data/synthetic.js';
import { planTrips } from '../agent/transport.js';
import { toArabicDigits } from '../agent/guardrails.js';

export const MAX_BUYER_ROUNDS = 6;

export interface BuyerNegState {
  id: string;
  crop: Crop;
  groupId: string;
  /** ราคาที่น้องมะระขออยู่ตอนนี้ */
  askPerKg: number;
  /** ราคาต่ำสุดที่ทุกคนในกลุ่มยังผ่านขั้นต่ำ — ข้อมูลภายในเท่านั้น ห้ามส่งให้ผู้ซื้อหรือใส่ในบริบทของ AI */
  minPassPerKg: number;
  rounds: number;
  lastOfferPerKg?: number;
  status: 'open' | 'agreed' | 'ended';
  agreedPerKg?: number;
  startedAt: string;
  /** ราคากลาง NABC ตอนเริ่มเจรจา (ถ้ามี) — หลักฐานที่อ้างได้ */
  marketMedianPerKg?: number;
}

export type BuyerNegDecision =
  | { kind: 'accept'; agreedPerKg: number }
  | { kind: 'counter'; askPerKg: number; movedFrom: number }
  | { kind: 'final'; askPerKg: number }
  | { kind: 'question'; askPerKg: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
const ceil2 = (n: number) => Math.ceil(n * 100 - 1e-6) / 100;

/** กลุ่มเกษตรกร (ข้อมูลจำลอง) ของพืชนี้ และราคาต่ำสุดที่ทุกคนผ่านขั้นต่ำ (ผู้ซื้อรับเองที่สวน ไม่มีส่วนหัก) */
export function groupTerms(crop: Crop) {
  const group = groupListings(listings, farmers).find((g) => g.crop === crop);
  if (!group) return undefined;
  const members = group.members.map((m) => ({ farmerId: m.farmerId, quantityKg: m.quantityKg }));
  const trips = planTrips(members, farmers);
  const minPassPerKg = checkPriceFloor(members, listings, { pricePerKg: 1, deductions: [], trips }).minGrossPriceToPassAll;
  return { group, members, trips, minPassPerKg, totalKg: members.reduce((n, m) => n + m.quantityKg, 0) };
}

/** ราคาเปิด: สูงกว่าเป้า 5% หรือสูงกว่าราคากลางตลาด 4% (อย่างใดสูงกว่า) */
export const openingAsk = (minPass: number, marketMedian?: number) => ceil2(Math.max(minPass * 1.05, marketMedian !== undefined ? marketMedian * 1.04 : 0));

/** ตัดสินรอบนี้จากราคาที่ผู้ซื้อเสนอ (undefined = ผู้ซื้อถามหรือคุยโดยไม่เสนอราคา) */
export function decide(st: BuyerNegState, offer: number | undefined): BuyerNegDecision {
  if (offer === undefined) return { kind: 'question', askPerKg: st.askPerKg };
  const round = st.rounds + 1;
  if (offer >= st.askPerKg) return { kind: 'accept', agreedPerKg: r2(offer) };
  // ใกล้กันมาก (ไม่เกิน 10 สตางค์) และยังผ่านขั้นต่ำทุกคน → ปิดที่ราคาผู้ซื้อ
  if (offer >= st.minPassPerKg && st.askPerKg - offer <= 0.1) return { kind: 'accept', agreedPerKg: r2(offer) };
  if (round >= MAX_BUYER_ROUNDS) {
    if (offer >= st.minPassPerKg) return { kind: 'accept', agreedPerKg: r2(offer) };
    return { kind: 'final', askPerKg: st.askPerKg };
  }
  // ยอมลดเป็นขั้น: ผู้ซื้อเสนอต่ำกว่าเป้ามาก → ลดน้อย (25% ของช่องว่างถึงเป้า) · ผู้ซื้อเข้ามาใกล้ → ลด 40% ของช่องว่าง
  const step = offer < st.minPassPerKg ? 0.25 * (st.askPerKg - st.minPassPerKg) : 0.4 * (st.askPerKg - offer);
  const next = ceil2(Math.max(st.minPassPerKg, offer, st.askPerKg - step));
  return { kind: 'counter', askPerKg: next, movedFrom: st.askPerKg };
}

export function apply(st: BuyerNegState, offer: number | undefined, d: BuyerNegDecision): BuyerNegState {
  if (d.kind === 'question') return st;
  const next: BuyerNegState = { ...st, rounds: st.rounds + 1, ...(offer !== undefined ? { lastOfferPerKg: r2(offer) } : {}) };
  if (d.kind === 'accept') return { ...next, status: 'agreed', agreedPerKg: d.agreedPerKg };
  if (d.kind === 'final') return { ...next, askPerKg: d.askPerKg };
  return { ...next, askPerKg: d.askPerKg };
}

const QTY_OR_COUNT = /^\s*(ตัน|กก|กิโล|กิโลกรัม|kg|วัน|%|เปอร์เซ็นต์|คน|ราย|เดือน|ปี|รอบ|เที่ยว|ชั่วโมง)/i;

/** ราคาที่ผู้ซื้อเสนอในข้อความ (ตัวเลขสุดท้ายที่ไม่ใช่ปริมาณ/จำนวน และอยู่ในช่วงที่สมเหตุสมผลเทียบกับราคาที่ขอ) */
export function extractOffer(text: string, askPerKg: number): number | undefined {
  const t = toArabicDigits(text);
  const found: number[] = [];
  for (const m of t.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)) {
    const rest = t.slice((m.index ?? 0) + m[0].length);
    if (QTY_OR_COUNT.test(rest) && !/^\s*บาท/.test(rest)) continue;
    const n = Number(m[1]!.replace(/,/g, ''));
    if (Number.isFinite(n) && n >= askPerKg * 0.3 && n <= askPerKg * 3) found.push(n);
  }
  return found.at(-1);
}
