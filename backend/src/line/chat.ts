// แชตอัจฉริยะของน้องมะระใน LINE (Amazon Nova) — คุยเป็นธรรมชาติกับเกษตรกรและผู้ซื้อ
// กติกา:
//  - Nova เห็นเฉพาะบริบทที่โค้ดเตรียมให้ (ดีลของผู้ใช้คนนี้, ราคาตลาด, ข้อมูลกลุ่มแบบรวม) — ไม่มีราคาขั้นต่ำของคนอื่น
//  - ตัวเลขในคำตอบต้องมีอยู่ในบริบทหรือในข้อความของผู้ใช้ ไม่งั้นให้ตอบใหม่ 1 ครั้ง แล้วค่อยตอบแบบปลอดภัย
//  - Nova "เสนอ" รายการผลผลิต/คำขอซื้อได้ผ่าน tool แต่โค้ดตรวจค่าทุกตัว และผู้ใช้ต้องกดยืนยันเองเสมอ
//  - อนุมัติ/ไม่เอา/ต่อรองใหม่ ทำผ่านปุ่มเท่านั้น แชตทำแทนไม่ได้

import type { Crop, Grade } from '../core/types.js';
import { extractNumbers, numbersNeedingEvidence } from '../agent/guardrails.js';
import type { LlmClient, Message, ToolSpec } from '../agent/llm/types.js';
import { isText, isToolUse } from '../agent/llm/types.js';
import type { BuyerDraft, ListingDraft } from '../store/types.js';
import { FLOOR_LIMITS, QUANTITY_LIMITS } from './parse.js';

export interface ChatTurn {
  r: 'u' | 'a';
  t: string;
}

export type ChatAction =
  | { kind: 'reply'; text: string }
  | { kind: 'listing'; text: string; draft: ListingDraft; gradeAssumed: boolean }
  | { kind: 'buyer_request'; text: string; draft: Required<Omit<BuyerDraft, 'step'>> };

const CROPS: Crop[] = ['rice_hommali', 'bitter_gourd', 'cassava'];
const GRADES: Grade[] = ['A', 'B', 'C'];
export const MAX_HISTORY = 6;
const TIMEOUT_MS = 9000;

const PERSONA = `คุณคือ "น้องมะระ" ผู้ช่วย AI ของแพลตฟอร์ม MaRa-AgriAlly ที่รวมผลผลิตเกษตรกรรายย่อยแล้วเจรจาขายแทนกลุ่ม
บุคลิก: ผู้หญิง สุภาพ อบอุ่น เรียกตัวเองว่า "หนู" หรือ "น้องมะระ" เท่านั้น ลงท้าย "ค่ะ/คะ" เสมอ ห้ามใช้ "ฉัน" "ดิฉัน" "ครับ" หรือ "ผม"
ตอบสั้น 1–4 ประโยค เป็นภาษาไทยที่เข้าใจง่าย
กฎ:
- ใช้เฉพาะข้อมูลในบริบท (JSON) ด้านล่าง ตัวเลขทุกตัวต้องมาจากบริบทหรือข้อความของผู้ใช้เท่านั้น ถ้าไม่มีข้อมูลให้บอกตรง ๆ ว่าไม่ทราบ
- ห้ามแต่งราคาคนกลาง สถิติ หรือคำมั่นของผู้ซื้อ ห้ามสัญญาว่าจะได้ราคาเท่าไร
- ห้ามบอกหรือเดาราคาขั้นต่ำของสมาชิกคนอื่น
- อนุมัติ ไม่เอา หรือต่อรองใหม่ ต้องกดปุ่มในการ์ดเท่านั้น หนูทำแทนไม่ได้
- ข้อมูลทั้งหมดเป็นการจำลองเพื่อทดสอบระบบ`;

const FARMER_PROMPT = `${PERSONA}
คุณกำลังคุยกับ "เกษตรกร" อธิบายผลเจรจา (ดู lastDeal.rounds: แต่ละรอบหนูอ้างหลักฐานอะไร ผู้ซื้อตอบอย่างไร) ราคาสุทธิ และตอบคำถามทั่วไปเรื่องการขาย
ถ้าเกษตรกรบอกผลผลิตที่จะขาย ให้เรียก propose_listing (ต้องรู้พืช ปริมาณ และราคาสุทธิขั้นต่ำที่ยอมรับได้ ถ้าขาดอย่างใดให้ถามก่อน ห้ามเดาราคาขั้นต่ำ)`;

