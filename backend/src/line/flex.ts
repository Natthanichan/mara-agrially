// สร้างข้อความ LINE (ข้อความธรรมดา + Flex Message ที่มีปุ่ม) — ฟังก์ชันล้วน เทสได้โดยไม่ต้องมี LINE

import { CROP_LABEL_TH } from '../data/synthetic.js';
import type { FarmerOffer } from '../app/service.js';
import type { ListingDraft } from '../store/types.js';
import type { LineMessage } from './client.js';

export const MOCK_NOTE = 'ข้อมูลทั้งหมดเป็นการจำลองเพื่อทดสอบระบบ ไม่ใช่ราคาหรือดีลจริง';

export type Act = 'confirm' | 'edit' | 'approve' | 'reject' | 'renegotiate';
export const postbackData = (act: Act, dealId?: string) => new URLSearchParams({ act, ...(dealId ? { d: dealId } : {}) }).toString();
export function parsePostback(data: string): { act: Act; dealId?: string } | undefined {
  const p = new URLSearchParams(data);
  const act = p.get('act');
  if (act !== 'confirm' && act !== 'edit' && act !== 'approve' && act !== 'reject' && act !== 'renegotiate') return undefined;
  const d = p.get('d');
  return { act, ...(d ? { dealId: d } : {}) };
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
      'สวัสดีครับ น้องมะระเอง 🌱 ผมช่วยรวมผลผลิตกับเพื่อนเกษตรกรแล้วเจรจาขายให้ โดยคุณเป็นคนอนุมัติดีลเองทุกครั้ง',
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
  text(['ขอข้อมูลเพิ่มนิดนึงครับ', ...problems.map((p) => `• ${p}`), '', 'ตัวอย่าง: “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”'].join('\n'));

export function confirmMessage(d: ListingDraft, gradeAssumed: boolean): LineMessage {
  const body = [
    row('พืช', CROP_LABEL_TH[d.crop], true),
    row('ปริมาณ', qty(d.quantityKg)),
    row('เกรด', gradeAssumed ? `${d.grade} (ผมสมมติให้ ถ้าไม่ใช่กดแก้ไข)` : d.grade),
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

export const startedMessage = () => text('รับทราบครับ น้องมะระเริ่มเจรจากับผู้ซื้อแล้ว 🤝\nใช้เวลาประมาณ 1–2 นาที พอมีผลผมจะส่งให้คุณดูครั้งเดียว พร้อมปุ่มอนุมัติ');
