// ตรวจความผิดปกติก่อนปิดดีล: กฎในโค้ดทั้งหมด (ไม่ใช้ AI) แสดงให้เกษตรกรเห็นบนการ์ดอนุมัติ
// ✓ = ผ่าน · ⚠ = ควรดูให้ดีก่อนกดอนุมัติ (ไม่บล็อกดีล เกษตรกรเป็นคนตัดสินใจ)

import type { Deduction } from './types.js';

export interface DealCheck {
  ok: boolean;
  label: string;
  detail: string;
}

export const CHECK_LIMITS = { marketBandPct: 15, deductionPct: 3, paymentTermDays: 15 };

export function checkDealAnomalies(x: {
  pricePerKg: number;
  marketMedianPerKg?: number;
  deductions: Deduction[];
  totalKg: number;
  paymentTermDays?: number;
  buyerMinKg?: number;
  buyerMaxKg?: number;
  passesAllFloors: boolean;
  buyerLevel?: 'high' | 'medium' | 'low' | 'new';
  ledgerVerified?: boolean;
}): DealCheck[] {
  const out: DealCheck[] = [];
  if (x.marketMedianPerKg !== undefined) {
    const diff = ((x.pricePerKg - x.marketMedianPerKg) / x.marketMedianPerKg) * 100;
    const ok = Math.abs(diff) <= CHECK_LIMITS.marketBandPct;
    out.push({
      ok,
      label: 'ราคาเทียบตลาด',
      detail: ok ? `ห่างจากราคากลาง NABC ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%` : diff < 0 ? `ต่ำกว่าราคากลาง NABC ${Math.abs(diff).toFixed(1)}%` : `สูงกว่าราคากลาง ${diff.toFixed(1)}% ตรวจเงื่อนไขแฝงให้ดี`,
    });
  }
  const gross = x.pricePerKg * x.totalKg;
  const dedBaht = x.deductions.reduce((s, d) => s + (d.kind === 'percent' ? (gross * d.percent) / 100 : d.kind === 'per_kg' ? d.amountPerKg * x.totalKg : d.amount), 0);
  const dedPct = gross > 0 ? (dedBaht / gross) * 100 : 0;
  out.push({ ok: dedPct <= CHECK_LIMITS.deductionPct, label: 'ส่วนหักแฝง', detail: dedPct === 0 ? 'ไม่มีส่วนหัก' : `หักรวม ${dedPct.toFixed(1)}% ของยอด${dedPct > CHECK_LIMITS.deductionPct ? ` (เกิน ${CHECK_LIMITS.deductionPct}%)` : ''}` });
  if (x.paymentTermDays !== undefined) {
    out.push({ ok: x.paymentTermDays <= CHECK_LIMITS.paymentTermDays, label: 'เครดิตจ่ายเงิน', detail: `จ่ายภายใน ${x.paymentTermDays} วัน${x.paymentTermDays > CHECK_LIMITS.paymentTermDays ? ' (นาน ควรขอให้สั้นลง)' : ''}` });
  }
  if (x.buyerMinKg !== undefined) {
    const ok = x.totalKg >= x.buyerMinKg && (x.buyerMaxKg === undefined || x.totalKg <= x.buyerMaxKg);
    out.push({ ok, label: 'ปริมาณตรงเงื่อนไขผู้ซื้อ', detail: ok ? 'อยู่ในช่วงที่ผู้ซื้อรับได้' : 'ปริมาณไม่อยู่ในช่วงที่ผู้ซื้อรับ' });
  }
  out.push({ ok: x.passesAllFloors, label: 'ราคาขั้นต่ำของสมาชิก', detail: x.passesAllFloors ? 'ทุกคนได้สุทธิไม่ต่ำกว่าขั้นต่ำของตัวเอง' : 'มีสมาชิกได้ต่ำกว่าขั้นต่ำ ต้องขอมติกลุ่ม' });
  if (x.buyerLevel) {
    out.push({ ok: x.buyerLevel !== 'low', label: 'ประวัติผู้ซื้อ', detail: x.buyerLevel === 'low' ? 'มีประวัติจ่ายช้า/ข้อพิพาท ควรระวัง' : x.buyerLevel === 'new' ? 'ผู้ซื้อใหม่ ยังไม่มีประวัติ' : 'ประวัติการจ่ายเงินดี' });
  }
  if (x.ledgerVerified !== undefined) out.push({ ok: x.ledgerVerified, label: 'บันทึกการเจรจา', detail: x.ledgerVerified ? 'ledger ไม่ถูกแก้ย้อนหลัง (hash chain ตรวจผ่าน)' : 'ledger ตรวจไม่ผ่าน' });
  return out;
}
