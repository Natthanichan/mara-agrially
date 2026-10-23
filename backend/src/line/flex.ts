// สร้างข้อความ LINE (ข้อความธรรมดา + Flex Message ที่มีปุ่ม) — ฟังก์ชันล้วน เทสได้โดยไม่ต้องมี LINE

import { CROP_LABEL_TH } from '../data/synthetic.js';
import type { FarmerOffer } from '../app/service.js';
import type { Crop } from '../core/types.js';
import type { BuyerDraft, BuyerRequest, ListingDraft } from '../store/types.js';
import type { LineMessage } from './client.js';

export const MOCK_NOTE = 'ข้อมูลทั้งหมดเป็นการจำลองเพื่อทดสอบระบบ ไม่ใช่ราคาหรือดีลจริง';

const ACTS = ['confirm', 'edit', 'approve', 'reject', 'renegotiate', 'role_farmer', 'role_buyer', 'buyer_crop', 'buyer_confirm', 'buyer_edit'] as const;
export type Act = (typeof ACTS)[number];
const CROPS: Crop[] = ['rice_hommali', 'bitter_gourd', 'cassava'];
export const postbackData = (act: Act, dealId?: string, crop?: Crop) => new URLSearchParams({ act, ...(dealId ? { d: dealId } : {}), ...(crop ? { c: crop } : {}) }).toString();
export function parsePostback(data: string): { act: Act; dealId?: string; crop?: Crop } | undefined {
  const p = new URLSearchParams(data);
  const act = ACTS.find((a) => a === p.get('act'));
  if (!act) return undefined;
  const d = p.get('d');
  const c = CROPS.find((x) => x === p.get('c'));
  return { act, ...(d ? { dealId: d } : {}), ...(c ? { crop: c } : {}) };
}

const baht = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const qty = (kg: number) => (kg >= 1000 ? `${(kg / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} ตัน` : `${int(kg)} กก.`);

export const text = (t: string): LineMessage => ({ type: 'text', text: t.slice(0, 4900) });

const row = (label: string, value: string, bold = false): LineMessage => ({
  type: 'box',
  layout: 'horizontal',
  spacing: 'sm',
  contents: [
    { type: 'text', text: label, size: 'sm', color: '#666666', flex: 5, wrap: true },
    { type: 'text', text: value, size: 'sm', color: '#111111', flex: 5, align: 'end', wrap: true, ...(bold ? { weight: 'bold' } : {}) },
  ],
});

const button = (label: string, data: string, displayText: string, style: 'primary' | 'secondary', color?: string): LineMessage => ({
  type: 'button',
  style,
  height: 'sm',
  ...(color ? { color } : {}),
  action: { type: 'postback', label, data, displayText },
});

const bubble = (title: string, body: LineMessage[], footer: LineMessage[], altText: string): LineMessage => ({
  type: 'flex',
  altText: altText.slice(0, 390),
  contents: {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#E8F5E9', contents: [{ type: 'text', text: title, weight: 'bold', size: 'md', color: '#1B5E20', wrap: true }] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [...body, { type: 'separator' }, { type: 'text', text: MOCK_NOTE, size: 'xs', color: '#888888', wrap: true }] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer },
  },
});

export const helpMessage = (): LineMessage =>
  text(
    [
      'สวัสดีค่ะ น้องมะระเองค่ะ 🌱 หนูช่วยรวมผลผลิตกับเพื่อนเกษตรกรแล้วเจรจาขายให้ โดยคุณเป็นคนอนุมัติดีลเองทุกครั้งนะคะ',
      '',
      'พิมพ์ผลผลิตของคุณมาได้เลย ระบุ 3 อย่าง: พืช ปริมาณ และราคาสุทธิขั้นต่ำที่ยอมรับได้ เช่น',
      '“ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”',
      '',
      'พืชที่รองรับตอนนี้: ข้าวหอมมะลิ, มะระจีน, มันสำปะหลัง',
      '',
      MOCK_NOTE,
    ].join('\n'),
  );

export const problemsMessage = (problems: string[]): LineMessage =>
  text(['ขอข้อมูลเพิ่มนิดนึงค่ะ', ...problems.map((p) => `• ${p}`), '', 'ตัวอย่าง: “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”'].join('\n'));

