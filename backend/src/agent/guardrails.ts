// Guardrails — กฎที่โค้ดบังคับ ไม่ได้ฝากไว้กับ LLM
// ทุกครั้งที่ Agent จะส่งอะไรออกไปหาผู้ซื้อ ต้องผ่านฟังก์ชันในไฟล์นี้ก่อน

export type GuardrailCode =
  | 'below_floor' // ราคาที่เสนอทำให้สมาชิกบางคนได้สุทธิต่ำกว่าขั้นต่ำ
  | 'below_buyer_offer' // เสนอต่ำกว่าที่ผู้ซื้อให้อยู่แล้ว (ผู้ซื้อจะรับทันที = เสียเงินฟรี)
  | 'private_data_leak' // ข้อความมีตัวเลขราคาขั้นต่ำ
  | 'round_limit' // เจรจากับผู้ซื้อรายนี้ครบจำนวนรอบแล้ว
  | 'unverified_number' // ข้อความมีตัวเลขที่ไม่มีในทะเบียนหลักฐาน (กันแต่งสถิติ/ราคาคู่แข่ง)
  | 'invalid_input';

export interface GuardrailViolation {
  code: GuardrailCode;
  /** ข้อความที่ส่งกลับให้ LLM — ห้ามมีตัวเลขขั้นต่ำรายคน */
  message: string;
}

const NUM = /\d[\d,]*(?:\.\d+)?/g;

/** ดึงตัวเลขทั้งหมดในข้อความ (รองรับ 41,500 และ 17.65) */
export function extractNumbers(text: string): number[] {
  return [...text.matchAll(NUM)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
}

/**
 * ตรวจว่าข้อความถึงผู้ซื้อไม่มีตัวเลขที่ตรงกับราคาขั้นต่ำ (รายคน หรือราคาต่ำสุดที่ทั้งกลุ่มรับได้)
 * ยกเว้นราคาที่กำลังเสนออยู่ — เพราะส่งให้ผู้ซื้ออยู่แล้วในช่องราคา
 */
export function checkMessageLeak(message: string, privateNumbers: number[], allowed: number[] = []): GuardrailViolation | undefined {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  for (const n of extractNumbers(message)) {
    if (allowed.some((a) => near(a, n))) continue;
    if (privateNumbers.some((p) => near(p, n))) {
      return { code: 'private_data_leak', message: 'ข้อความมีตัวเลขที่ตรงกับราคาขั้นต่ำของสมาชิก (แม้จะมาจากแหล่งอื่น) ระบบไม่ส่งตัวเลขนี้ เพื่อไม่ให้ผู้ซื้อเดาราคาขั้นต่ำได้ เขียนข้อความใหม่โดยไม่ระบุตัวเลขนั้น' };
    }
  }
  return undefined;
}

export function checkCounterPrice(input: {
  pricePerKg: number;
  /** ราคาต่ำสุดที่ทุกคนในกลุ่มยังได้สุทธิ ≥ ขั้นต่ำ (ภายใต้ส่วนหักปัจจุบันของผู้ซื้อ) */
  minGrossPriceToPassAll: number;
  buyerCurrentPerKg: number;
  roundsUsed: number;
  maxRounds: number;
}): GuardrailViolation | undefined {
  const { pricePerKg: p } = input;
  if (!Number.isFinite(p) || p <= 0 || p > 1000) return { code: 'invalid_input', message: 'ราคาที่เสนอไม่ถูกต้อง' };
  if (input.roundsUsed >= input.maxRounds) {
    return { code: 'round_limit', message: `เจรจากับผู้ซื้อรายนี้ครบ ${input.maxRounds} รอบแล้ว ให้ตัดสินใจจากข้อเสนอที่มี` };
  }
  // ผู้ซื้อจำลองรับทันทีถ้าเราขอต่ำกว่า/เท่ากับที่เขาให้ → ห้ามขอต่ำกว่าที่เขาให้
  if (p < input.buyerCurrentPerKg) {
    return { code: 'below_buyer_offer', message: 'ราคาที่จะเสนอต่ำกว่าที่ผู้ซื้อให้อยู่แล้ว ให้เสนอสูงกว่าหรือเตรียมดีลที่ราคาปัจจุบัน' };
  }
  if (p < input.minGrossPriceToPassAll) {
    return { code: 'below_floor', message: 'ราคานี้ทำให้สมาชิกบางคนได้ราคาสุทธิต่ำกว่าขั้นต่ำ ระบบไม่อนุญาตให้เสนอ' };
  }
  return undefined;
}
