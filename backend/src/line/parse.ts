// อ่านข้อความอิสระของเกษตรกรใน LINE → ผลผลิต (พืช ปริมาณ เกรด ราคาสุทธิขั้นต่ำ)
// ใช้กฎ regex ที่เทสได้และให้ผลเหมือนเดิมทุกครั้ง ไม่เรียก AI (ไม่มีค่าใช้จ่ายและไม่ต้องกลัวตีความผิดเรื่องตัวเลข)
// ถ้าอ่านไม่ครบ จะถามกลับว่าขาดอะไร และให้เกษตรกรกดยืนยันก่อนเริ่มเจรจาเสมอ

import type { Crop, Grade } from '../core/types.js';
import type { ListingDraft } from '../store/types.js';

export type ParseResult = { ok: true; draft: ListingDraft; gradeAssumed: boolean } | { ok: false; problems: string[] };

export const QUANTITY_LIMITS = { minKg: 100, maxKg: 1_000_000 };
export const FLOOR_LIMITS = { minBaht: 0.5, maxBaht: 1_000 };

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const normalize = (t: string) =>
  t
    .replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
    .replace(/[​ ]/g, ' ')
    .trim();

const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const UNIT = '(?:ตัน|กิโลกรัม|กิโล|กก\\.?|kg|KG|Kg)';
const toNumber = (s: string) => Number(s.replace(/,/g, ''));

const CROP_WORDS: [Crop, RegExp][] = [
  ['bitter_gourd', /มะระ/],
  ['cassava', /มันสำปะหลัง|มันสำประหลัง|มันเส้น|มัน(?!ฝรั่ง)/],
  ['rice_hommali', /ข้าว/],
];

function findCrop(t: string): Crop | 'ambiguous' | undefined {
  const hits = CROP_WORDS.filter(([, re]) => re.test(t)).map(([c]) => c);
  if (hits.length === 0) return undefined;
  return hits.length === 1 ? hits[0] : 'ambiguous';
}

function findQuantityKg(t: string): number | undefined {
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

  const crop = findCrop(t);
  if (crop === undefined) problems.push('ยังไม่ทราบว่าเป็นพืชอะไร (ระบบรองรับ ข้าวหอมมะลิ, มะระจีน, มันสำปะหลัง)');
  else if (crop === 'ambiguous') problems.push('พบพืชมากกว่า 1 ชนิด ขอรายการละ 1 ชนิดต่อข้อความ');

  const quantityKg = findQuantityKg(t);
  if (quantityKg === undefined) problems.push('ยังไม่ทราบปริมาณ (เช่น 12 ตัน หรือ 12000 กก.)');
  else if (!(quantityKg >= QUANTITY_LIMITS.minKg && quantityKg <= QUANTITY_LIMITS.maxKg)) problems.push(`ปริมาณต้องอยู่ระหว่าง ${QUANTITY_LIMITS.minKg.toLocaleString('en-US')} ถึง ${QUANTITY_LIMITS.maxKg.toLocaleString('en-US')} กก.`);

  const floor = findFloor(t);
  if (floor === undefined) problems.push('ยังไม่ทราบราคาสุทธิขั้นต่ำที่คุณยอมรับได้ (เช่น ขั้นต่ำ 17 บาท/กก.)');
  else if (!(floor >= FLOOR_LIMITS.minBaht && floor <= FLOOR_LIMITS.maxBaht)) problems.push(`ราคาขั้นต่ำต้องอยู่ระหว่าง ${FLOOR_LIMITS.minBaht} ถึง ${FLOOR_LIMITS.maxBaht} บาท/กก.`);

  if (problems.length || crop === undefined || crop === 'ambiguous' || quantityKg === undefined || floor === undefined) return { ok: false, problems };

  const grade = findGrade(t);
  return { ok: true, gradeAssumed: grade === undefined, draft: { crop, quantityKg: Math.round(quantityKg * 100) / 100, grade: grade ?? 'A', floorPricePerKg: Math.round(floor * 100) / 100 } };
}
