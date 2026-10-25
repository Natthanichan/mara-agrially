// อ่านข้อความอิสระของเกษตรกรใน LINE → ผลผลิต (พืช ปริมาณ เกรด ราคาสุทธิขั้นต่ำ)
// ใช้กฎ regex ที่เทสได้และให้ผลเหมือนเดิมทุกครั้ง ไม่เรียก AI (ไม่มีค่าใช้จ่ายและไม่ต้องกลัวตีความผิดเรื่องตัวเลข)
// ถ้าอ่านไม่ครบ จะถามกลับว่าขาดอะไร และให้เกษตรกรกดยืนยันก่อนเริ่มเจรจาเสมอ

import type { Crop, Grade } from '../core/types.js';
import type { ListingDraft } from '../store/types.js';
import { CROP_LABEL_TH } from '../data/synthetic.js';
import { guessCrop } from './cropMatch.js';

export type ParseResult = { ok: true; draft: ListingDraft; gradeAssumed: boolean; cropNote?: string } | { ok: false; problems: string[] };

export const QUANTITY_LIMITS = { minKg: 10, maxKg: 1_000_000 };
export const FLOOR_LIMITS = { minBaht: 0.5, maxBaht: 1_000 };

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
export const normalize = (t: string) =>
  t
    .replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
    .replace(/[​ ]/g, ' ')
    .trim();

const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const UNIT = '(?:ตัน|กิโลกรัม|กิโล|กก\\.?|kg|KG|Kg)';
const toNumber = (s: string) => Number(s.replace(/,/g, ''));

const SUPPORTED_TH = 'ข้าวหอมมะลิ, ยางพารา, ข้าวโพดเลี้ยงสัตว์, มะระจีน, มันสำปะหลัง';

type CropFind = { crop: Crop; note?: string } | { problem: string };

/** หาพืชจากข้อความ (รองรับพิมพ์ผิด) · พิมพ์ผิดแล้วเดาได้ → แนบ note ให้ผู้ใช้ตรวจ · พืชที่ยังไม่รองรับ → บอกตรง ๆ ไม่เดาเป็นพืชอื่น */
export function findCrop(t: string): CropFind | undefined {
  const g = guessCrop(t);
  switch (g.kind) {
    case 'exact':
      return { crop: g.crop };
    case 'fuzzy':
      return { crop: g.crop, note: `หนูเข้าใจว่า “${g.typed}” คือ${CROP_LABEL_TH[g.crop]}นะคะ ถ้าไม่ใช่กดแก้ไขได้เลยค่ะ` };
    case 'unsupported':
      return { problem: `ตอนนี้น้องมะระยังไม่มีกลุ่มเกษตรกรที่ขาย${g.name}${g.fuzzy ? ` (หนูเข้าใจว่าพิมพ์ว่า ${g.name})` : ''}ค่ะ ระบบรองรับ ${SUPPORTED_TH}` };
    case 'ambiguous':
      return { problem: 'พบพืชมากกว่า 1 ชนิด ขอรายการละ 1 ชนิดต่อข้อความนะคะ' };
    default:
      return undefined;
  }
}

// เลขคำไทยที่อยู่หน้าหน่วย เช่น "แปดตัน" "สองร้อยกิโล" "ยี่สิบห้าตัน" (ผู้สูงอายุมักพิมพ์เป็นคำ)
const DIGIT_WORD: Record<string, number> = { ศูนย์: 0, หนึ่ง: 1, เอ็ด: 1, ยี่: 2, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9 };
const PLACE_WORD: Record<string, number> = { สิบ: 10, ร้อย: 100, พัน: 1000, หมื่น: 10_000, แสน: 100_000 };
const THAI_NUM_WORDS = new RegExp(`((?:${[...Object.keys(DIGIT_WORD), ...Object.keys(PLACE_WORD)].join('|')})+)(?=\\s*${UNIT})`, 'g');

