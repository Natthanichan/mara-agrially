// สถานะดีล การส่งมอบ และการชำระเงิน แยกจากกัน
// การชำระเงินเป็นรายเกษตรกร (ผู้ซื้อโอนตรงเข้าบัญชีแต่ละคน ระบบไม่ถือเงิน)

export type DealStatus =
  | 'draft'
  | 'negotiating'
  | 'pending_approval' // Agent เตรียมดีลแล้ว รอเกษตรกรอนุมัติ — Agent ปิดดีลเองไม่ได้
  | 'agreed'
  | 'rejected'
  | 'cancelled'
  | 'failed'; // เจรจาครบรอบหรือโมเดลล่ม → หยุดอย่างปลอดภัย

export type DeliveryStatus = 'not_started' | 'scheduled' | 'delivered' | 'disputed';
export type PaymentStatus = 'not_due' | 'awaiting_payment' | 'paid' | 'overdue';

const DEAL: Record<DealStatus, DealStatus[]> = {
  draft: ['negotiating', 'cancelled'],
  negotiating: ['pending_approval', 'failed', 'cancelled'],
  pending_approval: ['agreed', 'rejected', 'negotiating', 'cancelled'], // negotiating = สั่งเจรจาใหม่
  agreed: [],
  rejected: ['negotiating', 'cancelled'],
  cancelled: [],
  failed: ['negotiating', 'cancelled'],
};

const DELIVERY: Record<DeliveryStatus, DeliveryStatus[]> = {
  not_started: ['scheduled'],
  scheduled: ['delivered', 'disputed'],
  delivered: ['disputed'],
  disputed: ['delivered'],
};

const PAYMENT: Record<PaymentStatus, PaymentStatus[]> = {
  not_due: ['awaiting_payment'],
  awaiting_payment: ['paid', 'overdue'],
  overdue: ['paid'],
  paid: [],
};

export class TransitionError extends Error {}

export function nextDealStatus(from: DealStatus, to: DealStatus): DealStatus {
  if (!DEAL[from].includes(to)) throw new TransitionError(`เปลี่ยนสถานะดีลจาก ${from} เป็น ${to} ไม่ได้`);
  return to;
}

/** การส่งมอบเริ่มได้หลังดีล agreed เท่านั้น */
export function nextDeliveryStatus(deal: DealStatus, from: DeliveryStatus, to: DeliveryStatus): DeliveryStatus {
  if (deal !== 'agreed') throw new TransitionError('ต้องตกลงดีลก่อนจึงจะเริ่มการส่งมอบได้');
  if (!DELIVERY[from].includes(to)) throw new TransitionError(`เปลี่ยนสถานะส่งมอบจาก ${from} เป็น ${to} ไม่ได้`);
  return to;
}

/** การชำระเงินรอได้หลังส่งมอบแล้วเท่านั้น */
export function nextPaymentStatus(delivery: DeliveryStatus, from: PaymentStatus, to: PaymentStatus): PaymentStatus {
  if (to === 'awaiting_payment' && delivery !== 'delivered') throw new TransitionError('ต้องส่งมอบก่อนจึงจะรอรับชำระได้');
  if (!PAYMENT[from].includes(to)) throw new TransitionError(`เปลี่ยนสถานะชำระเงินจาก ${from} เป็น ${to} ไม่ได้`);
  return to;
}

/**
 * ประตูอนุมัติ: ดีลเป็น agreed ได้เมื่อสมาชิกที่ยังอยู่ทุกคนอนุมัติ
 * (คนที่ปฏิเสธถูกถอนออกจากดีลก่อนแล้ว) และต้องผ่าน Price Floor ณ ตอนอนุมัติ
 */
export function canFinalize(input: {
  status: DealStatus;
  activeFarmerIds: string[];
  approvals: Record<string, 'approve' | 'reject' | 'renegotiate' | undefined>;
  floorPasses: boolean;
  remainingKg: number;
  buyerMinKg: number;
}): { ok: true } | { ok: false; reason: string } {
  if (input.status !== 'pending_approval') return { ok: false, reason: 'ดีลยังไม่อยู่ในสถานะรออนุมัติ' };
  if (input.activeFarmerIds.length === 0) return { ok: false, reason: 'ไม่มีสมาชิกเหลือในดีล' };
  if (!input.floorPasses) return { ok: false, reason: 'ราคาสุทธิต่ำกว่าขั้นต่ำของสมาชิกบางคน' };
  if (input.remainingKg < input.buyerMinKg) return { ok: false, reason: 'ปริมาณรวมต่ำกว่าขั้นต่ำของผู้ซื้อ ต้องเจรจาใหม่' };
  const pending = input.activeFarmerIds.filter((id) => input.approvals[id] !== 'approve');
  if (pending.length) return { ok: false, reason: `ยังรออนุมัติจากสมาชิก ${pending.length} คน` };
  return { ok: true };
}
