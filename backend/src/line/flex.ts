// สร้างข้อความ LINE (ข้อความธรรมดา + Flex Message ที่มีปุ่ม) — ฟังก์ชันล้วน เทสได้โดยไม่ต้องมี LINE

import { CROP_LABEL_TH } from '../data/synthetic.js';
import type { FarmerOffer } from '../app/service.js';
import type { Crop } from '../core/types.js';
import type { BuyerDraft, BuyerRequest, ListingDraft } from '../store/types.js';
import type { LineMessage } from './client.js';
import { DECISION_TH, type RoundSummary } from './rounds.js';

export const MOCK_NOTE = 'ข้อมูลทั้งหมดเป็นการจำลองเพื่อทดสอบระบบ ไม่ใช่ราคาหรือดีลจริง';

const ACTS = ['confirm', 'edit', 'approve', 'reject', 'renegotiate', 'role_farmer', 'role_buyer', 'buyer_crop', 'buyer_confirm', 'buyer_edit', 'group_join', 'group_create', 'group_auto', 'buyer_negotiate', 'buyer_accept', 'buyer_end', 'buyer_deal_confirm', 'buyer_deal_back', 'buyer_end_confirm'] as const;
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
    ...(footer.length ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } } : {}), // LINE ไม่รับ box ที่ว่าง
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

export interface OfferExtras {
  /** รอบการเจรจาทั้งหมดของดีลนี้ */
  rounds?: RoundSummary[];
  chosenBuyerId?: string;
  /** จำนวนครั้งที่ระบบป้องกันบล็อก */
  blocks?: number;
  /** ลิงก์หน้าเว็บของดีลนี้ */
  detailsUrl?: string;
}

/** บรรทัดสรุปว่าน้องมะระต่อรองอย่างไร (ผู้ซื้อที่เลือกก่อน ไม่เกิน 4 รอบ) */
export function roundLines(x: OfferExtras): string[] {
  const rounds = x.rounds ?? [];
  if (!rounds.length) return [];
  const chosen = rounds.filter((r) => r.buyerId === x.chosenBuyerId);
  const lines = chosen.slice(-4).map((r) => {
    const why = r.evidence.length ? `อ้าง${r.evidence.join(' + ')}` : r.strategy;
    const reply = r.buyerPerKg !== undefined ? ` → ${DECISION_TH[r.buyerDecision ?? ''] ?? ''} ${baht(r.buyerPerKg)}` : '';
    return `รอบ ${r.round} · ${why} · ขอ ${baht(r.askPerKg)}${reply}`;
  });
  const buyers = new Set(rounds.map((r) => r.buyerId)).size;
  lines.push(`เจรจา ${buyers} ราย รวม ${rounds.length} รอบ${x.blocks ? ` · ระบบป้องกันบล็อก ${x.blocks} ครั้ง` : ''}`);
  return lines;
}