export function confirmMessage(d: ListingDraft, gradeAssumed: boolean): LineMessage {
  const body = [
    row('พืช', CROP_LABEL_TH[d.crop], true),
    row('ปริมาณ', qty(d.quantityKg)),
    row('เกรด', gradeAssumed ? `${d.grade} (หนูสมมติให้ ถ้าไม่ใช่กดแก้ไขนะคะ)` : d.grade),
    row('ราคาสุทธิขั้นต่ำ', `${baht(d.floorPricePerKg)} บาท/กก.`),
    { type: 'text', text: 'ราคาขั้นต่ำนี้เป็นความลับ ไม่ส่งให้ผู้ซื้อ ระบบจะไม่ยอมรับข้อเสนอที่ทำให้คุณได้สุทธิต่ำกว่านี้', size: 'xs', color: '#666666', wrap: true },
  ];
  return bubble(
    'ตรวจข้อมูลก่อนเริ่มเจรจา',
    body,
    [button('ยืนยัน เริ่มเจรจา', postbackData('confirm'), 'ยืนยัน เริ่มเจรจา', 'primary', '#2E7D32'), button('แก้ไข', postbackData('edit'), 'แก้ไข', 'secondary')],
    `ตรวจข้อมูล: ${CROP_LABEL_TH[d.crop]} ${qty(d.quantityKg)} ขั้นต่ำ ${baht(d.floorPricePerKg)} บาท/กก. — กดยืนยันเพื่อเริ่มเจรจา`,
  );
}

export function offerMessage(dealId: string, o: FarmerOffer, memberNote: string): LineMessage {
  const m = o.mine;
  const body: LineMessage[] = [
    row('ผู้ซื้อ', o.buyerName, true),
    row('ราคาที่ตกลงเบื้องต้น', `${baht(o.pricePerKg)} บาท/กก.`),
    ...(o.deductions.length ? [row('ส่วนหัก', o.deductions.join(', '))] : []),
    row('ค่าขนส่งของคุณ', `${baht(m.transportPerKg)} บาท/กก.`),
    { type: 'separator' },
    row('คุณได้สุทธิ', `${baht(m.netPerKg)} บาท/กก.`, true),
    row('รวมที่คุณได้', `${baht(m.netTotal)} บาท (${qty(m.quantityKg)})`, true),
    row('ขั้นต่ำของคุณ', `${baht(m.floorPerKg)} บาท/กก. ${m.passesFloor ? '✓ ผ่าน' : '✗ ไม่ผ่าน'}`),
    ...(o.marketMedianPerKg !== undefined ? [row('ราคาตลาดอ้างอิง (มัธยฐาน)', `${baht(o.marketMedianPerKg)} บาท/กก.`)] : []),
    { type: 'text', text: `ทั้งกลุ่ม ${o.group.memberCount} คน ${qty(o.group.totalKg)} สุทธิเฉลี่ย ${baht(o.group.netPerKgAvg)} บาท/กก.`, size: 'xs', color: '#666666', wrap: true },
    { type: 'text', text: memberNote, size: 'xs', color: '#666666', wrap: true },
  ];
  return bubble(
    'น้องมะระเจรจาให้แล้ว รอคุณอนุมัติ',
    body,
    [
      button('อนุมัติ', postbackData('approve', dealId), 'อนุมัติดีลนี้', 'primary', '#2E7D32'),
      button('ไม่เอา', postbackData('reject', dealId), 'ไม่เอาดีลนี้', 'secondary'),
      button('ต่อรองใหม่', postbackData('renegotiate', dealId), 'ต่อรองใหม่', 'secondary'),
    ],
    `ผลเจรจา: ${o.buyerName} คุณได้สุทธิ ${baht(m.netPerKg)} บาท/กก. รวม ${baht(m.netTotal)} บาท — กดอนุมัติ ไม่เอา หรือต่อรองใหม่`,
  );
}

export function failedMessage(dealId: string, reason: string, canRetry: boolean): LineMessage[] {
  const msg = text(`น้องมะระเจรจาแล้วแต่ยังไม่ได้ดีลที่ผ่านราคาขั้นต่ำของคุณ\nเหตุผล: ${reason.slice(0, 300)}\n\nไม่มีดีลใดถูกสร้างหรือผูกพันคุณ`);
  if (!canRetry) return [msg];
  return [msg, bubble('อยากลองอีกครั้งไหม', [{ type: 'text', text: 'กดต่อรองใหม่เพื่อให้น้องมะระเจรจาใหม่ หรือพิมพ์ผลผลิตใหม่ (เช่น ปรับราคาขั้นต่ำ) ได้เลย', size: 'sm', wrap: true }], [button('ต่อรองใหม่', postbackData('renegotiate', dealId), 'ต่อรองใหม่', 'primary', '#2E7D32')], 'ยังไม่ได้ดีล กดต่อรองใหม่หรือพิมพ์ผลผลิตใหม่')];
}

export const startedMessage = () => text('รับทราบค่ะ น้องมะระเริ่มเจรจากับผู้ซื้อแล้ว 🤝\nใช้เวลาประมาณ 1–2 นาที พอมีผลหนูจะส่งให้คุณดูครั้งเดียว พร้อมปุ่มอนุมัติค่ะ');

// ---------- เลือกบทบาท และฝั่งผู้ซื้อ ----------

