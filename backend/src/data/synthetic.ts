// ข้อมูลจำลองสำหรับเดโม — ไม่ใช่ข้อมูลเกษตรกรหรือราคาจริง
// ราคาขั้นต่ำของข้าวและมันสำปะหลังตั้งให้ใกล้ราคาอ้างอิงจริงจาก NABC (19 ต.ค. 2569):
//   ข้าวเปลือกหอมมะลิ 105 ≈ 14.40–18.33 บาท/กก. (ร้อยเอ็ด 17.80), มันสำปะหลังสด ≈ 3.65–4.30 บาท/กก.
// มะระไม่มีใน NABC → ราคาจำลองทั้งหมด · ยางพาราและข้าวโพดเลี้ยงสัตว์: ราคาจำลอง (ยังไม่ได้เทียบ NABC)

import type { Crop, Farmer, Listing } from '../core/types.js';

export const CROP_LABEL_TH: Record<Crop, string> = {
  rice_hommali: 'ข้าวเปลือกหอมมะลิ',
  bitter_gourd: 'มะระจีน',
  cassava: 'มันสำปะหลังสด',
  rubber: 'ยางพาราแผ่นดิบ',
  corn: 'ข้าวโพดเลี้ยงสัตว์',
};

/** ชื่อสั้นสำหรับปุ่ม */
export const CROP_SHORT_TH: Record<Crop, string> = { rice_hommali: 'ข้าว', rubber: 'ยาง', corn: 'ข้าวโพด', bitter_gourd: 'มะระ', cassava: 'มันสำปะหลัง' };

export const farmers: Farmer[] = [
  // กลุ่มข้าวหอมมะลิ ร้อยเอ็ด (ทุ่งกุลาร้องไห้) — เส้นทาง 2 สาย
  { id: 'F01', name: 'สมศรี ใจดี', province: 'ร้อยเอ็ด', district: 'เกษตรวิสัย', routeId: 'RE-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x1234-x' },
  { id: 'F02', name: 'บุญมา ทองคำ', province: 'ร้อยเอ็ด', district: 'เกษตรวิสัย', routeId: 'RE-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x2241-x' },
  { id: 'F03', name: 'คำปุน แสงจันทร์', province: 'ร้อยเอ็ด', district: 'สุวรรณภูมิ', routeId: 'RE-2', bankAccountMasked: 'ธ.ก.ส. xxx-x-x3307-x' },
  { id: 'F04', name: 'ประยูร ศรีสุข', province: 'ร้อยเอ็ด', district: 'สุวรรณภูมิ', routeId: 'RE-2', bankAccountMasked: 'กรุงไทย xxx-x-x4410-x' },
  { id: 'F05', name: 'มาลัย บุญเรือง', province: 'ร้อยเอ็ด', district: 'ปทุมรัตต์', routeId: 'RE-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x5582-x' },
  // มะระจีน ราชบุรี
  { id: 'F06', name: 'วันเพ็ญ พรมมา', province: 'ราชบุรี', district: 'ดำเนินสะดวก', routeId: 'RB-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x6631-x' },
  { id: 'F07', name: 'สุชาติ แก้วกล้า', province: 'ราชบุรี', district: 'ดำเนินสะดวก', routeId: 'RB-1', bankAccountMasked: 'กสิกร xxx-x-x7719-x' },
  { id: 'F08', name: 'อำไพ นาคสวัสดิ์', province: 'ราชบุรี', district: 'บ้านโป่ง', routeId: 'RB-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x8804-x' },
  // มันสำปะหลัง นครราชสีมา
  { id: 'F09', name: 'ทองดี มีสุข', province: 'นครราชสีมา', district: 'ด่านขุนทด', routeId: 'NR-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x9120-x' },
  { id: 'F10', name: 'สายสุนีย์ ปัญญาดี', province: 'นครราชสีมา', district: 'ด่านขุนทด', routeId: 'NR-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x1058-x' },
  // ยางพาราแผ่นดิบ สุราษฎร์ธานี (ราคาจำลอง)
  { id: 'F11', name: 'สมชาย ทองสุข', province: 'สุราษฎร์ธานี', district: 'พุนพิน', routeId: 'SR-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x1172-x' },
  { id: 'F12', name: 'จันทร์เพ็ญ ศรีทอง', province: 'สุราษฎร์ธานี', district: 'พุนพิน', routeId: 'SR-1', bankAccountMasked: 'ออมสิน xxx-x-x1265-x' },
  // ข้าวโพดเลี้ยงสัตว์ เพชรบูรณ์ (ราคาจำลอง)
  { id: 'F13', name: 'ประเสริฐ ดวงดี', province: 'เพชรบูรณ์', district: 'หล่มสัก', routeId: 'PB-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x1388-x' },
  { id: 'F14', name: 'บัวผัน คำแก้ว', province: 'เพชรบูรณ์', district: 'หล่มสัก', routeId: 'PB-1', bankAccountMasked: 'ธ.ก.ส. xxx-x-x1449-x' },
];