export function offerMessage(dealId: string, o: FarmerOffer, memberNote: string, x: OfferExtras = {}): LineMessage {
  const m = o.mine;
  const how = roundLines(x);
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
    ...(how.length
      ? [
          { type: 'separator' },
          { type: 'text', text: 'น้องมะระต่อรองอย่างไร', weight: 'bold', size: 'sm', color: '#1B5E20' },
          ...how.map((t) => ({ type: 'text', text: t, size: 'xs', color: '#333333', wrap: true })),
        ]
      : []),
    { type: 'text', text: memberNote, size: 'xs', color: '#666666', wrap: true },
    { type: 'text', text: 'พิมพ์ถามน้องมะระได้เลยค่ะ เช่น “ทำไมได้ราคานี้” หรือ “ผู้ซื้อรายอื่นให้เท่าไร”', size: 'xs', color: '#1B5E20', wrap: true },
  ];
  return bubble(
    'น้องมะระเจรจาให้แล้ว รอคุณอนุมัติ',
    body,
    [
      button('อนุมัติ', postbackData('approve', dealId), 'อนุมัติดีลนี้', 'primary', '#2E7D32'),
      button('ไม่เอา', postbackData('reject', dealId), 'ไม่เอาดีลนี้', 'secondary'),
      button('ต่อรองใหม่', postbackData('renegotiate', dealId), 'ต่อรองใหม่', 'secondary'),
      ...(x.detailsUrl ? [{ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'ดูการเจรจาทั้งหมด', uri: x.detailsUrl } }] : []),
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
/** ราคาอ้างอิงตลาดสำหรับช่วยผู้ซื้อตั้งราคา (จาก NABC) */
export interface PriceHint {
  medianPerKg: number;
  minPerKg: number;
  maxPerKg: number;
  date: string;
  stale: boolean;
}

export function buyerAskPrice(cropLabel?: string, hint?: PriceHint | null): LineMessage {
  const lines = ['ราคาที่เสนอซื้อกี่บาทต่อกก. คะ เช่น “18.5”'];
  if (hint) {
    lines.push('', `ราคาแนะนำ: ราคากลางตลาด${cropLabel ? `ของ${cropLabel}` : ''} ${baht(hint.medianPerKg)} บาท/กก. (ช่วง ${baht(hint.minPerKg)}–${baht(hint.maxPerKg)})`, `ที่มา: ศูนย์ข้อมูลเกษตร NABC วันที่ ${hint.date}${hint.stale ? ' (ข้อมูลล่าสุดที่มี)' : ''} · เป็นราคาหน้าตลาด ยังไม่รวมค่าขนส่ง`);
  } else if (hint === null) {
    lines.push('', `ยังไม่มีราคาอ้างอิงจาก NABC สำหรับ${cropLabel ?? 'พืชนี้'}ค่ะ เสนอราคาที่คุณคิดว่าเหมาะสมได้เลย`);
  }
  const m = text(lines.join('\n'));
  if (!hint) return m;
  const opts = [...new Set([hint.minPerKg, hint.medianPerKg, hint.maxPerKg].map((n) => baht(n)))];
  return { ...m, quickReply: { items: opts.map((v, i) => ({ type: 'action', action: { type: 'message', label: `${v}${opts.length === 3 && i === 1 ? ' (ราคากลาง)' : ''}`.slice(0, 20), text: v } })) } };
}

export function buyerConfirmMessage(d: Required<Omit<BuyerDraft, 'step'>>): LineMessage {
  return bubble(
    'ตรวจคำขอซื้อก่อนบันทึกค่ะ',
    [row('ต้องการซื้อ', CROP_LABEL_TH[d.crop], true), row('ปริมาณ', qty(d.quantityKg)), row('สถานที่ส่งมอบ', d.location), row('ราคาที่เสนอ', `${baht(d.offerPerKg)} บาท/กก.`)],
    [button('ยืนยันคำขอซื้อ', postbackData('buyer_confirm'), 'ยืนยันคำขอซื้อ', 'primary', '#3A4C9C'), button('แก้ไข', postbackData('buyer_edit'), 'แก้ไข', 'secondary')],
    `ตรวจคำขอซื้อ: ${CROP_LABEL_TH[d.crop]} ${qty(d.quantityKg)} ส่งที่ ${d.location} เสนอ ${baht(d.offerPerKg)} บาท/กก.`,
  );
}

/** กลุ่มเกษตรกรที่แสดงให้ผู้ซื้อเห็น — ข้อมูลรวมของกลุ่มเท่านั้น ไม่มีชื่อ บัญชี หรือราคาขั้นต่ำของใคร */
export interface GroupForBuyer {
  /** ถ้ามี → การ์ดมีปุ่ม "สนใจ เจรจากับกลุ่มนี้" */
  crop?: Crop;
  cropLabel: string;
  grade: string;
  province: string;
  members: number;
  totalKg: number;
  window: { from: string; to: string };
}

const thaiDate = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][(m ?? 1) - 1]}`;
};

/** ที่ส่งมอบของผู้ซื้อ (ข้อความอิสระ) ระบุจังหวัดเดียวกับกลุ่มไหม — เทียบข้อความอย่างเดียว ไม่ได้คำนวณระยะทาง */
export const sameProvince = (location: string, province: string) => location.replace(/\s/g, '').includes(province.replace(/\s/g, ''));

function groupBubble(g: GroupForBuyer, req: { quantityKg: number; location: string }, title: string) {
  const enough = g.totalKg >= req.quantityKg;
  return {
    type: 'bubble',
    size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#E5E8F6', contents: [{ type: 'text', text: title, weight: 'bold', size: 'sm', color: '#3A4C9C', wrap: true }] },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: `${g.cropLabel} เกรด ${g.grade}`, weight: 'bold', size: 'md', wrap: true },
        row('จังหวัด', `${g.province}${sameProvince(req.location, g.province) ? ' (จังหวัดเดียวกับที่ส่งมอบ)' : ''}`),
        row('สมาชิก', `${g.members} คน`),
        row('ปริมาณรวม', qty(g.totalKg)),
        row('ส่งมอบได้', g.window.from === g.window.to ? thaiDate(g.window.from) : `${thaiDate(g.window.from)} – ${thaiDate(g.window.to)}`),
        row('เทียบกับที่คุณต้องการ', enough ? `พอสำหรับ ${qty(req.quantityKg)} ✓` : `ได้ ${qty(g.totalKg)} จาก ${qty(req.quantityKg)}`),
        { type: 'separator' },
        { type: 'text', text: MOCK_NOTE, size: 'xxs', color: '#888888', wrap: true },
      ],
    },
    ...(g.crop ? { footer: { type: 'box', layout: 'vertical', contents: [button('สนใจ เจรจากับกลุ่มนี้', postbackData('buyer_negotiate', undefined, g.crop), 'สนใจ เจรจากับกลุ่มนี้', 'primary', '#3A4C9C')] } } : {}),
  };
}

/** หลังผู้ซื้อยืนยันคำขอ: กลุ่มเกษตรกรที่ตรงกับพืชที่ต้องการ (ใกล้ที่ส่งมอบก่อน) */
export function buyerMatchesMessages(req: Pick<BuyerRequest, 'crop' | 'quantityKg' | 'offerPerKg' | 'location'>, groups: GroupForBuyer[]): LineMessage[] {
  const head = text(`บันทึกคำขอซื้อแล้วค่ะ ✓\n${CROP_LABEL_TH[req.crop]} ${qty(req.quantityKg)} ส่งที่ ${req.location} เสนอ ${baht(req.offerPerKg)} บาท/กก.`);
  if (!groups.length) return [head, text('ตอนนี้ยังไม่มีกลุ่มเกษตรกรที่ปลูกพืชนี้ค่ะ ถ้ามีกลุ่มใหม่ น้องมะระจะแจ้งเตือนคุณทันทีนะคะ 🔔')];
  const sorted = [...groups].sort((a, b) => Number(sameProvince(req.location, b.province)) - Number(sameProvince(req.location, a.province)) || b.totalKg - a.totalKg).slice(0, 10);
  return [
    head,
    {
      type: 'flex',
      altText: `กลุ่มเกษตรกรที่ตรงกับคำขอของคุณ ${sorted.length} กลุ่ม`,
      contents: { type: 'carousel', contents: sorted.map((g) => groupBubble(g, req, 'กลุ่มเกษตรกรที่ตรงกับคำขอ')) },
    },
    text('กด “สนใจ เจรจากับกลุ่มนี้” เพื่อต่อรองราคากับน้องมะระที่เป็นตัวแทนกลุ่มได้เลยค่ะ หรือพิมพ์ถามอะไรก็ได้\nถ้ามีกลุ่มใหม่ที่ตรงกับคำขอ น้องมะระจะแจ้งเตือนคุณที่นี่ค่ะ 🔔'),
  ];
}

/** แจ้งเตือนผู้ซื้อ: มีกลุ่มเกษตรกรใหม่ที่ตรงกับคำขอซื้อ */
export function buyerAlertMessage(g: GroupForBuyer, req: { quantityKg: number; location: string; offerPerKg: number }): LineMessage {
  return {
    type: 'flex',
    altText: `🔔 มีกลุ่มเกษตรกรใหม่: ${g.cropLabel} จ.${g.province} ${g.members} คน รวม ${qty(g.totalKg)}`,
    contents: groupBubble(g, req, `🔔 มีกลุ่มเกษตรกรใหม่ตรงกับคำขอของคุณ (เสนอ ${baht(req.offerPerKg)} บาท/กก.)`),
  };
}

export function buyerRequestsMessage(list: BuyerRequest[]): LineMessage {
  if (!list.length) return text('ยังไม่มีคำขอซื้อค่ะ พิมพ์อะไรมาก็ได้เพื่อเริ่มลงทะเบียน');
  return text(['คำขอซื้อล่าสุดของคุณ', ...list.map((r, i) => `${i + 1}. ${CROP_LABEL_TH[r.crop]} ${qty(r.quantityKg)} ส่งที่ ${r.location} เสนอ ${baht(r.offerPerKg)} บาท/กก.`)].join('\n'));
}

// ---------- กลุ่มเพื่อนเกษตรกร ----------

export const groupChoiceMessage = (): LineMessage =>
  bubble(
    'รวมกลุ่มกับเพื่อนเกษตรกร 🤝',
    [{ type: 'text', text: 'ขายรวมกันได้ราคาดีกว่าขายคนเดียวค่ะ มีรหัสกลุ่มเพื่อนเกษตรกรไหมคะ', size: 'sm', wrap: true }],
    [
      button('มีรหัสกลุ่ม', postbackData('group_join'), 'มีรหัสกลุ่ม', 'primary', '#2E7D32'),
      button('สร้างกลุ่มใหม่', postbackData('group_create'), 'สร้างกลุ่มใหม่', 'secondary'),
      button('ให้น้องมะระหากลุ่มให้', postbackData('group_auto'), 'ให้น้องมะระหากลุ่มให้', 'secondary'),
    ],
    'มีรหัสกลุ่มเพื่อนเกษตรกรไหม: มีรหัสกลุ่ม / สร้างกลุ่มใหม่ / ให้น้องมะระหากลุ่มให้',
  );

export const askGroupCode = () => text('พิมพ์รหัสกลุ่มที่เพื่อนส่งให้ได้เลยค่ะ (ตัวเลข 4–6 หลัก)');
export const askGroupName = () => text('ตั้งชื่อกลุ่มได้เลยค่ะ เช่น “กลุ่มข้าวหอมบ้านโนนสูง”');
export const groupNotFound = () => text('ไม่พบกลุ่มรหัสนี้ค่ะ ลองตรวจรหัสอีกครั้ง หรือพิมพ์ “ยกเลิก” แล้วเลือกสร้างกลุ่มใหม่ก็ได้นะคะ');

export function joinedMockGroupMessage(code: string, g: { members: number; province: string; cropLabel: string; totalKg: number }): LineMessage {
  return text(
    [
      `เข้ากลุ่มรหัส ${code} แล้วค่ะ ✓`,
      `${g.cropLabel} · จ.${g.province} · สมาชิก ${g.members} คน · รวม ${qty(g.totalKg)}`,
      '',
      'ต่อไปพิมพ์ผลผลิตของคุณได้เลยค่ะ ระบุพืช ปริมาณ และราคาสุทธิขั้นต่ำ เช่น',
      '“ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”',
    ].join('\n'),
  );
}

export function joinedGroupMessage(name: string, code: string, memberCount: number): LineMessage {
  return text([`เข้ากลุ่ม “${name}” (รหัส ${code}) แล้วค่ะ ✓ ตอนนี้มีสมาชิก ${memberCount} คน`, '', 'ต่อไปพิมพ์ผลผลิตของคุณได้เลยค่ะ เช่น “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”'].join('\n'));
}

export function createdGroupMessages(name: string, code: string): LineMessage[] {
  return [
    text(`สร้างกลุ่ม “${name}” แล้วค่ะ 🎉\nรหัสกลุ่ม: ${code}\n\nส่งรหัสนี้ให้เพื่อนเกษตรกร แล้วให้เพื่อนเพิ่มน้องมะระเป็นเพื่อน กด “ฉันเป็นเกษตรกร” → “มีรหัสกลุ่ม” แล้วพิมพ์รหัสนี้ได้เลยค่ะ`),
    text(['ต่อไปพิมพ์ผลผลิตของคุณได้เลยค่ะ เช่น “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”', '', '(ต้นแบบ: ระหว่างรอเพื่อนเข้ากลุ่ม น้องมะระจะรวมผลผลิตของคุณกับเกษตรกรจำลองในพื้นที่เพื่อเจรจาค่ะ)'].join('\n')),
  ];
}

export const autoGroupMessage = () =>
  text('ได้ค่ะ หนูจะหาเพื่อนเกษตรกรที่ปลูกพืชเดียวกัน เกรดเดียวกัน ในจังหวัดเดียวกัน แล้วรวมกลุ่มให้หลังคุณพิมพ์ผลผลิตนะคะ\n\nพิมพ์ผลผลิตได้เลย เช่น “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”');

/** สรุปกลุ่มตอนเริ่มเจรจา */
export const groupSummaryText = (prefix: string, g: { members: number; province: string; totalKg: number }) =>
  text(`${prefix}: รวมกับเพื่อนเกษตรกรอีก ${g.members - 1} คน · จ.${g.province} · รวม ${qty(g.totalKg)} ค่ะ`);

// ---------- ผู้ซื้อเจรจากับกลุ่มเกษตรกร ----------

/** ข้อความระหว่างเจรจา พร้อมปุ่มลัด [ยอมรับราคานี้] [จบการเจรจา] */
export function negotiationText(t: string, askPerKg: number | undefined): LineMessage {
  return {
    ...text(t),
    quickReply: {
      items: [
        ...(askPerKg !== undefined ? [{ type: 'action', action: { type: 'postback', label: `ยอมรับ ${baht(askPerKg)}`.slice(0, 20), data: postbackData('buyer_accept'), displayText: `ยอมรับราคา ${baht(askPerKg)} บาท/กก.` } }] : []),
        { type: 'action', action: { type: 'postback', label: 'จบการเจรจา', data: postbackData('buyer_end'), displayText: 'จบการเจรจา' } },
      ],
    },
  };
}

export const negotiationIntro = (g: GroupForBuyer) =>
  text(`เริ่มเจรจากับกลุ่ม${g.cropLabel} จ.${g.province} ค่ะ 🤝\nสมาชิก ${g.members} คน รวม ${qty(g.totalKg)} หนูเป็นตัวแทนของกลุ่มนะคะ เสนอราคาต่อกก. หรือถามอะไรก็ได้เลยค่ะ`);

export function negotiationAgreed(g: GroupForBuyer, agreedPerKg: number, members: number): LineMessage {
  return bubble(
    'ตกลงราคาเบื้องต้นแล้ว 🎉',
    [
      row('ผลผลิต', `${g.cropLabel} · จ.${g.province}`, true),
      row('ราคาที่ตกลง', `${baht(agreedPerKg)} บาท/กก.`, true),
      row('เกษตรกรในกลุ่ม', `อนุมัติครบ ${members} คน (ตัวจำลอง)`),
      { type: 'text', text: 'สถานะดีล: ตกลงแล้ว · ส่งมอบ: ยังไม่เริ่ม · ชำระเงิน: ยังไม่ถึงกำหนด (แยกสถานะกัน) ผู้ซื้อโอนเงินตรงเข้าบัญชีเกษตรกรแต่ละคนหลังส่งมอบ ทุกขั้นบันทึกใน ledger แบบ hash chain', size: 'xs', color: '#666666', wrap: true },
    ],
    [],
    `ตกลง ${g.cropLabel} ที่ ${baht(agreedPerKg)} บาท/กก. เกษตรกรในกลุ่มอนุมัติแล้ว (จำลอง)`,
  );
}

/** ระบบตีความว่าผู้ซื้อเสนอถึงราคาที่กลุ่มรับได้ → ขอให้ยืนยันราคานั้นก่อนตกลง */
export function negotiationConfirmDeal(g: GroupForBuyer, pricePerKg: number): LineMessage {
  return bubble(
    'ยืนยันราคาก่อนตกลงนะคะ',
    [row('ผลผลิต', `${g.cropLabel} · จ.${g.province}`), row('ราคาที่จะตกลง', `${baht(pricePerKg)} บาท/กก.`, true), { type: 'text', text: 'กดยืนยันถ้าตรงกับที่คุณตั้งใจ ถ้าไม่ใช่ กด “ยังไม่ตกลง” แล้วเจรจาต่อได้ค่ะ', size: 'xs', color: '#666666', wrap: true }],
    [button(`ยืนยันตกลงที่ ${baht(pricePerKg)}`.slice(0, 20), postbackData('buyer_deal_confirm'), `ยืนยันตกลงที่ ${baht(pricePerKg)} บาท/กก.`, 'primary', '#3A4C9C'), button('ยังไม่ตกลง เจรจาต่อ', postbackData('buyer_deal_back'), 'ยังไม่ตกลง ขอเจรจาต่อ', 'secondary')],
    `ยืนยันตกลงที่ ${baht(pricePerKg)} บาท/กก. ไหมคะ`,
  );
}

/** ก่อนจบการเจรจา: สรุปราคาล่าสุดของทั้งสองฝั่ง และถามให้แน่ใจ */
export function negotiationConfirmEnd(lastOffer: number | undefined, askPerKg: number): LineMessage {
  return bubble(
    'จบการเจรจาโดยยังไม่ตกลงราคา ใช่ไหมคะ',
    [...(lastOffer !== undefined ? [row('คุณเสนอล่าสุด', `${baht(lastOffer)} บาท/กก.`)] : []), row('หนูเสนอล่าสุด', `${baht(askPerKg)} บาท/กก.`, true), { type: 'text', text: 'ถ้าจบตอนนี้ จะไม่มีดีลเกิดขึ้น และไม่มีราคาใดผูกพันทั้งสองฝ่ายค่ะ', size: 'xs', color: '#666666', wrap: true }],
    [
      button('จบ ไม่ตกลง', postbackData('buyer_end_confirm'), 'จบการเจรจา ไม่ตกลง', 'secondary'),
      button(`ตกลงที่ ${baht(askPerKg)}`.slice(0, 20), postbackData('buyer_accept'), `ตกลงที่ ${baht(askPerKg)} บาท/กก.`, 'primary', '#3A4C9C'),
      button('เจรจาต่อ', postbackData('buyer_deal_back'), 'เจรจาต่อ', 'secondary'),
    ],
    `จบการเจรจาโดยไม่ตกลงใช่ไหม · หนูเสนอล่าสุด ${baht(askPerKg)} บาท/กก.`,
  );
}

/** บรรทัดสถานะที่โค้ดเขียนเอง — ให้เห็นชัดว่าแต่ละฝั่งเสนอเท่าไร */
export const negotiationStatusLine = (offer: number | undefined, askPerKg: number, round: number) =>
  `รอบ ${round} · ${offer !== undefined ? `คุณเสนอ ${baht(offer)} · ` : ''}หนูเสนอ ${baht(askPerKg)} บาท/กก.`;