const BUYER_PROMPT = `${PERSONA}
คุณกำลังคุยกับ "ผู้ซื้อ" ในฐานะตัวแทนกลุ่มเกษตรกร ตอบคำถามเรื่องกลุ่มเกษตรกรและผลผลิต และอธิบายอย่างสุภาพและโน้มน้าวว่าทำไมราคาที่ขอจึงสมเหตุสมผล
ใช้หลักฐานในบริบท: ราคาตลาด NABC (market), ปริมาณรวมและจำนวนสมาชิก, เกรด, การรวมขนส่ง, ช่วงส่งมอบ — ถ้าข้อมูลไหนไม่มีในบริบท ห้ามอ้าง
หนูไม่รู้ราคาขั้นต่ำของเกษตรกร และตกลงราคาแทนเกษตรกรไม่ได้ การตกลงทุกครั้งต้องให้เกษตรกรอนุมัติในระบบ
ถ้าผู้ซื้อบอกความต้องการซื้อ (พืช ปริมาณ สถานที่ส่ง ราคาที่เสนอ) ให้เรียก propose_buyer_request ถ้าข้อมูลไม่ครบให้ถาม`;

const NEGOTIATOR_PROMPT = `${PERSONA}
คุณกำลัง "เจรจาราคา" กับผู้ซื้อในฐานะตัวแทนกลุ่มเกษตรกร
ระบบ (โค้ด) ตัดสินแล้วว่ารอบนี้ต้องทำอะไร ดู context.decision และต้องสื่อสารตามนั้นเท่านั้น:
- accept → บอกว่าราคา agreedPerKg บาท/กก. กลุ่มรับได้ และขอให้ผู้ซื้อกดปุ่มยืนยันราคานี้ก่อน (ยังไม่ถือว่าตกลงจนกว่าจะกดยืนยัน)
- counter → บอกชัดว่ายังรับราคาที่ผู้ซื้อเสนอไม่ได้ แล้วเสนอ askPerKg บาท/กก. พร้อมเหตุผล 1–2 ข้อจากหลักฐานใน context.evidence ที่ตอบสิ่งที่ผู้ซื้อเพิ่งพูด (ถ้าผู้ซื้อกังวลเรื่องราคาตลาด อ้างราคา NABC ถ้ากังวลเรื่องปริมาณ/การรับของ อ้างปริมาณรวม/รถรวม)
- final → บอกว่า askPerKg บาท/กก. เป็นราคาสุดท้ายที่กลุ่มรับได้ และขอบคุณ
- question → ตอบคำถามของผู้ซื้อจากบริบท แล้วย้ำว่าราคาที่เสนออยู่คือ askPerKg บาท/กก.
ห้ามเสนอหรือยอมราคาอื่นนอกจากที่ระบุ ห้ามลดราคาเอง ห้ามพูดว่าจะ "เสนอราคาของผู้ซื้อให้กลุ่มพิจารณา" ห้ามใช้ markdown (เช่น ** หรือ #) ตอบไม่เกิน 4 ประโยค ห้ามใช้เหตุผลซ้ำกับที่เคยพูดในประวัติ ถ้ามีหลักฐานอื่นให้ใช้
หนูไม่รู้ราคาขั้นต่ำของเกษตรกร และไม่ต้องพูดถึง`;

const LISTING_TOOL: ToolSpec = {
  name: 'propose_listing',
  description: 'เสนอรายการผลผลิตให้เกษตรกรกดยืนยัน (ยังไม่เริ่มเจรจาจนกว่าเกษตรกรกดยืนยัน)',
  inputSchema: {
    json: {
      type: 'object',
      properties: {
        crop: { type: 'string', enum: CROPS },
        quantity_kg: { type: 'number' },
        grade: { type: 'string', enum: GRADES, description: 'ถ้าเกษตรกรไม่ได้บอก ไม่ต้องใส่' },
        floor_price_per_kg: { type: 'number', description: 'ราคาสุทธิขั้นต่ำที่เกษตรกรบอกเอง' },
        reply: { type: 'string', description: 'ข้อความสั้นถึงเกษตรกร' },
      },
      required: ['crop', 'quantity_kg', 'floor_price_per_kg', 'reply'],
    },
  },
};

