// เดาว่าผู้ใช้พิมพ์ถึงพืชอะไร แม้พิมพ์ผิด/พิมพ์เบียด (เช่น "กล้สย" → กล้วย, "ข้าวโพก" → ข้าวโพด)
// ใช้พจนานุกรม + ระยะแก้คำ (edit distance) ไม่เรียก AI จึงให้ผลเหมือนเดิมทุกครั้งและไม่มีค่าใช้จ่าย

import type { Crop } from '../core/types.js';

/** พืชที่ระบบรองรับ: ชื่อเรียกต่าง ๆ (เรียงคำยาวก่อน เพื่อให้ "ข้าวโพด" ไม่ถูกจับเป็น "ข้าว") */
const SUPPORTED: { crop: Crop; words: string[] }[] = [
  { crop: 'corn', words: ['ข้าวโพดเลี้ยงสัตว์', 'ข้าวโพด', 'โพด', 'corn', 'maize'] },
  { crop: 'rice_hommali', words: ['ข้าวเปลือกหอมมะลิ', 'ข้าวหอมมะลิ', 'ข้าวเปลือก', 'หอมมะลิ', 'ข้าวนาปี', 'ข้าว', 'rice'] },
  { crop: 'rubber', words: ['ยางพาราแผ่นดิบ', 'ยางแผ่นดิบ', 'ยางพารา', 'น้ำยางสด', 'น้ำยาง', 'ยางก้อน', 'ยาง', 'rubber'] },
  { crop: 'bitter_gourd', words: ['มะระจีน', 'มะระขี้นก', 'มะระ', 'bitter gourd'] },
  { crop: 'cassava', words: ['มันสำปะหลัง', 'มันสำประหลัง', 'มันเส้น', 'มันสด', 'cassava'] },
];

/** พืชที่รู้จักแต่ระบบยังไม่มีกลุ่มเกษตรกร (ตอบได้ว่า "ยังไม่รองรับ" แทนการเดาผิดเป็นพืชอื่น) */
const KNOWN_UNSUPPORTED = [
  'กล้วย', 'ทุเรียน', 'มะม่วง', 'ลำไย', 'มังคุด', 'เงาะ', 'ลิ้นจี่', 'ส้ม', 'มะพร้าว', 'สับปะรด', 'อ้อย', 'ปาล์มน้ำมัน', 'ปาล์ม',
  'กาแฟ', 'พริก', 'กระเทียม', 'หอมแดง', 'ถั่วเหลือง', 'ถั่วเขียว', 'มันฝรั่ง', 'ผักกาด', 'คะน้า', 'แตงกวา', 'มะเขือ', 'ฟักทอง', 'ข้าวเหนียว',
];

export type CropGuess =
  | { kind: 'exact'; crop: Crop }
  | { kind: 'fuzzy'; crop: Crop; typed: string; meant: string }
  | { kind: 'unsupported'; name: string; fuzzy: boolean }
  | { kind: 'ambiguous'; crops: Crop[] }
  | { kind: 'none' };

