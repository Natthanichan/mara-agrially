// โมเดลข้อมูลหลักของ MaRa-AgriAlly (ข้อมูลจำลองทั้งหมดในต้นแบบ)

export type Crop = 'rice_hommali' | 'bitter_gourd' | 'cassava';
export type Grade = 'A' | 'B' | 'C';

export interface Farmer {
  id: string;
  name: string;
  province: string;
  district: string;
  /** รหัสเส้นทางขนส่ง ฟาร์มในเส้นทางเดียวกันใช้เที่ยวรถเดียวกันได้ */
  routeId: string;
  /** บัญชีรับเงินตรง (จำลอง) ผู้ซื้อโอนเข้าบัญชีนี้โดยตรง */
  bankAccountMasked: string;
}

/** ผลผลิตที่เกษตรกรพร้อมขาย 1 รายการ */
export interface Listing {
  id: string;
  farmerId: string;
  crop: Crop;
  grade: Grade;
  quantityKg: number;
  harvestDate: string; // ISO date
  deliveryDate: string; // ISO date
  /** ราคาสุทธิขั้นต่ำต่อกก. (บาท) — ข้อมูลส่วนตัว ห้ามส่งให้ผู้ซื้อ */
  floorPricePerKg: number;
}

export interface GroupMember {
  farmerId: string;
  listingId: string;
  quantityKg: number;
  confirmed: boolean;
  /** สมาชิกที่ปฏิเสธดีลจะถูกตัดออก แต่กลุ่มไปต่อได้ */
  status: 'active' | 'withdrawn';
}

export interface Group {
  id: string;
  crop: Crop;
  grade: Grade;
  province: string;
  deliveryWindow: { from: string; to: string };
  members: GroupMember[];
}

/** ส่วนหักที่ตกลงกับผู้ซื้อ */
export type Deduction =
  | { kind: 'per_kg'; label: string; amountPerKg: number }
  | { kind: 'percent'; label: string; percent: number }
  | { kind: 'lump_sum'; label: string; amount: number }; // แบ่งตามสัดส่วนน้ำหนัก

/** เที่ยวขนส่ง: ค่าขนส่งรวม ÷ น้ำหนักรวมของเที่ยว */
export interface TransportTrip {
  id: string;
  totalCost: number;
  farmerIds: string[];
}

export interface DealTerms {
  pricePerKg: number;
  deductions: Deduction[];
  trips: TransportTrip[];
}
