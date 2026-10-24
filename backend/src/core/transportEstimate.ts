// ประมาณค่าขนส่งแบบหยาบจากจังหวัดของกลุ่มเกษตรกรไปถึงที่ส่งมอบของผู้ซื้อ
// ยังไม่มีข้อมูลระยะทางหรือราคาขนส่งจริงในต้นแบบ → ใช้ "ระยะตามภูมิภาค" กับอัตราสมมติ และบอกผู้ใช้ทุกครั้งว่าเป็นค่าประมาณ

export type Region = 'north' | 'northeast' | 'central' | 'east' | 'west' | 'south';

const REGIONS: Record<Region, string[]> = {
  north: ['เชียงใหม่', 'เชียงราย', 'ลำพูน', 'ลำปาง', 'แพร่', 'น่าน', 'พะเยา', 'แม่ฮ่องสอน', 'อุตรดิตถ์'],
  central: [
    'กรุงเทพมหานคร', 'นนทบุรี', 'ปทุมธานี', 'สมุทรปราการ', 'สมุทรสาคร', 'สมุทรสงคราม', 'นครปฐม', 'พระนครศรีอยุธยา', 'อ่างทอง', 'ลพบุรี', 'สิงห์บุรี',
    'ชัยนาท', 'สระบุรี', 'นครนายก', 'สุพรรณบุรี', 'อุทัยธานี', 'นครสวรรค์', 'พิจิตร', 'พิษณุโลก', 'สุโขทัย', 'เพชรบูรณ์', 'กำแพงเพชร',
  ],
  east: ['ชลบุรี', 'ระยอง', 'จันทบุรี', 'ตราด', 'ฉะเชิงเทรา', 'ปราจีนบุรี', 'สระแก้ว'],
  west: ['ตาก', 'กาญจนบุรี', 'ราชบุรี', 'เพชรบุรี', 'ประจวบคีรีขันธ์'],
  northeast: [
    'นครราชสีมา', 'บุรีรัมย์', 'สุรินทร์', 'ศรีสะเกษ', 'อุบลราชธานี', 'ยโสธร', 'ชัยภูมิ', 'อำนาจเจริญ', 'บึงกาฬ', 'หนองบัวลำภู', 'ขอนแก่น',
    'อุดรธานี', 'เลย', 'หนองคาย', 'มหาสารคาม', 'ร้อยเอ็ด', 'กาฬสินธุ์', 'สกลนคร', 'นครพนม', 'มุกดาหาร',
  ],
  south: ['ชุมพร', 'ระนอง', 'สุราษฎร์ธานี', 'พังงา', 'ภูเก็ต', 'กระบี่', 'นครศรีธรรมราช', 'ตรัง', 'พัทลุง', 'สงขลา', 'สตูล', 'ปัตตานี', 'ยะลา', 'นราธิวาส'],
};

export const PROVINCES: string[] = Object.values(REGIONS).flat();
const REGION_OF = new Map(Object.entries(REGIONS).flatMap(([r, ps]) => ps.map((p) => [p, r as Region])));

const ALIASES: [RegExp, string][] = [
  [/กทม|กรุงเทพ/, 'กรุงเทพมหานคร'],
  [/โคราช/, 'นครราชสีมา'],
  [/อยุธยา/, 'พระนครศรีอยุธยา'],
  [/อุบล(?!ราชธานี)/, 'อุบลราชธานี'],
  [/สุราษฎร์(?!ธานี)/, 'สุราษฎร์ธานี'],
  [/ปากน้ำ/, 'สมุทรปราการ'],
  [/หาดใหญ่/, 'สงขลา'],
];

const ADJACENT: Record<Region, Region[]> = {
  central: ['north', 'northeast', 'east', 'west', 'south'],
  north: ['central', 'northeast', 'west'],
  northeast: ['central', 'north', 'east'],
  east: ['central', 'northeast'],
  west: ['central', 'north', 'south'],
  south: ['west', 'central'],
};

/** อัตราสมมติ (บาท/กก.) สำหรับรถบรรทุกเหมาเที่ยว — ใช้ประมาณการเท่านั้น */
export const ESTIMATE_RATES = { same_province: 0.2, same_region: 0.45, adjacent_region: 0.75, far: 1.1 } as const;
export type DistanceBasis = keyof typeof ESTIMATE_RATES;

export const BASIS_TH: Record<DistanceBasis, string> = {
  same_province: 'จังหวัดเดียวกัน',
  same_region: 'ภาคเดียวกัน',
  adjacent_region: 'ภาคติดกัน',
  far: 'ข้ามภาคระยะไกล',
};

/** หาจังหวัดในข้อความที่อยู่ (ชื่อยาวสุดก่อน กันชื่อสั้นไปจับบางส่วนของชื่อยาว) */
export function findProvince(text: string): string | undefined {
  const t = text.replace(/\s+/g, '');
  const direct = [...PROVINCES].sort((a, b) => b.length - a.length).find((p) => t.includes(p));
  if (direct) return direct;
  return ALIASES.find(([re]) => re.test(t))?.[1];
}

export interface TransportEstimate {
  fromProvince: string;
  toProvince?: string;
  basis?: DistanceBasis;
  perKg?: number;
  totalBaht?: number;
}

export function estimateTransport(fromProvince: string, destination: string, quantityKg?: number): TransportEstimate {
  const toProvince = findProvince(destination);
  const a = REGION_OF.get(fromProvince);
  const b = toProvince ? REGION_OF.get(toProvince) : undefined;
  if (!toProvince || !a || !b) return { fromProvince, ...(toProvince ? { toProvince } : {}) };
  const basis: DistanceBasis = toProvince === fromProvince ? 'same_province' : a === b ? 'same_region' : ADJACENT[a].includes(b) ? 'adjacent_region' : 'far';
  const perKg = ESTIMATE_RATES[basis];
  return { fromProvince, toProvince, basis, perKg, ...(quantityKg ? { totalBaht: Math.round(perKg * quantityKg) } : {}) };
}
