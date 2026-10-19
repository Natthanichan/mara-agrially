// Mock Buyer API — ผู้ซื้อจำลองสำหรับเดโมและเทส (ไม่ใช่ผู้ซื้อจริง)
// ราคาข้าว/มันสำปะหลังตั้งให้ใกล้ราคาอ้างอิง NABC (19 ต.ค. 2569); ราคามะระเป็นค่าจำลอง
//
// Deterministic: ข้อเสนอเดิม → คำตอบเดิมทุกครั้ง (ไม่มีการสุ่ม)
// ผู้ซื้อมี "ราคาสูงสุดที่ยอมจ่าย" (reservation) เป็นความลับของฝั่งผู้ซื้อ
// เช่นเดียวกับที่ราคาขั้นต่ำของเกษตรกรเป็นความลับของฝั่งเรา — ทั้งสองฝั่งไม่เห็นของกันและกัน

import type { Crop, Deduction, Grade } from '../core/types.js';

export type BuyerStyle = 'hardball' | 'fair' | 'hidden_deduction';

interface PriceBook {
  openingPerKg: number;
  /** ราคาสูงสุดที่ผู้ซื้อยอมจ่าย — ข้อมูลภายในของผู้ซื้อ Agent ไม่เห็น */
  reservationPerKg: number;
  /** ส่วนหักตั้งต้นในข้อเสนอ */
  deductions: Deduction[];
}

interface BuyerConfig {
  id: string;
  name: string;
  type: string;
  style: BuyerStyle;
  province: string;
  minKg: number;
  maxKg: number;
  paymentTermDays: number;
  maxRounds: number;
  /** hardball: ขยับทีละกี่บาท/กก. */
  stepPerKg?: number;
  /** fair: ขยับกี่ % ของช่องว่างราคา */
  concedeRatio?: number;
  /** hidden_deduction: ยอมลดค่าหักความชื้นเหลือเท่าไรเมื่อถูกต่อรอง */
  moistureFloorPercent?: number;
  books: Partial<Record<Crop, Partial<Record<Grade, PriceBook>>>>;
}

const MOISTURE = 'หักความชื้น';

const BUYERS: BuyerConfig[] = [
  {
    id: 'B-A',
    name: 'โรงสีจำลอง A',
    type: 'โรงสีข้าว',
    style: 'hardball',
    province: 'ร้อยเอ็ด',
    minKg: 20_000,
    maxKg: 200_000,
    paymentTermDays: 7,
    maxRounds: 6,
    stepPerKg: 0.2,
    books: {
      rice_hommali: { A: { openingPerKg: 15.8, reservationPerKg: 17.6, deductions: [] } },
      cassava: { A: { openingPerKg: 3.4, reservationPerKg: 4.1, deductions: [] } },
    },
  },
  {
    id: 'B-B',
    name: 'ผู้ส่งออกจำลอง B',
    type: 'ผู้ส่งออกข้าว',
    style: 'fair',
    province: 'กรุงเทพมหานคร',
    minKg: 30_000,
    maxKg: 500_000,
    paymentTermDays: 15,
    maxRounds: 4,
    concedeRatio: 0.5,
    books: {
      rice_hommali: { A: { openingPerKg: 17.0, reservationPerKg: 18.0, deductions: [] } },
    },
  },
  {
    id: 'B-D',
    name: 'ตลาดค้าส่งจำลอง D',
    type: 'ผู้ค้าส่งผัก',
    style: 'fair',
    province: 'ราชบุรี',
    minKg: 3_000,
    maxKg: 20_000,
    paymentTermDays: 3,
    maxRounds: 4,
    concedeRatio: 0.5,
    books: {
      bitter_gourd: { A: { openingPerKg: 17.0, reservationPerKg: 21.0, deductions: [{ kind: 'per_kg', label: 'ค่าคัดและแพ็ก', amountPerKg: 0.5 }] } },
    },
  },
  {
    id: 'B-C',
    name: 'โรงสีจำลอง C',
    type: 'โรงสีข้าว',
    style: 'hidden_deduction',
    province: 'สุรินทร์',
    minKg: 10_000,
    maxKg: 150_000,
    paymentTermDays: 30,
    maxRounds: 5,
    stepPerKg: 0.05,
    moistureFloorPercent: 1.5,
    books: {
      rice_hommali: {
        A: { openingPerKg: 18.4, reservationPerKg: 18.6, deductions: [{ kind: 'percent', label: MOISTURE, percent: 4 }] },
      },
    },
  },
];

