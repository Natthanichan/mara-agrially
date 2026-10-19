import { describe, expect, it } from 'vitest';
import { MockBuyerApi, MockBuyerError, type QuoteRequest } from '../src/buyer/mockBuyer.js';
import { computeNetPerFarmer } from '../src/core/pricing.js';

const rice: QuoteRequest = {
  groupId: 'G1',
  crop: 'rice_hommali',
  grade: 'A',
  quantityKg: 41_500,
  deliveryWindow: { from: '2026-11-20', to: '2026-11-24' },
};

/** ราคาสุทธิต่อกก. ก่อนค่าขนส่ง (ใช้ engine เดียวกับระบบจริง) */
const netOf = (pricePerKg: number, deductions: Parameters<typeof computeNetPerFarmer>[1]['deductions']) =>
  computeNetPerFarmer([{ farmerId: 'X', quantityKg: 1000 }], { pricePerKg, deductions, trips: [] })[0]!.netPerKg;

describe('Mock Buyer API', () => {
  it('ค้นผู้ซื้อตามพืช เกรด และปริมาณ', () => {
    const api = new MockBuyerApi();
    expect(api.listBuyers('rice_hommali', 'A', 41_500).map((b) => b.id)).toEqual(['B-A', 'B-B', 'B-C']);
    expect(api.listBuyers('rice_hommali', 'A', 15_000).map((b) => b.id)).toEqual(['B-C']); // ต่ำกว่าขั้นต่ำของ A, B
    expect(api.listBuyers('bitter_gourd', 'A', 5_500).map((b) => b.id)).toEqual(['B-D']);
    expect(api.listBuyers('bitter_gourd', 'A', 2_000)).toEqual([]); // ต่ำกว่าขั้นต่ำ 3 ตัน
    expect(JSON.stringify(api.listBuyers('rice_hommali', 'A', 41_500))).not.toMatch(/reservation/);
  });

  it('deterministic: ลำดับข้อเสนอเดิม → คำตอบเดิมทุกครั้ง', () => {
    const run = () => {
      const api = new MockBuyerApi();
      const q = api.requestQuote('B-A', rice);
      return [q, api.submitCounter(q.sessionId, { pricePerKg: 14.5 }), api.submitCounter(q.sessionId, { pricePerKg: 14.2 })];
    };
    expect(run()).toEqual(run());
  });

  it('กดราคาแรง: ขยับทีละ 0.15 แล้วยื่นข้อเสนอสุดท้าย และถอนตัวเมื่อเกินรอบ', () => {
    const api = new MockBuyerApi();
    const q = api.requestQuote('B-A', rice);
    expect(q.pricePerKg).toBe(12.6);
    const prices: number[] = [];
    let last = q;
    for (let i = 0; i < 6; i++) {
      last = api.submitCounter(q.sessionId, { pricePerKg: 14.5 });
      prices.push(last.pricePerKg);
    }
    expect(prices).toEqual([12.75, 12.9, 13.05, 13.2, 13.35, 13.5]);
    expect(last.decision).toBe('final_offer');
    expect(api.submitCounter(q.sessionId, { pricePerKg: 14.5 }).decision).toBe('walk_away');
    expect(() => api.submitCounter(q.sessionId, { pricePerKg: 14.5 })).toThrow(MockBuyerError);
  });

  it('กลางๆ: ขยับครึ่งหนึ่งของช่องว่าง ไม่เกินราคาสูงสุดที่ยอมจ่าย แล้วตกลงได้', () => {
    const api = new MockBuyerApi();
    const q = api.requestQuote('B-B', rice);
    expect(api.submitCounter(q.sessionId, { pricePerKg: 14.6 })).toMatchObject({ decision: 'counter', pricePerKg: 14.1 });
    expect(api.submitCounter(q.sessionId, { pricePerKg: 14.6 })).toMatchObject({ decision: 'counter', pricePerKg: 14.35 });
    expect(api.submitCounter(q.sessionId, { pricePerKg: 14.6 })).toMatchObject({ decision: 'final_offer', pricePerKg: 14.4 });
    expect(api.submitCounter(q.sessionId, { pricePerKg: 14.4 })).toMatchObject({ decision: 'accept', pricePerKg: 14.4 });
  });

  it('รับราคาที่ขอ เมื่อห่างจากราคาที่ตั้งใจขยับไม่เกิน 0.05', () => {
    const api = new MockBuyerApi();
    const q = api.requestQuote('B-B', rice);
    api.submitCounter(q.sessionId, { pricePerKg: 14.6 }); // 14.10
    api.submitCounter(q.sessionId, { pricePerKg: 14.6 }); // 14.35
    expect(api.submitCounter(q.sessionId, { pricePerKg: 14.4 })).toMatchObject({ decision: 'accept', pricePerKg: 14.4 });
  });

  it('ซ่อนค่าหักความชื้น: ราคาหน้าสูงสุด แต่ราคาสุทธิต่ำกว่าเจ้าอื่น', () => {
    const api = new MockBuyerApi();
    const c = api.requestQuote('B-C', rice);
    const b = api.requestQuote('B-B', rice);
    expect(c.pricePerKg).toBeGreaterThan(b.pricePerKg); // 14.60 > 13.60
    expect(c.deductions).toEqual([{ kind: 'percent', label: 'หักความชื้น', percent: 4 }]);
    expect(netOf(c.pricePerKg, c.deductions)).toBe(14.01); // 14.60 − 4%
    // ขณะที่ B ตกลงได้ 14.40 ไม่มีส่วนหัก → C แย่กว่าจริง
    expect(netOf(14.4, [])).toBeGreaterThan(netOf(c.pricePerKg, c.deductions));
  });

  it('ต่อรองค่าหักความชื้นได้ครั้งเดียว และราคาไม่ขยับในรอบนั้น', () => {
    const api = new MockBuyerApi();
    const q = api.requestQuote('B-C', rice);
    const r1 = api.submitCounter(q.sessionId, { pricePerKg: 14.8, contestDeductions: ['หักความชื้น'] });
    expect(r1).toMatchObject({ decision: 'counter', pricePerKg: 14.6 });
    expect(r1.deductions[0]).toMatchObject({ percent: 1.5 });
    expect(netOf(r1.pricePerKg, r1.deductions)).toBe(14.38);
    const r2 = api.submitCounter(q.sessionId, { pricePerKg: 14.8, contestDeductions: ['หักความชื้น'] });
    expect(r2.deductions[0]).toMatchObject({ percent: 1.5 }); // ไม่ลดซ้ำ
    expect(r2.pricePerKg).toBe(14.65);
  });

  it('ไม่ยอมจ่ายเกินราคาสูงสุดของผู้ซื้อ ไม่ว่าจะเจรจากี่รอบ', () => {
    const api = new MockBuyerApi();
    const q = api.requestQuote('B-A', rice);
    let last = q;
    for (let i = 0; i < 6; i++) last = api.submitCounter(q.sessionId, { pricePerKg: 99 });
    expect(last.pricePerKg).toBeLessThanOrEqual(14.0);
  });

  it('privacy: ปฏิเสธ request ที่มีราคาขั้นต่ำของเกษตรกรหลุดมา', () => {
    const api = new MockBuyerApi();
    expect(() => api.requestQuote('B-A', { ...rice, floorPricePerKg: 13 } as QuoteRequest)).toThrow(/ข้อมูลส่วนตัว/);
    const q = api.requestQuote('B-A', rice);
    expect(() => api.submitCounter(q.sessionId, { pricePerKg: 14, meta: { minPrice: 13 } } as never)).toThrow(/ข้อมูลส่วนตัว/);
  });

  it('ตรวจข้อมูลไม่ถูกต้อง', () => {
    const api = new MockBuyerApi();
    expect(() => api.requestQuote('B-X', rice)).toThrow(MockBuyerError);
    expect(() => api.requestQuote('B-A', { ...rice, quantityKg: 5_000 })).toThrow(MockBuyerError);
    const q = api.requestQuote('B-A', rice);
    expect(() => api.submitCounter(q.sessionId, { pricePerKg: Number.NaN })).toThrow(MockBuyerError);
    expect(() => api.submitCounter('nope', { pricePerKg: 14 })).toThrow(MockBuyerError);
  });
});