export const roleMessage = (): LineMessage =>
  bubble(
    'น้องมะระยินดีให้บริการค่ะ 🌱',
    [{ type: 'text', text: 'วันนี้คุณมาในบทบาทไหนคะ', size: 'sm', wrap: true }],
    [button('ฉันเป็นเกษตรกร', postbackData('role_farmer'), 'ฉันเป็นเกษตรกร', 'primary', '#2E7D32'), button('ฉันเป็นผู้ซื้อ', postbackData('role_buyer'), 'ฉันเป็นผู้ซื้อ', 'primary', '#3A4C9C')],
    'เลือกบทบาท: เกษตรกร หรือ ผู้ซื้อ',
  );

export const buyerCropMessage = (): LineMessage =>
  bubble(
    'ผู้ซื้อ: ต้องการซื้ออะไรคะ',
    [{ type: 'text', text: 'เลือกผลผลิตที่ต้องการ หรือพิมพ์ชื่อมาได้เลยค่ะ', size: 'sm', wrap: true }],
    (['rice_hommali', 'bitter_gourd', 'cassava'] as Crop[]).map((c) => button(CROP_LABEL_TH[c], postbackData('buyer_crop', undefined, c), CROP_LABEL_TH[c], 'secondary')),
    'ต้องการซื้อผลผลิตอะไร: ข้าวหอมมะลิ, มะระจีน, มันสำปะหลัง',
  );

export const buyerAskQuantity = (crop: Crop) => text(`ต้องการ${CROP_LABEL_TH[crop]}เท่าไหร่คะ ตอบเป็นตันหรือกิโลกรัมได้เลย เช่น “10 ตัน” หรือ “10000 กก.”`);
export const buyerAskLocation = () => text('ส่งมอบที่ไหนคะ ตอบสถานที่ได้เลย เช่น “โรงสี ต.บางพลี จ.สมุทรปราการ”');
export const buyerAskPrice = () => text('ราคาที่เสนอซื้อกี่บาทต่อกก. คะ เช่น “18.5”');

export function buyerConfirmMessage(d: Required<Omit<BuyerDraft, 'step'>>): LineMessage {
  return bubble(
    'ตรวจคำขอซื้อก่อนบันทึกค่ะ',
    [row('ต้องการซื้อ', CROP_LABEL_TH[d.crop], true), row('ปริมาณ', qty(d.quantityKg)), row('สถานที่ส่งมอบ', d.location), row('ราคาที่เสนอ', `${baht(d.offerPerKg)} บาท/กก.`)],
    [button('ยืนยันคำขอซื้อ', postbackData('buyer_confirm'), 'ยืนยันคำขอซื้อ', 'primary', '#3A4C9C'), button('แก้ไข', postbackData('buyer_edit'), 'แก้ไข', 'secondary')],
    `ตรวจคำขอซื้อ: ${CROP_LABEL_TH[d.crop]} ${qty(d.quantityKg)} ส่งที่ ${d.location} เสนอ ${baht(d.offerPerKg)} บาท/กก.`,
  );
}

/** supply = ภาพรวมผลผลิตที่มีในระบบ (ข้อมูลจำลอง) ไม่มีราคาขั้นต่ำของใครทั้งสิ้น */
export function buyerSavedMessage(d: Pick<BuyerRequest, 'crop' | 'quantityKg' | 'offerPerKg'>, supply: { farmers: number; totalKg: number; provinces: string[] }): LineMessage {
  const have = supply.farmers > 0 ? `ตอนนี้ในระบบมีเกษตรกร ${supply.farmers} ราย รวม ${qty(supply.totalKg)} (${supply.provinces.join(', ')})` : 'ตอนนี้ยังไม่มีเกษตรกรที่ลงทะเบียนผลผลิตนี้ไว้';
  return text(
    [
      'บันทึกคำขอซื้อแล้วค่ะ ✓',
      `${CROP_LABEL_TH[d.crop]} ${qty(d.quantityKg)} เสนอ ${baht(d.offerPerKg)} บาท/กก.`,
      '',
      have,
      '',
      'ขั้นต่อไป (กำลังพัฒนา): น้องมะระจะแจ้งเตือนเมื่อมีเกษตรกรที่ตรงกับที่คุณต้องการ และคุยต่อรองกับคุณที่นี่ค่ะ',
      '',
      MOCK_NOTE,
    ].join('\n'),
  );
}

export function buyerRequestsMessage(list: BuyerRequest[]): LineMessage {
  if (!list.length) return text('ยังไม่มีคำขอซื้อค่ะ พิมพ์อะไรมาก็ได้เพื่อเริ่มลงทะเบียน');
  return text(['คำขอซื้อล่าสุดของคุณ', ...list.map((r, i) => `${i + 1}. ${CROP_LABEL_TH[r.crop]} ${qty(r.quantityKg)} ส่งที่ ${r.location} เสนอ ${baht(r.offerPerKg)} บาท/กก.`)].join('\n'));
}