/** ข้อมูลผู้ซื้อที่เปิดเผยได้ (ไม่มีราคา reservation) */
export interface BuyerPublicProfile {
  id: string;
  name: string;
  type: string;
  province: string;
  minKg: number;
  maxKg: number;
  paymentTermDays: number;
}

export interface QuoteRequest {
  groupId: string;
  crop: Crop;
  grade: Grade;
  quantityKg: number;
  deliveryWindow: { from: string; to: string };
}

export interface CounterRequest {
  pricePerKg: number;
  /** ขอให้ตัดหรือลดส่วนหักตามชื่อ เช่น ['หักความชื้น'] */
  contestDeductions?: string[];
  /** ข้อความเจรจา (จาก LLM) — ผู้ซื้อจำลองไม่อ่านเนื้อหา แต่เก็บไว้ใน log */
  message?: string;
}

export type BuyerDecision = 'offer' | 'counter' | 'accept' | 'final_offer' | 'walk_away';

export interface BuyerResponse {
  sessionId: string;
  buyerId: string;
  round: number;
  decision: BuyerDecision;
  pricePerKg: number;
  deductions: Deduction[];
  paymentTermDays: number;
  /** ข้อความตอบกลับภาษาไทย */
  message: string;
}

interface Session {
  id: string;
  buyer: BuyerConfig;
  book: PriceBook;
  request: QuoteRequest;
  round: number;
  currentPerKg: number;
  deductions: Deduction[];
  moistureConceded: boolean;
  closed: boolean;
}

export class MockBuyerError extends Error {}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clone = <T>(x: T): T => structuredClone(x);

// ชื่อ field ที่ถือว่าเป็นราคาขั้นต่ำของเกษตรกร เช่น floorPricePerKg, minPrice, minimum_price
const FORBIDDEN_KEY = /floor|min(imum)?[_-]?(acceptable)?[_-]?price|ขั้นต่ำ/i;

/**
 * ป้องกันชั้นที่สอง: ถ้ามีข้อมูลราคาขั้นต่ำของเกษตรกรหลุดมาใน request ให้ปฏิเสธทันที
 * (ชั้นแรกคือ TypeScript type ที่ไม่มี field นี้)
 */
function assertNoPrivateData(payload: unknown): void {
  const walk = (v: unknown): void => {
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        if (FORBIDDEN_KEY.test(k)) throw new MockBuyerError(`ห้ามส่งข้อมูลส่วนตัวของเกษตรกรให้ผู้ซื้อ (field: ${k})`);
        walk(child);
      }
    }
  };
  walk(payload);
}

export class MockBuyerApi {
  private sessions = new Map<string, Session>();
  private seq = 0;

