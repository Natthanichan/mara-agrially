import { describe, expect, it } from 'vitest';
import { checkPriceFloor, computeNetPerFarmer } from '../src/core/pricing.js';
import { activeQuantityKg, groupListings, withdrawMember } from '../src/core/grouping.js';
import { canFinalize, nextDealStatus, nextDeliveryStatus, nextPaymentStatus, TransitionError } from '../src/core/stateMachine.js';
import { Ledger } from '../src/core/ledger.js';
import { farmers, listings } from '../src/data/synthetic.js';
import type { DealTerms } from '../src/core/types.js';

const members = [
  { farmerId: 'A', quantityKg: 6000 },
  { farmerId: 'B', quantityKg: 4000 },
  { farmerId: 'C', quantityKg: 10000 },
];
// เที่ยว 1: A+B รวม 10,000 กก. ค่าส่ง 3,000 → 0.30/กก. ; เที่ยว 2: C 10,000 กก. ค่าส่ง 5,000 → 0.50/กก.
const terms: DealTerms = {
  pricePerKg: 14,
  deductions: [],
  trips: [
    { id: 'T1', totalCost: 3000, farmerIds: ['A', 'B'] },
    { id: 'T2', totalCost: 5000, farmerIds: ['C'] },
  ],
};

describe('ราคาสุทธิ', () => {
  it('ค่าขนส่ง = ค่าขนส่งรวม ÷ น้ำหนักรวมของเที่ยวเดียวกัน', () => {
    const nets = computeNetPerFarmer(members, terms);
    expect(nets.find((n) => n.farmerId === 'A')!.netPerKg).toBe(13.7);
    expect(nets.find((n) => n.farmerId === 'B')!.netPerKg).toBe(13.7);
    expect(nets.find((n) => n.farmerId === 'C')!.netPerKg).toBe(13.5);
    expect(nets.find((n) => n.farmerId === 'C')!.netTotal).toBe(135000);
  });

  it('รวมส่วนหักต่อกก. เปอร์เซ็นต์ และแบบเหมาจ่าย', () => {
    const nets = computeNetPerFarmer(members, {
      ...terms,
      deductions: [
        { kind: 'per_kg', label: 'ค่าคัดเกรด', amountPerKg: 0.1 },
        { kind: 'percent', label: 'หักความชื้น', percent: 1 }, // 0.14
        { kind: 'lump_sum', label: 'ค่าตรวจคุณภาพ', amount: 2000 }, // 2000/20000 = 0.10
      ],
    });
    expect(nets.find((n) => n.farmerId === 'A')!.netPerKg).toBe(13.36);
  });

  it('ปัดลงเป็นสตางค์ (ไม่ปัดขึ้นจนดูเหมือนผ่าน)', () => {
    // 1000/3000 = 0.3333.. → 14 - 0.3333 = 13.6666 → 13.66
    const nets = computeNetPerFarmer([{ farmerId: 'X', quantityKg: 3000 }], { pricePerKg: 14, deductions: [], trips: [{ id: 'T', totalCost: 1000, farmerIds: ['X'] }] });
    expect(nets[0]!.netPerKg).toBe(13.66);
  });

  it('ปฏิเสธข้อมูลไม่ถูกต้อง', () => {
    expect(() => computeNetPerFarmer(members, { ...terms, pricePerKg: 0 })).toThrow();
    expect(() => computeNetPerFarmer(members, { ...terms, trips: [{ id: 'T1', totalCost: 1, farmerIds: ['A'] }, { id: 'T2', totalCost: 1, farmerIds: ['A'] }] })).toThrow();
  });
});

describe('Price Floor', () => {
  const floors = [
    { farmerId: 'A', floorPricePerKg: 13.5 },
    { farmerId: 'B', floorPricePerKg: 13.0 },
    { farmerId: 'C', floorPricePerKg: 13.6 },
  ];

  it('บล็อกเมื่อราคาสุทธิของบางคนต่ำกว่าขั้นต่ำ แม้ราคาเสนอดูสูงกว่า', () => {
    const r = checkPriceFloor(members, floors, terms); // C ได้สุทธิ 13.50 < 13.60
    expect(r.passes).toBe(false);
    expect(r.violations).toEqual([{ farmerId: 'C', netPerKg: 13.5, floorPerKg: 13.6, shortfallPerKg: 0.1 }]);
  });

  it('ผ่านเมื่อทุกคนได้สุทธิ ≥ ขั้นต่ำ (เท่ากันพอดีถือว่าผ่าน)', () => {
    const r = checkPriceFloor(members, floors, { ...terms, pricePerKg: 14.1 });
    expect(r.passes).toBe(true);
  });

  it('คำนวณราคาเสนอต่ำสุดที่ทุกคนผ่าน', () => {
    const r = checkPriceFloor(members, floors, terms);
    expect(r.minGrossPriceToPassAll).toBe(14.1);
    expect(checkPriceFloor(members, floors, { ...terms, pricePerKg: 14.09 }).passes).toBe(false);
  });

  it('ไม่มีข้อมูลขั้นต่ำ = ไม่ผ่าน (fail closed)', () => {
    const r = checkPriceFloor(members, floors.slice(0, 2), { ...terms, pricePerKg: 99 });
    expect(r.passes).toBe(false);
    expect(r.violations[0]!.farmerId).toBe('C');
  });
});