const BUYER_TOOL: ToolSpec = {
  name: 'propose_buyer_request',
  description: 'เสนอคำขอซื้อให้ผู้ซื้อกดยืนยัน',
  inputSchema: {
    json: {
      type: 'object',
      properties: {
        crop: { type: 'string', enum: CROPS },
        quantity_kg: { type: 'number' },
        location: { type: 'string', description: 'สถานที่ส่งมอบ' },
        offer_per_kg: { type: 'number', description: 'ราคาที่ผู้ซื้อเสนอต่อกก.' },
        reply: { type: 'string', description: 'ข้อความสั้นถึงผู้ซื้อ' },
      },
      required: ['crop', 'quantity_kg', 'location', 'offer_per_kg', 'reply'],
    },
  },
};

/** ตัวเลขทั้งหมดในบริบท/ประวัติ/ข้อความผู้ใช้ — คำตอบอ้างได้เฉพาะตัวเลขเหล่านี้ */
function allowedNumbers(context: unknown, history: ChatTurn[], message: string): number[] {
  const nums = [...extractNumbers(JSON.stringify(context)), ...extractNumbers(message), ...history.flatMap((h) => extractNumbers(h.t))];
  for (const n of [...nums]) if (n >= 1000) nums.push(n / 1000); // กก. → ตัน
  return nums;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
export const inventedNumbers = (text: string, allowed: number[]) => numbersNeedingEvidence(text).filter((n) => !allowed.some((a) => near(a, n)));

/** ประวัติ → ข้อความสลับ user/assistant ตามที่ Converse API ต้องการ (เริ่มด้วย user) */
function toMessages(history: ChatTurn[], message: string): Message[] {
  const out: Message[] = [];
  for (const h of [...history.slice(-MAX_HISTORY), { r: 'u' as const, t: message }]) {
    const role = h.r === 'u' ? 'user' : 'assistant';
    const last = out.at(-1);
    if (last?.role === role) (last.content[0] as { text: string }).text += `\n${h.t}`;
    else out.push({ role, content: [{ text: h.t }] });
  }
  while (out[0]?.role === 'assistant') out.shift();
  return out;
}

function validListing(i: Record<string, unknown>): { draft: ListingDraft; gradeAssumed: boolean } | undefined {
  const crop = CROPS.find((c) => c === i.crop);
  const qty = Number(i.quantity_kg);
  const floor = Number(i.floor_price_per_kg);
  const grade = GRADES.find((g) => g === i.grade);
  if (!crop || !(qty >= QUANTITY_LIMITS.minKg && qty <= QUANTITY_LIMITS.maxKg) || !(floor >= FLOOR_LIMITS.minBaht && floor <= FLOOR_LIMITS.maxBaht)) return undefined;
  return { draft: { crop, quantityKg: Math.round(qty * 100) / 100, grade: grade ?? 'A', floorPricePerKg: Math.round(floor * 100) / 100 }, gradeAssumed: !grade };
}

function validBuyerRequest(i: Record<string, unknown>): Required<Omit<BuyerDraft, 'step'>> | undefined {
  const crop = CROPS.find((c) => c === i.crop);
  const qty = Number(i.quantity_kg);
  const offer = Number(i.offer_per_kg);
  const location = typeof i.location === 'string' ? i.location.trim().slice(0, 100) : '';
  if (!crop || location.length < 2 || !(qty >= QUANTITY_LIMITS.minKg && qty <= QUANTITY_LIMITS.maxKg) || !(offer >= FLOOR_LIMITS.minBaht && offer <= FLOOR_LIMITS.maxBaht)) return undefined;
  return { crop, quantityKg: Math.round(qty * 100) / 100, location, offerPerKg: Math.round(offer * 100) / 100 };
}

/** น้องมะระเป็นผู้หญิง: แก้สรรพนาม/คำลงท้ายที่โมเดลเผลอใช้ */
export const voice = (t: string) =>
  t
    .replace(/ดิฉัน|ฉัน/g, 'หนู')
    .replace(/ครับผม|ครับ/g, 'ค่ะ')
    // LINE ไม่แสดง markdown → ตัดเครื่องหมายออก
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,6}\s*/gm, '');