export const listings: Listing[] = [
  { id: 'L01', farmerId: 'F01', crop: 'rice_hommali', grade: 'A', quantityKg: 12_000, harvestDate: '2026-11-10', deliveryDate: '2026-11-20', floorPricePerKg: 16.8 },
  { id: 'L02', farmerId: 'F02', crop: 'rice_hommali', grade: 'A', quantityKg: 8_500, harvestDate: '2026-11-12', deliveryDate: '2026-11-21', floorPricePerKg: 16.5 },
  { id: 'L03', farmerId: 'F03', crop: 'rice_hommali', grade: 'A', quantityKg: 15_000, harvestDate: '2026-11-14', deliveryDate: '2026-11-22', floorPricePerKg: 17.0 },
  { id: 'L04', farmerId: 'F04', crop: 'rice_hommali', grade: 'A', quantityKg: 6_000, harvestDate: '2026-11-15', deliveryDate: '2026-11-24', floorPricePerKg: 16.2 },
  { id: 'L05', farmerId: 'F05', crop: 'rice_hommali', grade: 'B', quantityKg: 9_000, harvestDate: '2026-11-11', deliveryDate: '2026-11-20', floorPricePerKg: 15.5 },
  { id: 'L06', farmerId: 'F06', crop: 'bitter_gourd', grade: 'A', quantityKg: 1_800, harvestDate: '2026-10-28', deliveryDate: '2026-10-29', floorPricePerKg: 18.0 },
  { id: 'L07', farmerId: 'F07', crop: 'bitter_gourd', grade: 'A', quantityKg: 2_200, harvestDate: '2026-10-28', deliveryDate: '2026-10-30', floorPricePerKg: 17.5 },
  { id: 'L08', farmerId: 'F08', crop: 'bitter_gourd', grade: 'A', quantityKg: 1_500, harvestDate: '2026-10-29', deliveryDate: '2026-10-30', floorPricePerKg: 19.0 },
  { id: 'L09', farmerId: 'F09', crop: 'cassava', grade: 'A', quantityKg: 25_000, harvestDate: '2026-12-05', deliveryDate: '2026-12-08', floorPricePerKg: 3.7 },
  { id: 'L10', farmerId: 'F10', crop: 'cassava', grade: 'A', quantityKg: 30_000, harvestDate: '2026-12-06', deliveryDate: '2026-12-09', floorPricePerKg: 3.6 },
  { id: 'L11', farmerId: 'F11', crop: 'rubber', grade: 'A', quantityKg: 2_500, harvestDate: '2026-11-02', deliveryDate: '2026-11-05', floorPricePerKg: 58.0 },
  { id: 'L12', farmerId: 'F12', crop: 'rubber', grade: 'A', quantityKg: 3_000, harvestDate: '2026-11-02', deliveryDate: '2026-11-06', floorPricePerKg: 59.0 },
  { id: 'L13', farmerId: 'F13', crop: 'corn', grade: 'A', quantityKg: 20_000, harvestDate: '2026-11-20', deliveryDate: '2026-11-25', floorPricePerKg: 8.4 },
  { id: 'L14', farmerId: 'F14', crop: 'corn', grade: 'A', quantityKg: 15_000, harvestDate: '2026-11-21', deliveryDate: '2026-11-26', floorPricePerKg: 8.6 },
];
