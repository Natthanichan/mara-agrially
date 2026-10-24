// Buyer Reputation Memory: จำว่าผู้ซื้อแต่ละรายจ่ายเงินตรงเวลาไหม มีปัญหาคุณภาพ/หักเงินเพิ่ม หรือยกเลิกหรือเปล่า
// คะแนนคิดด้วยสูตรในโค้ด (ไม่ใช้ AI) ใช้ประกอบการตัดสินใจของเกษตรกรและเตือนความเสี่ยงก่อนปิดดีล

export type FeedbackKind = 'paid_on_time' | 'paid_late' | 'dispute' | 'cancelled';
export const FEEDBACK_TH: Record<FeedbackKind, string> = {
  paid_on_time: 'จ่ายตรงเวลา',
  paid_late: 'จ่ายช้า',
  dispute: 'มีปัญหา/หักเงินเพิ่ม',
  cancelled: 'ยกเลิกไม่รับของ',
};

export interface BuyerFeedback {
  buyerId: string;
  kind: FeedbackKind;
  dealId: string;
  at: string;
  /** true = ประวัติจำลองตั้งต้นของเดโม */
  simulated?: boolean;
}

export interface Reputation {
  buyerId: string;
  deals: number;
  onTime: number;
  late: number;
  disputes: number;
  cancels: number;
  /** 0–100 · undefined = ยังไม่มีประวัติ */
  score?: number;
  level: 'high' | 'medium' | 'low' | 'new';
}

export const LEVEL_TH: Record<Reputation['level'], string> = { high: 'น่าเชื่อถือสูง', medium: 'ปานกลาง', low: 'ต้องระวัง', new: 'ผู้ซื้อใหม่ ยังไม่มีประวัติ' };

/** ประวัติตั้งต้น (จำลอง) ของผู้ซื้อในเดโม — ในระบบจริงมาจากการให้คะแนนของเกษตรกรหลังส่งมอบ */
export const SEED_HISTORY: Record<string, Partial<Record<FeedbackKind, number>>> = {
  'B-A': { paid_on_time: 9, paid_late: 1 },
  'B-B': { paid_on_time: 14 },
  'B-C': { paid_on_time: 3, paid_late: 3, dispute: 4 },
  'B-D': { paid_on_time: 20, paid_late: 1 },
  'B-E': { paid_on_time: 5 },
  'B-F': { paid_on_time: 7, paid_late: 2, dispute: 1 },
};

export function seedFeedback(buyerId: string): BuyerFeedback[] {
  const seed = SEED_HISTORY[buyerId] ?? {};
  return (Object.entries(seed) as [FeedbackKind, number][]).flatMap(([kind, n]) =>
    Array.from({ length: n }, (_, i) => ({ buyerId, kind, dealId: `SEED-${buyerId}-${kind}-${i + 1}`, at: '2026-01-01T00:00:00Z', simulated: true })),
  );
}

/**
 * คะแนน = 60% การจ่ายเงิน (ตรงเวลา 1, ช้า 0.4) + 40% ไม่มีปัญหา (ข้อพิพาท/ยกเลิก หักตามสัดส่วน)
 * ≥ 80 น่าเชื่อถือสูง · 60–79 ปานกลาง · < 60 ต้องระวัง
 */
export function computeReputation(buyerId: string, rows: BuyerFeedback[]): Reputation {
  const mine = rows.filter((r) => r.buyerId === buyerId);
  const count = (k: FeedbackKind) => mine.filter((r) => r.kind === k).length;
  const onTime = count('paid_on_time');
  const late = count('paid_late');
  const disputes = count('dispute');
  const cancels = count('cancelled');
  const deals = onTime + late + cancels;
  if (!deals && !disputes) return { buyerId, deals: 0, onTime, late, disputes, cancels, level: 'new' };
  const paid = onTime + late;
  const pay = paid ? (onTime + 0.4 * late) / paid : 0;
  const issues = Math.min(1, (disputes + cancels) / Math.max(deals, 1));
  const score = Math.round(100 * (0.6 * pay + 0.4 * (1 - issues)));
  return { buyerId, deals, onTime, late, disputes, cancels, score, level: score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low' };
}

export const reputationLine = (r: Reputation) =>
  r.score === undefined ? LEVEL_TH.new : `${r.score}/100 ${LEVEL_TH[r.level]} · ${r.deals} ดีล จ่ายตรงเวลา ${r.onTime} ช้า ${r.late}${r.disputes ? ` · ข้อพิพาท ${r.disputes}` : ''}${r.cancels ? ` · ยกเลิก ${r.cancels}` : ''}`;
