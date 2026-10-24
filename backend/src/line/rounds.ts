// สรุปการเจรจาเป็นรอบ ๆ จาก ledger ของดีล — ใช้ทั้งในการ์ดผลเจรจาใน LINE และเป็นบริบทให้แชตอธิบายได้
import { STRATEGY_TH, type Strategy } from '../agent/evidence.js';
import type { LedgerEvent } from '../core/ledger.js';

export interface RoundSummary {
  round: number;
  buyerId: string;
  buyerName: string;
  strategy: string;
  /** หลักฐานที่อ้าง แบบสั้น (ไม่มีตัวเลข) */
  evidence: string[];
  askPerKg: number;
  /** ราคาที่ผู้ซื้อตอบกลับ */
  buyerPerKg?: number;
  buyerDecision?: string;
  objection?: string;
}

const EVIDENCE_SHORT: [RegExp, string][] = [
  [/^E-MKT/, 'ราคาตลาด NABC'],
  [/^E-VOL/, 'ปริมาณรวม'],
  [/^E-GRADE/, 'เกรด/คุณภาพ'],
  [/^E-DELIVERY/, 'ช่วงส่งมอบ'],
  [/^E-LOGISTICS/, 'รถรวม'],
  [/^E-COMP/, 'ข้อเสนอจริงของรายอื่น'],
  [/^E-HIST/, 'ประวัติราคา'],
  [/^E-KB/, 'ความรู้อ้างอิง (จำลอง)'],
  [/^E-OFFER/, 'ข้อเสนอก่อนหน้า'],
];
export const shortEvidence = (id: string) => EVIDENCE_SHORT.find(([re]) => re.test(id))?.[1] ?? id;

export const DECISION_TH: Record<string, string> = { offer: 'เสนอ', counter: 'ขยับเป็น', final_offer: 'ราคาสุดท้าย', accept: 'ตกลงที่', walk_away: 'ถอนตัว ราคาสุดท้าย' };

/** จับคู่ข้อเสนอของน้องมะระกับคำตอบของผู้ซื้อที่ตามมา */
export function negotiationRounds(events: readonly Pick<LedgerEvent, 'type' | 'data'>[]): RoundSummary[] {
  const names = new Map<string, string>();
  const out: RoundSummary[] = [];
  const pending = new Map<string, RoundSummary>();
  for (const e of events) {
    const d = e.data as Record<string, any>;
    if (e.type === 'agent.buyer_response') {
      names.set(String(d.buyerId), String(d.buyerName ?? d.buyerId));
      const p = pending.get(String(d.buyerId));
      if (p) {
        p.buyerPerKg = Number(d.pricePerKg);
        p.buyerDecision = String(d.decision);
        if (d.objection?.text) p.objection = String(d.objection.text);
        pending.delete(String(d.buyerId));
      }
    }
    if (e.type === 'agent.counter_sent') {
      const r: RoundSummary = {
        round: Number(d.round ?? 0),
        buyerId: String(d.buyerId),
        buyerName: names.get(String(d.buyerId)) ?? String(d.buyerId),
        strategy: STRATEGY_TH[d.strategy as Strategy] ?? String(d.strategy ?? ''),
        evidence: [...new Set(((d.evidence ?? []) as { id: string }[]).map((x) => shortEvidence(x.id)))],
        askPerKg: Number(d.pricePerKg),
      };
      out.push(r);
      pending.set(r.buyerId, r);
    }
  }
  return out;
}
