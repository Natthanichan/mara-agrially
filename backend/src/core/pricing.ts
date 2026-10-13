// คำนวณราคาสุทธิและตรวจ Price Floor แบบ deterministic
// กฎ: LLM ห้ามคำนวณหรือตัดสินเรื่องนี้ ต้องผ่านฟังก์ชันในไฟล์นี้เท่านั้น

import type { DealTerms, GroupMember, Listing } from './types.js';

export interface FarmerNet {
  farmerId: string;
  quantityKg: number;
  grossPerKg: number;
  transportPerKg: number;
  otherDeductionsPerKg: number;
  netPerKg: number; // ปัดลงเป็นสตางค์ (ฝั่งปลอดภัยต่อเกษตรกร)
  netTotal: number;
}

const toSatang = (baht: number) => baht * 100;
/** ปัดลงเป็นสตางค์ เพื่อไม่ให้ปัดเศษแล้วดูเหมือนผ่านขั้นต่ำทั้งที่ไม่ผ่าน */
const floorSatang = (satang: number) => Math.floor(satang + 1e-9) / 100;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeNetPerFarmer(
  members: Pick<GroupMember, 'farmerId' | 'quantityKg'>[],
  terms: DealTerms,
): FarmerNet[] {
  if (!(terms.pricePerKg > 0)) throw new Error('pricePerKg ต้องมากกว่า 0');
  const totalKg = members.reduce((s, m) => s + m.quantityKg, 0);
  if (totalKg <= 0) throw new Error('น้ำหนักรวมต้องมากกว่า 0');

  const qtyOf = new Map(members.map((m) => [m.farmerId, m.quantityKg]));

  // ค่าขนส่งต่อกก. ของแต่ละเที่ยว = ค่าขนส่งรวม ÷ น้ำหนักรวมของเที่ยว
  const transportPerKgByFarmer = new Map<string, number>();
  for (const trip of terms.trips) {
    const tripFarmers = trip.farmerIds.filter((id) => qtyOf.has(id));
    const tripKg = tripFarmers.reduce((s, id) => s + (qtyOf.get(id) ?? 0), 0);
    if (tripKg <= 0) continue;
    for (const id of tripFarmers) {
      if (transportPerKgByFarmer.has(id)) throw new Error(`เกษตรกร ${id} อยู่มากกว่า 1 เที่ยวขนส่ง`);
      transportPerKgByFarmer.set(id, toSatang(trip.totalCost) / tripKg);
    }
  }

  const priceS = toSatang(terms.pricePerKg);
  let otherS = 0; // ส่วนหักที่เท่ากันทุกคนต่อกก.
  for (const d of terms.deductions) {
    if (d.kind === 'per_kg') otherS += toSatang(d.amountPerKg);
    else if (d.kind === 'percent') otherS += (priceS * d.percent) / 100;
    else otherS += toSatang(d.amount) / totalKg; // แบ่งตามสัดส่วนน้ำหนัก
  }

  return members.map((m) => {
    const transportS = transportPerKgByFarmer.get(m.farmerId) ?? 0;
    const netPerKg = floorSatang(priceS - transportS - otherS);
    return {
      farmerId: m.farmerId,
      quantityKg: m.quantityKg,
      grossPerKg: terms.pricePerKg,
      transportPerKg: round2(transportS / 100),
      otherDeductionsPerKg: round2(otherS / 100),
      netPerKg,
      netTotal: round2(netPerKg * m.quantityKg),
    };
  });
}

export interface FloorCheckResult {
  /** ผ่านเมื่อราคาสุทธิ ≥ ขั้นต่ำของสมาชิกที่อยู่ในดีลทุกคน */
  passes: boolean;
  nets: FarmerNet[];
  /** ข้อมูลภายในเท่านั้น — มีราคาขั้นต่ำ ห้ามส่งให้ผู้ซื้อหรือใส่ใน prompt ที่ส่งออกไป */
  violations: { farmerId: string; netPerKg: number; floorPerKg: number; shortfallPerKg: number }[];
  /** ราคาเสนอขั้นต่ำต่อกก. ที่ทำให้ทุกคนผ่าน (ภายใต้ส่วนหักชุดเดียวกัน) — ใช้ภายในเท่านั้น */
  minGrossPriceToPassAll: number;
}

export function checkPriceFloor(
  members: Pick<GroupMember, 'farmerId' | 'quantityKg'>[],
  listings: Pick<Listing, 'farmerId' | 'floorPricePerKg'>[],
  terms: DealTerms,
): FloorCheckResult {
  const floorOf = new Map(listings.map((l) => [l.farmerId, l.floorPricePerKg]));
  const nets = computeNetPerFarmer(members, terms);

  const violations: FloorCheckResult['violations'] = [];
  for (const n of nets) {
    const floor = floorOf.get(n.farmerId);
    // ไม่มีข้อมูลขั้นต่ำ = ไม่ผ่าน (fail closed)
    if (floor === undefined || !Number.isFinite(floor)) {
      violations.push({ farmerId: n.farmerId, netPerKg: n.netPerKg, floorPerKg: NaN, shortfallPerKg: NaN });
      continue;
    }
    if (n.netPerKg < floor) {
      violations.push({ farmerId: n.farmerId, netPerKg: n.netPerKg, floorPerKg: floor, shortfallPerKg: round2(floor - n.netPerKg) });
    }
  }

  return { passes: violations.length === 0, nets, violations, minGrossPriceToPassAll: minPassingPrice(members, floorOf, terms) };
}

/** ค้นหาราคาเสนอต่ำสุด (ทีละ 1 สตางค์) ที่ทำให้ทุกคนผ่านขั้นต่ำ */
function minPassingPrice(
  members: Pick<GroupMember, 'farmerId' | 'quantityKg'>[],
  floorOf: Map<string, number>,
  terms: DealTerms,
): number {
  const passesAt = (p: number) =>
    computeNetPerFarmer(members, { ...terms, pricePerKg: p }).every((n) => {
      const f = floorOf.get(n.farmerId);
      return f !== undefined && Number.isFinite(f) && n.netPerKg >= f;
    });
  let lo = 1; // สตางค์
  let hi = 100_000 * 100; // เพดาน 100,000 บาท/กก.
  if (!passesAt(hi / 100)) return Number.POSITIVE_INFINITY;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (passesAt(mid / 100)) hi = mid;
    else lo = mid + 1;
  }
  return lo / 100;
}