const SAFE_REPLY = 'ขอโทษค่ะ เรื่องนี้หนูยังไม่มีข้อมูลที่ยืนยันได้ จึงขอไม่ตอบเป็นตัวเลขนะคะ ลองถามเรื่องดีลของคุณ ราคาตลาด หรือพิมพ์ “เมนู” ได้เลยค่ะ';

/** คุยกับ Nova 1 รอบ (ตอบใหม่ได้อีก 1 ครั้งถ้ามีตัวเลขที่ไม่มีหลักฐาน) */
export async function smartChat(
  llm: LlmClient,
  opts: { role: 'farmer' | 'buyer' | 'negotiator'; context: unknown; history: ChatTurn[]; message: string },
): Promise<ChatAction> {
  const prompt = opts.role === 'farmer' ? FARMER_PROMPT : opts.role === 'buyer' ? BUYER_PROMPT : NEGOTIATOR_PROMPT;
  const system = `${prompt}\n\nบริบท (JSON):\n${JSON.stringify(opts.context)}`;
  const tools = opts.role === 'farmer' ? [LISTING_TOOL] : opts.role === 'buyer' ? [BUYER_TOOL] : [];
  const allowed = allowedNumbers(opts.context, opts.history, opts.message);
  const messages = toMessages(opts.history, opts.message);

  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await llm.converse({ system, messages, tools, maxTokens: 700, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = res.content.filter(isText).map((b) => b.text.trim()).filter(Boolean).join('\n');
    const use = res.content.find(isToolUse);
    const input = (use?.toolUse.input ?? {}) as Record<string, unknown>;
    const said = voice(typeof input.reply === 'string' && input.reply.trim() ? input.reply.trim() : text);

    if (use?.toolUse.name === 'propose_listing' && opts.role === 'farmer') {
      const v = validListing(input);
      // ตัวเลขในรายการต้องมาจากข้อความของผู้ใช้ (กัน AI เดาราคาขั้นต่ำแทนเกษตรกร)
      const fromUser = allowedNumbers({}, opts.history, opts.message);
      if (v && fromUser.some((n) => near(n, v.draft.floorPricePerKg))) {
        return { kind: 'listing', text: inventedNumbers(said, allowed).length ? 'หนูสรุปรายการให้แล้วค่ะ ตรวจแล้วกดยืนยันได้เลย' : said, ...v };
      }
      return { kind: 'reply', text: 'ขอข้อมูลให้ครบนะคะ: พืช ปริมาณ และราคาสุทธิขั้นต่ำที่คุณยอมรับได้ เช่น “ข้าวหอมมะลิ 12 ตัน ขั้นต่ำ 17 บาท/กก.”' };
    }
    if (use?.toolUse.name === 'propose_buyer_request' && opts.role === 'buyer') {
      const v = validBuyerRequest(input);
      const fromUser = allowedNumbers({}, opts.history, opts.message);
      if (v && fromUser.some((n) => near(n, v.offerPerKg))) {
        return { kind: 'buyer_request', text: inventedNumbers(said, allowed).length ? 'สรุปคำขอซื้อให้แล้วค่ะ ตรวจแล้วกดยืนยันได้เลย' : said, draft: v };
      }
      return { kind: 'reply', text: 'ขอข้อมูลให้ครบนะคะ: ต้องการพืชอะไร กี่กิโล ส่งที่ไหน และเสนอราคากี่บาทต่อกก.' };
    }

    if (!said) {
      if (attempt === 0) continue;
      return { kind: 'reply', text: SAFE_REPLY };
    }
    const bad = inventedNumbers(said, allowed);
    if (!bad.length) return { kind: 'reply', text: said.slice(0, 1500) };
    messages.push({ role: 'assistant', content: [{ text: said }] }, { role: 'user', content: [{ text: `[ระบบ] คำตอบมีตัวเลข ${bad.join(', ')} ที่ไม่มีในบริบท ตอบใหม่โดยใช้เฉพาะตัวเลขในบริบท หรือไม่ระบุตัวเลข` }] });
  }
  return { kind: 'reply', text: SAFE_REPLY };
}