/** ระยะแก้คำแบบ Damerau (สลับตัวอักษรติดกันนับเป็น 1) */
export function editDistance(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const d: number[][] = Array.from({ length: A.length + 1 }, (_, i) => Array.from({ length: B.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= A.length; i++)
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[A.length]![B.length]!;
}

/** ยอมให้ผิดได้กี่ตัว: คำ ≤3 ตัวอักษร (เช่น ยาง มะระ) ต้องตรงเป๊ะ กันเดา "บาง" เป็น "ยาง" · 4–6 ผิดได้ 1 · ยาวกว่านั้นผิดได้ 2 */
const tolerance = (word: string) => ([...word].length <= 3 ? 0 : [...word].length <= 6 ? 1 : 2);

/** ตัดข้อความเป็นช่วงที่อาจเป็นชื่อพืช (ไทยไม่เว้นวรรค จึงตัดที่ตัวเลข เว้นวรรค และคำหน่วย/คำทั่วไป) */
function segments(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[0-9๐-๙.,/:]+/g, ' ')
    .replace(/ตัน|กิโลกรัม|กิโล|กก|บาท|ขั้นต่ำ|ราคา|อยากได้|ต้องการ|เกรด|สนใจ|ครับ|ค่ะ|คะ/g, ' ')
    .split(/\s+/)
    .filter((s) => [...s].length >= 2);
}

/** ช่วงย่อยความยาวใกล้กับคำในพจนานุกรม (หาชื่อพืชที่ฝังอยู่ในข้อความยาว) */
function windows(seg: string, len: number): string[] {
  const chars = [...seg];
  if (chars.length <= len + 1) return [seg];
  const out: string[] = [];
  for (const L of [len - 1, len, len + 1]) for (let i = 0; i + L <= chars.length; i++) out.push(chars.slice(i, i + L).join(''));
  return out;
}

/** พืชที่ถูกพูดถึงในข้อความ (ตรงตัว) — ใช้ตรวจว่าคำตอบของ AI หลุดไปพูดพืชอื่นหรือไม่ */
export function cropsMentioned(text: string): Crop[] {
  let rest = text.toLowerCase();
  const out = new Set<Crop>();
  for (const { crop, w } of SUPPORTED.flatMap(({ crop, words }) => words.map((w) => ({ crop, w }))).sort((a, b) => b.w.length - a.w.length)) {
    if (rest.includes(w)) {
      out.add(crop);
      rest = rest.split(w).join(' ');
    }
  }
  return [...out];
}

export function guessCrop(raw: string): CropGuess {
  const t = raw.toLowerCase();
  // 1) ตรงตัว: ตัดคำที่ยาวที่สุดออกก่อน เพื่อให้ "ข้าวโพด" ไม่ถูกนับเป็น "ข้าว" ด้วย
  let rest = t;
  const hits = new Map<Crop, string>();
  const all = SUPPORTED.flatMap(({ crop, words }) => words.map((w) => ({ crop, w }))).sort((a, b) => b.w.length - a.w.length);
  for (const { crop, w } of all) {
    if (rest.includes(w)) {
      if (!hits.has(crop)) hits.set(crop, w);
      rest = rest.split(w).join(' ');
    }
  }
  if (hits.size === 1) {
    const [crop, w] = [...hits][0]!;
    // "ข้าวโพก" มีคำว่า "ข้าว" แต่จริง ๆ ใกล้ "ข้าวโพด" มากกว่า → ถ้าคำยาวของพืชอื่นที่ครอบคำนี้อยู่ใกล้พอ ให้เดาเป็นพืชนั้น
    const longer = all.filter((x) => x.crop !== crop && x.w.includes(w) && tolerance(x.w) > 0);
    for (const seg of segments(t))
      for (const x of longer)
        for (const win of windows(seg, [...x.w].length))
          if (win.includes(w) && editDistance(win, x.w) <= tolerance(x.w)) return { kind: 'fuzzy', crop: x.crop, typed: win, meant: x.w };
    return { kind: 'exact', crop };
  }
  if (hits.size > 1) return { kind: 'ambiguous', crops: [...hits.keys()] };
  const unsupportedExact = KNOWN_UNSUPPORTED.find((w) => t.includes(w));
  if (unsupportedExact) return { kind: 'unsupported', name: unsupportedExact, fuzzy: false };

  // 2) พิมพ์ผิด: หาคำในพจนานุกรมที่ใกล้ที่สุด
  let best: { dist: number; crop?: Crop; meant: string; typed: string } | undefined;
  const dict = [...all.map(({ crop, w }) => ({ crop: crop as Crop | undefined, w })), ...KNOWN_UNSUPPORTED.map((w) => ({ crop: undefined, w }))];
  for (const seg of segments(t))
    for (const { crop, w } of dict) {
      const tol = tolerance(w);
      if (!tol) continue;
      for (const win of windows(seg, [...w].length)) {
        const dist = editDistance(win, w);
        if (dist <= tol && (!best || dist < best.dist || (dist === best.dist && w.length > best.meant.length))) best = { dist, crop, meant: w, typed: win };
      }
    }
  if (!best) return { kind: 'none' };
  return best.crop ? { kind: 'fuzzy', crop: best.crop, typed: best.typed, meant: best.meant } : { kind: 'unsupported', name: best.meant, fuzzy: true };
}