export function thaiWordsToNumber(w: string): number | undefined {
  const tokens = w.match(new RegExp([...Object.keys(DIGIT_WORD), ...Object.keys(PLACE_WORD)].sort((a, b) => b.length - a.length).join('|'), 'g'));
  if (!tokens || tokens.join('') !== w) return undefined;
  let total = 0;
  let digit: number | undefined;
  for (const tk of tokens) {
    if (tk in DIGIT_WORD) {
      if (digit !== undefined) return undefined; // "สองสาม" ไม่ใช่ตัวเลขที่ชัด
      digit = DIGIT_WORD[tk]!;
    } else {
      total += (digit ?? 1) * PLACE_WORD[tk]!;
      digit = undefined;
    }
  }
  return total + (digit ?? 0);
}

export function findQuantityKg(raw: string): number | undefined {
  const t = raw.replace(THAI_NUM_WORDS, (w) => String(thaiWordsToNumber(w) ?? w));
  const m = new RegExp(`${NUM}\\s*(${UNIT})`).exec(t);
  if (!m) return undefined;
  const n = toNumber(m[1]!);
  return m[2] === 'ตัน' ? n * 1000 : n;
}

function findFloor(t: string): number | undefined {
  // เลขที่ตามด้วยหน่วยน้ำหนักคือปริมาณ ไม่ใช่ราคา · (?![\d,]|\.\d) กัน regex ถอยไปจับเลขแค่บางหลัก (เช่น 10 → 1)
  const notQty = `(?![\\d,]|\\.\\d)(?!\\s*${UNIT})`;
  const byKeyword = new RegExp(`(?:ขั้นต่ำ|ต่ำสุด|ไม่ต่ำกว่า|ไม่ถูกกว่า|floor|ราคาขาย|ราคา)\\s*(?:ที่|อยู่ที่|=|:)?\\s*${NUM}${notQty}`, 'i').exec(t);
  if (byKeyword) return toNumber(byKeyword[1]!);
  const byUnit = new RegExp(`${NUM}\\s*บาท`).exec(t);
  return byUnit ? toNumber(byUnit[1]!) : undefined;
}

const GRADE_MAP: Record<string, Grade> = { a: 'A', b: 'B', c: 'C', เอ: 'A', บี: 'B', ซี: 'C' };
function findGrade(t: string): Grade | undefined {
  const m = /เกรด\s*(เอ|บี|ซี|[ABCabc])(?![A-Za-z])/.exec(t);
  return m ? GRADE_MAP[m[1]!.toLowerCase()] : undefined;
}

export function parseListing(raw: string): ParseResult {
  const t = normalize(raw);
  const problems: string[] = [];

  const found = findCrop(t);
  if (found === undefined) problems.push(`ยังไม่ทราบว่าเป็นพืชอะไร (ระบบรองรับ ${SUPPORTED_TH})`);
  else if ('problem' in found) problems.push(found.problem);
  const crop = found && 'crop' in found ? found.crop : undefined;

  const quantityKg = findQuantityKg(t);
  if (quantityKg === undefined) problems.push('ยังไม่ทราบปริมาณ (เช่น 12 ตัน หรือ 12000 กก.)');
  else if (!(quantityKg >= QUANTITY_LIMITS.minKg && quantityKg <= QUANTITY_LIMITS.maxKg)) problems.push(`ปริมาณต้องอยู่ระหว่าง ${QUANTITY_LIMITS.minKg.toLocaleString('en-US')} ถึง ${QUANTITY_LIMITS.maxKg.toLocaleString('en-US')} กก.`);

  const floor = findFloor(t);
  if (floor === undefined) problems.push('ยังไม่ทราบราคาสุทธิขั้นต่ำที่คุณยอมรับได้ (เช่น ขั้นต่ำ 17 บาท/กก.)');
  else if (!(floor >= FLOOR_LIMITS.minBaht && floor <= FLOOR_LIMITS.maxBaht)) problems.push(`ราคาขั้นต่ำต้องอยู่ระหว่าง ${FLOOR_LIMITS.minBaht} ถึง ${FLOOR_LIMITS.maxBaht} บาท/กก.`);

  if (problems.length || crop === undefined || quantityKg === undefined || floor === undefined) return { ok: false, problems };

  const grade = findGrade(t);
  return { ok: true, gradeAssumed: grade === undefined, ...(found && 'note' in found && found.note ? { cropNote: found.note } : {}), draft: { crop, quantityKg: Math.round(quantityKg * 100) / 100, grade: grade ?? 'A', floorPricePerKg: Math.round(floor * 100) / 100 } };
}