describe('การจับกลุ่ม (ข้อมูลจำลอง)', () => {
  const groups = groupListings(listings, farmers);

  it('แยกตามพืช เกรด จังหวัด และไม่รวมคนเดียว', () => {
    const rice = groups.find((g) => g.crop === 'rice_hommali' && g.grade === 'A')!;
    expect(rice.members.map((m) => m.farmerId).sort()).toEqual(['F01', 'F02', 'F03', 'F04']);
    expect(groups.some((g) => g.members.some((m) => m.farmerId === 'F05'))).toBe(false); // เกรด B คนเดียว
    expect(groups.map((g) => g.crop).sort()).toEqual(['bitter_gourd', 'cassava', 'rice_hommali']);
  });

  it('แยกกลุ่มเมื่อวันส่งมอบห่างเกินช่วงที่กำหนด', () => {
    const g = groupListings(listings, farmers, { deliveryWindowDays: 1, minMembers: 2 });
    const riceGroups = g.filter((x) => x.crop === 'rice_hommali');
    expect(riceGroups.length).toBe(1);
    expect(riceGroups[0]!.members.map((m) => m.farmerId)).toEqual(['F01', 'F02']);
  });

  it('สมาชิกปฏิเสธ → กลุ่มไปต่อ แต่แจ้งถ้าปริมาณต่ำกว่าขั้นต่ำผู้ซื้อ', () => {
    const rice = groups.find((g) => g.crop === 'rice_hommali')!;
    expect(activeQuantityKg(rice)).toBe(41_500);
    const r1 = withdrawMember(rice, 'F04', 30_000);
    expect(r1.remainingKg).toBe(35_500);
    expect(r1.needsRenegotiation).toBe(false);
    const r2 = withdrawMember(r1.group, 'F03', 30_000);
    expect(r2.needsRenegotiation).toBe(true);
    expect(() => withdrawMember(r2.group, 'F03', 0)).toThrow();
  });
});

describe('สถานะดีล / ส่งมอบ / ชำระเงิน', () => {
  it('Agent ข้ามขั้นอนุมัติไม่ได้', () => {
    expect(() => nextDealStatus('negotiating', 'agreed')).toThrow(TransitionError);
    expect(nextDealStatus('pending_approval', 'negotiating')).toBe('negotiating');
  });

  it('ส่งมอบได้หลังตกลงดีล และรอชำระได้หลังส่งมอบ', () => {
    expect(() => nextDeliveryStatus('pending_approval', 'not_started', 'scheduled')).toThrow();
    expect(nextDeliveryStatus('agreed', 'not_started', 'scheduled')).toBe('scheduled');
    expect(() => nextPaymentStatus('scheduled', 'not_due', 'awaiting_payment')).toThrow();
    expect(nextPaymentStatus('delivered', 'not_due', 'awaiting_payment')).toBe('awaiting_payment');
  });

  it('canFinalize ต้องครบทุกเงื่อนไข', () => {
    const base = { status: 'pending_approval' as const, activeFarmerIds: ['A', 'B'], approvals: { A: 'approve' as const, B: 'approve' as const }, floorPasses: true, remainingKg: 10, buyerMinKg: 5 };
    expect(canFinalize(base).ok).toBe(true);
    expect(canFinalize({ ...base, approvals: { A: 'approve' } }).ok).toBe(false);
    expect(canFinalize({ ...base, floorPasses: false }).ok).toBe(false);
    expect(canFinalize({ ...base, remainingKg: 1 }).ok).toBe(false);
    expect(canFinalize({ ...base, status: 'negotiating' }).ok).toBe(false);
  });
});

describe('Ledger', () => {
  it('ต่อท้ายได้ ตรวจ hash chain ได้ และจับการแก้ไขได้', () => {
    const l = new Ledger(() => new Date('2026-11-01T00:00:00Z'));
    l.append({ dealId: 'D1', actor: 'buyer', type: 'offer_received', data: { pricePerKg: 13.5 } });
    l.append({ dealId: 'D1', actor: 'system', type: 'floor_blocked', data: { violations: 1 } });
    expect(l.verify().ok).toBe(true);
    const tampered = l.list().map((e, i) => (i === 0 ? { ...e, data: { pricePerKg: 15 } } : e));
    expect(l.verify(tampered)).toEqual({ ok: false, brokenAt: 1 });
    expect(() => ((l.list()[0] as { type: string }).type = 'x')).toThrow();
  });
});
