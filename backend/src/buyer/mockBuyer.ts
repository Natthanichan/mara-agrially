// Mock Buyer API — ผู้ซื้อจำลองสำหรับเดโมและเทส (ไม่ใช่ผู้ซื้อจริง)
// ราคาข้าว/มันสำปะหลังตั้งให้ใกล้ราคาอ้างอิง NABC (19 ต.ค. 2569); ราคามะระเป็นค่าจำลอง
//
// Deterministic: ข้อเสนอเดิม + เหตุผลเดิม → คำตอบเดิมทุกครั้ง (ไม่มีการสุ่ม)
// ผู้ซื้อมี "ราคาสูงสุดที่ยอมจ่าย" (reservation) เป็นความลับของฝั่งผู้ซื้อ
// เช่นเดียวกับที่ราคาขั้นต่ำของเกษตรกรเป็นความลับของฝั่งเรา — ทั้งสองฝั่งไม่เห็นของกันและกัน
//
// v2: ผู้ซื้อตอบสนองต่อ "เหตุผลที่มีหลักฐาน" (ArgumentClaim) ไม่ใช่แค่ตัวเลขราคา
//  - ผู้ซื้อแต่ละรายให้น้ำหนักเหตุผลต่างกัน (responsiveness) และมีข้อกังวลของตัวเอง (concerns)
//  - เหตุผลที่ตรงข้อกังวลและถูกต้อง (เช่น ราคาตลาดสูงกว่าที่เขาให้จริง) → ขยับมากขึ้น และงบยืดได้ (flexPerKg)
//  - เหตุผลเดิมซ้ำ → น้ำหนักลดลงครึ่งหนึ่งทุกครั้ง · ขอสูงเกินจริงมาก → ไม่ขยับ (anchoring ที่เกินไปให้ผลเสีย)
//  - ไม่ตกลงเมื่อไหร่ ตอบพร้อมข้อโต้แย้ง (objection) ให้ Agent ตอบ
//  ผู้ซื้อไม่ "อ่าน" ข้อความอิสระ — รับเฉพาะเหตุผลที่โค้ดฝั่งเราตรวจแล้วว่ามีหลักฐานจริง จึงเทสได้และกันการหลอกด้วยคำพูด

import type { Crop, Deduction, Grade } from '../core/types.js';

export type BuyerStyle = 'hardball' | 'fair' | 'hidden_deduction';

interface PriceBook {
  openingPerKg: number;
  /** ราคาสูงสุดที่ผู้ซื้อยอมจ่าย — ข้อมูลภายในของผู้ซื้อ Agent ไม่เห็น */
  reservationPerKg: number;
  /** ส่วนหักตั้งต้นในข้อเสนอ */
  deductions: Deduction[];
}

/** ประเภทเหตุผลที่ผู้ซื้อรับรู้ได้ — สร้างจากหลักฐานที่โค้ดตรวจแล้วเท่านั้น (agent/evidence.ts) */
export type ArgumentTag = 'market_reference' | 'volume' | 'quality_grade' | 'delivery_ready' | 'consolidated_logistics' | 'competing_offer' | 'buyer_history';

export interface ArgumentClaim {
  tag: ArgumentTag;
  /** ราคาอ้างอิงต่อกก. สำหรับ market_reference / competing_offer / buyer_history */
  value?: number;
}

export type ObjectionCode = 'unrealistic_ask' | 'price_above_budget' | 'final_stretch' | `need_${ArgumentTag}` | 'weak_evidence' | 'repeated_argument';

export interface Objection {
  code: ObjectionCode;
  text: string;
}

export interface BuyerConfig {
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
  /** น้ำหนักของเหตุผลแต่ละแบบ (0–1) */
  responsiveness: Partial<Record<ArgumentTag, number>>;
  /** ข้อกังวลเรียงตามความสำคัญ — ถ้ายังไม่ถูกตอบ ผู้ซื้อจะยกขึ้นมาเป็นข้อโต้แย้ง */
  concerns: ArgumentTag[];
  /** งบยืดได้สูงสุดกี่บาท/กก. เมื่อถูกโน้มน้าวเต็มที่ */
  flexPerKg: number;
  books: Partial<Record<Crop, Partial<Record<Grade, PriceBook>>>>;
}