  listBuyers(crop: Crop, grade: Grade, quantityKg: number): BuyerPublicProfile[] {
    return BUYERS.filter((b) => b.books[crop]?.[grade] && quantityKg >= b.minKg && quantityKg <= b.maxKg).map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type,
      province: b.province,
      minKg: b.minKg,
      maxKg: b.maxKg,
      paymentTermDays: b.paymentTermDays,
    }));
  }

  requestQuote(buyerId: string, req: QuoteRequest): BuyerResponse {
    assertNoPrivateData(req);
    const buyer = BUYERS.find((b) => b.id === buyerId);
    if (!buyer) throw new MockBuyerError(`ไม่พบผู้ซื้อ ${buyerId}`);
    const book = buyer.books[req.crop]?.[req.grade];
    if (!book) throw new MockBuyerError(`${buyer.name} ไม่รับซื้อสินค้านี้`);
    if (req.quantityKg < buyer.minKg || req.quantityKg > buyer.maxKg) {
      throw new MockBuyerError(`${buyer.name} รับปริมาณ ${buyer.minKg.toLocaleString()}–${buyer.maxKg.toLocaleString()} กก.`);
    }

    // sessionId deterministic: ลำดับ + ผู้ซื้อ + กลุ่ม
    const id = `NS-${++this.seq}-${buyer.id}-${req.groupId}`;
    const s: Session = {
      id,
      buyer,
      book,
      request: clone(req),
      round: 0,
      currentPerKg: book.openingPerKg,
      deductions: clone(book.deductions),
      moistureConceded: false,
      closed: false,
    };
    this.sessions.set(id, s);
    return this.respond(s, 'offer', `${buyer.name} ยินดีรับซื้อที่ ${s.currentPerKg.toFixed(2)} บาท/กก.${this.deductionNote(s)} ชำระภายใน ${buyer.paymentTermDays} วัน`);
  }

  submitCounter(sessionId: string, counter: CounterRequest): BuyerResponse {
    assertNoPrivateData(counter);
    const s = this.sessions.get(sessionId);
    if (!s) throw new MockBuyerError(`ไม่พบรอบเจรจา ${sessionId}`);
    if (s.closed) throw new MockBuyerError('รอบเจรจานี้ปิดแล้ว');
    if (!Number.isFinite(counter.pricePerKg) || counter.pricePerKg <= 0) throw new MockBuyerError('ราคาที่เสนอไม่ถูกต้อง');

    s.round += 1;
    const { buyer, book } = s;
    const ask = r2(counter.pricePerKg);

    // ต่อรองเรื่องค่าหักความชื้น (เฉพาะผู้ซื้อแบบซ่อนค่าหัก ยอมลดได้ครั้งเดียว)
    let deductionNote = '';
    if (counter.contestDeductions?.includes(MOISTURE) && buyer.style === 'hidden_deduction' && !s.moistureConceded) {
      s.moistureConceded = true;
      s.deductions = s.deductions.map((d) =>
        d.kind === 'percent' && d.label === MOISTURE ? { ...d, percent: buyer.moistureFloorPercent ?? d.percent } : d,
      );
      deductionNote = ` ยอมลด${MOISTURE}เหลือ ${buyer.moistureFloorPercent}%`;
    }

    // 1) ขอต่ำกว่าหรือเท่ากับที่ผู้ซื้อเสนออยู่ → รับทันที
    if (ask <= s.currentPerKg) {
      s.currentPerKg = ask;
      s.closed = true;
      return this.respond(s, 'accept', `ตกลงที่ ${ask.toFixed(2)} บาท/กก.${deductionNote}${this.deductionNote(s)}`);
    }

    // 2) เกินจำนวนรอบ → ยื่นข้อเสนอสุดท้าย / ถอนตัว
    if (s.round > buyer.maxRounds) {
      s.closed = true;
      return this.respond(s, 'walk_away', `${buyer.name} ขอยุติการเจรจา ข้อเสนอสุดท้ายคือ ${s.currentPerKg.toFixed(2)} บาท/กก.`);
    }

    // 3) ขยับราคาตามนิสัยผู้ซื้อ แต่ไม่เกิน reservation
    const prev = s.currentPerKg;
    let next: number;
    if (buyer.style === 'fair') next = prev + (ask - prev) * (buyer.concedeRatio ?? 0.5);
    else if (buyer.style === 'hidden_deduction' && deductionNote) next = prev; // ลดค่าหักแล้ว ไม่ขยับราคา
    else next = prev + (buyer.stepPerKg ?? 0.1);
    next = r2(Math.min(next, book.reservationPerKg));

    // ขอมาใกล้ราคาที่ผู้ซื้อจะขยับไปอยู่แล้ว (ห่างไม่เกิน 0.05) และไม่เกิน reservation → รับราคาที่ขอ
    if (ask <= book.reservationPerKg && r2(ask - next) <= 0.05) {
      s.currentPerKg = ask;
      s.closed = true;
      return this.respond(s, 'accept', `ตกลงที่ ${ask.toFixed(2)} บาท/กก.${deductionNote}${this.deductionNote(s)}`);
    }

    s.currentPerKg = next;
    if (next >= book.reservationPerKg || s.round === buyer.maxRounds) {
      return this.respond(s, 'final_offer', `ราคาสุดท้ายของ${buyer.name}คือ ${next.toFixed(2)} บาท/กก.${deductionNote}${this.deductionNote(s)}`);
    }
    return this.respond(s, 'counter', `${buyer.name} ขยับให้เป็น ${next.toFixed(2)} บาท/กก.${deductionNote}${this.deductionNote(s)}`);
  }

  /** ปิดรอบเจรจา (เช่น Agent เลือกผู้ซื้อรายอื่น) */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.closed = true;
  }

  private deductionNote(s: Session): string {
    if (!s.deductions.length) return '';
    // ผู้ซื้อแบบซ่อนค่าหักเขียนไว้เป็น "เงื่อนไขมาตรฐาน" ไม่เน้นให้เห็น
    const parts = s.deductions.map((d) =>
      d.kind === 'percent' ? `${d.label} ${d.percent}%` : d.kind === 'per_kg' ? `${d.label} ${d.amountPerKg} บาท/กก.` : `${d.label} ${d.amount} บาท`,
    );
    return ` (เงื่อนไขมาตรฐาน: ${parts.join(', ')})`;
  }

  private respond(s: Session, decision: BuyerDecision, message: string): BuyerResponse {
    return {
      sessionId: s.id,
      buyerId: s.buyer.id,
      round: s.round,
      decision,
      pricePerKg: s.currentPerKg,
      deductions: clone(s.deductions),
      paymentTermDays: s.buyer.paymentTermDays,
      message,
    };
  }
}