// ---------- ฝั่งผู้ซื้อ: ตอบทีละข้อ (แต่ละคำตอบมีข้อมูลเดียว จึงอ่านง่ายกว่าข้อความอิสระ) ----------

export type Field<T> = { ok: true; value: T; note?: string } | { ok: false; problem: string };

export function parseBuyerCrop(raw: string): Field<Crop> {
  const c = findCrop(normalize(raw));
  if (c === undefined) return { ok: false, problem: `ยังไม่ทราบว่าต้องการพืชอะไรคะ (รองรับ ${SUPPORTED_TH})` };
  if ('problem' in c) return { ok: false, problem: c.problem };
  return { ok: true, value: c.crop, ...(c.note ? { note: c.note } : {}) };
}

/** ตัวเลขเปล่าไม่มีหน่วย (เช่น "10") → ต้องถามหน่วยก่อน ไม่เดา */
export function bareNumber(raw: string): number | undefined {
  const m = new RegExp(`^${NUM}$`).exec(normalize(raw));
  return m ? toNumber(m[1]!) : undefined;
}

/** รับ "10 ตัน", "10 กิโล", "10000 กก." · เลขเปล่าจะถามหน่วยกลับ (กันอ่าน 10 เป็น 10 ตัน หรือ 10 กก. ผิด) */
export function parseBuyerQuantity(raw: string): Field<number> {
  const t = normalize(raw);
  const kg = findQuantityKg(t);
  if (kg === undefined) {
    const n = bareNumber(t);
    if (n !== undefined) return { ok: false, problem: `${n.toLocaleString('en-US')} กิโลกรัม หรือ ${n.toLocaleString('en-US')} ตันคะ กดเลือกด้านล่างได้เลยค่ะ` };
    return { ok: false, problem: 'ยังไม่ทราบปริมาณค่ะ ตอบเช่น 10 ตัน หรือ 500 กิโล' };
  }
  if (!(kg >= QUANTITY_LIMITS.minKg && kg <= QUANTITY_LIMITS.maxKg)) return { ok: false, problem: `ปริมาณต้องอยู่ระหว่าง ${QUANTITY_LIMITS.minKg.toLocaleString('en-US')} ถึง ${QUANTITY_LIMITS.maxKg.toLocaleString('en-US')} กก. ค่ะ` };
  return { ok: true, value: Math.round(kg * 100) / 100 };
}

export function parseBuyerLocation(raw: string): Field<string> {
  const v = normalize(raw).replace(/\s+/g, ' ').replace(/^(ส่ง(ที่|ไป)?|สถานที่(ส่ง)?)\s*/, '');
  if (v.length < 2) return { ok: false, problem: 'ขอสถานที่ส่งมอบหน่อยค่ะ เช่น โรงสี ต.บางพลี จ.สมุทรปราการ' };
  if (v.length > 100) return { ok: false, problem: 'ที่อยู่ยาวเกินไปค่ะ ขอไม่เกิน 100 ตัวอักษร' };
  return { ok: true, value: v };
}

export function parseBuyerPrice(raw: string): Field<number> {
  const m = new RegExp(`^(?:ราคา)?\\s*${NUM}\\s*(?:บาท)?\\s*(?:/|ต่อ)?\\s*(?:กก\\.?|กิโลกรัม|กิโล|kg)?$`, 'i').exec(normalize(raw));
  if (!m) return { ok: false, problem: 'ขอเป็นตัวเลขราคาต่อกก. ค่ะ เช่น 18.5' };
  const n = toNumber(m[1]!);
  if (!(n >= FLOOR_LIMITS.minBaht && n <= FLOOR_LIMITS.maxBaht)) return { ok: false, problem: `ราคาต้องอยู่ระหว่าง ${FLOOR_LIMITS.minBaht} ถึง ${FLOOR_LIMITS.maxBaht} บาท/กก. ค่ะ` };
  return { ok: true, value: Math.round(n * 100) / 100 };
}