const MOISTURE = 'หักความชื้น';

export const DEFAULT_BUYERS: BuyerConfig[] = [
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
    responsiveness: { market_reference: 0.5, competing_offer: 0.6, volume: 0.3, buyer_history: 0.4 },
    concerns: ['market_reference', 'volume', 'competing_offer'],
    flexPerKg: 0.3,
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
    responsiveness: { quality_grade: 0.5, delivery_ready: 0.4, market_reference: 0.3, volume: 0.2 },
    concerns: ['quality_grade', 'delivery_ready', 'market_reference'],
    flexPerKg: 0.3,
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
    responsiveness: { delivery_ready: 0.5, consolidated_logistics: 0.4, quality_grade: 0.3 },
    concerns: ['delivery_ready', 'consolidated_logistics', 'quality_grade'],
    flexPerKg: 0.8,
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
    responsiveness: { quality_grade: 0.4, market_reference: 0.3, buyer_history: 0.3, volume: 0.2 },
    concerns: ['quality_grade', 'market_reference'],
    flexPerKg: 0.2,
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
  /** เหตุผลที่มีหลักฐานรองรับ (โค้ดฝั่งเราตรวจแล้ว) — ผู้ซื้อจำลองตัดสินใจจากส่วนนี้ */
  arguments?: ArgumentClaim[];
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
  /** ข้อโต้แย้งของผู้ซื้อ (ถ้ายังไม่ตกลง) */
  objection?: Objection;
  /** เหตุผลที่ผู้ซื้อยอมรับว่ามีน้ำหนักในรอบนี้ */
  acknowledged?: ArgumentTag[];
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
  /** เหตุผลแต่ละแบบถูกใช้ไปกี่ครั้งแล้ว */
  used: Partial<Record<ArgumentTag, number>>;
  /** ระดับที่ถูกโน้มน้าวสะสม (0–1) ใช้ยืดงบ */
  persuaded: number;
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

const TAG_LABEL: Record<ArgumentTag, string> = {
  market_reference: 'ราคาตลาดอ้างอิง',
  volume: 'ปริมาณรวม',
  quality_grade: 'เกรดและคุณภาพ',
  delivery_ready: 'ช่วงส่งมอบ',
  consolidated_logistics: 'การรวมขนส่ง',
  competing_offer: 'ข้อเสนอของผู้ซื้อรายอื่น',
  buyer_history: 'ราคาที่เคยซื้อขายกัน',
};

const CONCERN_TEXT: Record<ArgumentTag, string> = {
  market_reference: 'ราคาที่ขอสูงกว่าที่เราซื้อทั่วไป มีราคาอ้างอิงตลาดยืนยันไหม',
  volume: 'ปริมาณรวมเท่าไร พอให้เราลดต้นทุนรับซื้อได้จริงไหม',
  quality_grade: 'เราห่วงเรื่องเกรดและคุณภาพ มีข้อมูลยืนยันไหม',
  delivery_ready: 'ส่งมอบได้ตรงช่วงที่เราต้องการไหม',
  consolidated_logistics: 'รับของจากหลายแปลงเพิ่มต้นทุนเรา จัดรถรวมได้ไหม',
  competing_offer: 'ถ้าที่อื่นให้ดีกว่าจริงก็ว่ามา',
  buyer_history: 'ที่ผ่านมาเราซื้อขายกันที่ราคาเท่าไร',
};

/** เหตุผลที่ต้องมีราคาอ้างอิงสูงกว่าที่ผู้ซื้อให้อยู่ จึงจะมีน้ำหนัก */
const PRICE_TAGS: ArgumentTag[] = ['market_reference', 'competing_offer', 'buyer_history'];

export class MockBuyerApi {
  private sessions = new Map<string, Session>();
  private seq = 0;
  private readonly buyers: BuyerConfig[];

  /** ส่ง buyers เองได้ (เช่น สถานการณ์ใน eval) — ค่าเริ่มต้นคือผู้ซื้อจำลอง 4 ราย */
  constructor(opts: { buyers?: BuyerConfig[] } = {}) {
    this.buyers = opts.buyers ?? DEFAULT_BUYERS;
  }

  listBuyers(crop: Crop, grade: Grade, quantityKg: number): BuyerPublicProfile[] {
    return this.buyers.filter((b) => b.books[crop]?.[grade] && quantityKg >= b.minKg && quantityKg <= b.maxKg).map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type,
      province: b.province,
      minKg: b.minKg,
      maxKg: b.maxKg,
      paymentTermDays: b.paymentTermDays,
    }));
  }

  /** ข้อมูลสาธารณะของผู้ซื้อ 1 ราย (ไม่มีราคา reservation) */
  getProfile(buyerId: string): BuyerPublicProfile | undefined {
    const b = this.buyers.find((x) => x.id === buyerId);
    return b && { id: b.id, name: b.name, type: b.type, province: b.province, minKg: b.minKg, maxKg: b.maxKg, paymentTermDays: b.paymentTermDays };
  }

  requestQuote(buyerId: string, req: QuoteRequest): BuyerResponse {
    assertNoPrivateData(req);
    const buyer = this.buyers.find((b) => b.id === buyerId);
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
      used: {},
      persuaded: 0,
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

    // 2) เกินจำนวนรอบ → ถอนตัว
    if (s.round > buyer.maxRounds) {
      s.closed = true;
      return this.respond(s, 'walk_away', `${buyer.name} ขอยุติการเจรจา ข้อเสนอสุดท้ายคือ ${s.currentPerKg.toFixed(2)} บาท/กก.`);
    }

    // 3) ชั่งน้ำหนักเหตุผลรอบนี้ (ก่อนนับว่าใช้แล้ว)
    const prev = s.currentPerKg;
    const { power, acknowledged, weak, repeated } = this.weigh(s, counter.arguments ?? []);
    s.persuaded = Math.min(1, s.persuaded + power * 0.6);
    const budget = r2(book.reservationPerKg + buyer.flexPerKg * s.persuaded);
    const ackNote = acknowledged.length ? ` ข้อมูล${acknowledged.map((t) => TAG_LABEL[t]).join(' และ')}ที่ให้มามีน้ำหนัก` : '';

    // 4) ขอสูงเกินงบมาก → ไม่ขยับ (anchoring ที่เกินจริงทำให้เสียความน่าเชื่อถือ)
    if (ask > budget * 1.15) {
      const final = s.round === buyer.maxRounds;
      return this.respond(
        s,
        final ? 'final_offer' : 'counter',
        `${buyer.name} ยังยืนที่ ${prev.toFixed(2)} บาท/กก. ราคาที่ขอห่างจากที่ตลาดรับได้มากเกินไป${deductionNote}${this.deductionNote(s)}`,
        { code: 'unrealistic_ask', text: 'ราคาที่ขอสูงเกินจริงมาก ขอตัวเลขที่สมเหตุสมผลกว่านี้' },
        acknowledged,
      );
    }

    // 5) ขยับตามนิสัย + เหตุผลที่มีน้ำหนักทำให้ขยับมากขึ้น แต่ไม่เกินงบ
    let next: number;
    if (buyer.style === 'fair') next = prev + (ask - prev) * Math.min(0.9, (buyer.concedeRatio ?? 0.5) + 0.3 * power);
    else if (buyer.style === 'hidden_deduction' && deductionNote) next = prev; // ลดค่าหักแล้ว ไม่ขยับราคา
    else next = prev + (buyer.stepPerKg ?? 0.1) * (1 + 1.5 * power);
    next = r2(Math.min(next, budget));

    // ขอมาใกล้ราคาที่ผู้ซื้อจะขยับไปอยู่แล้ว (ห่างไม่เกิน 0.05) และไม่เกินงบ → รับราคาที่ขอ
    if (ask <= budget && r2(ask - next) <= 0.05) {
      s.currentPerKg = ask;
      s.closed = true;
      return this.respond(s, 'accept', `ตกลงที่ ${ask.toFixed(2)} บาท/กก.${ackNote}${deductionNote}${this.deductionNote(s)}`, undefined, acknowledged);
    }

    s.currentPerKg = next;
    const objection = this.objection(s, ask, budget, weak, repeated);
    if (next >= budget || s.round === buyer.maxRounds) {
      return this.respond(s, 'final_offer', `ราคาสุดท้ายของ${buyer.name}คือ ${next.toFixed(2)} บาท/กก.${ackNote}${deductionNote}${this.deductionNote(s)}`, objection, acknowledged);
    }
    return this.respond(s, 'counter', `${buyer.name} ขยับให้เป็น ${next.toFixed(2)} บาท/กก.${ackNote}${deductionNote}${this.deductionNote(s)}`, objection, acknowledged);
  }

  /** น้ำหนักของเหตุผลรอบนี้ (0–1): ตรงข้อกังวล × ยังไม่ซ้ำ × ถูกต้อง (ราคาอ้างอิงต้องสูงกว่าที่ให้อยู่จริง) */
  private weigh(s: Session, claims: ArgumentClaim[]) {
    const seen = new Set<ArgumentTag>();
    const acknowledged: ArgumentTag[] = [];
    let power = 0;
    let weak = false;
    let repeated = false;
    for (const c of claims) {
      if (seen.has(c.tag)) continue;
      seen.add(c.tag);
      const w = s.buyer.responsiveness[c.tag] ?? 0;
      const usedBefore = s.used[c.tag] ?? 0;
      s.used[c.tag] = usedBefore + 1;
      if (PRICE_TAGS.includes(c.tag) && !(typeof c.value === 'number' && c.value > s.currentPerKg)) {
        weak = true; // อ้างราคาที่ไม่สูงกว่าที่ผู้ซื้อให้อยู่ → ไม่มีน้ำหนัก
        continue;
      }
      if (usedBefore > 0) repeated = true;
      const eff = w * 0.5 ** usedBefore;
      if (eff >= 0.15) acknowledged.push(c.tag);
      power += eff;
    }
    return { power: Math.min(1, power), acknowledged, weak, repeated };
  }

  /** ข้อโต้แย้ง: ข้อกังวลที่ยังไม่ถูกตอบมาก่อน (พร้อมบอกถ้าราคายังเกินงบ) แล้วค่อยเป็นเรื่องราคา */
  private objection(s: Session, ask: number, budget: number, weak: boolean, repeated: boolean): Objection {
    const over = ask > budget;
    const open = s.buyer.concerns.find((c) => !s.used[c]);
    if (open) return { code: `need_${open}`, text: `${CONCERN_TEXT[open]}${over ? ' และราคาที่ขอยังเกินงบของเรา' : ''}` };
    if (weak) return { code: 'weak_evidence', text: 'ราคาอ้างอิงที่ยกมาไม่ได้สูงกว่าที่เราให้อยู่ จึงไม่ใช่เหตุผลให้ขึ้นราคา' };
    if (over) return { code: 'price_above_budget', text: 'ราคาที่ขอเกินงบที่เราตั้งไว้ ถ้าจะให้ขยับอีกต้องมีเงื่อนไขอื่นมาแลก' };
    if (repeated) return { code: 'repeated_argument', text: 'เหตุผลเดิมเราได้ฟังแล้ว ถ้าไม่มีข้อมูลใหม่ก็ขยับได้อีกไม่มาก' };
    return { code: 'final_stretch', text: 'เราใกล้ถึงงบที่ตั้งไว้แล้ว ขยับได้อีกไม่มาก' };
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

  private respond(s: Session, decision: BuyerDecision, message: string, objection?: Objection, acknowledged?: ArgumentTag[]): BuyerResponse {
    return {
      ...(objection ? { objection } : {}),
      ...(acknowledged?.length ? { acknowledged } : {}),
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
