// ข้อมูลจำลองสำหรับเดโม — ไม่ใช่ข้อมูลเกษตรกรหรือราคาจริง
// ราคาตั้งให้อยู่ในช่วงที่สมเหตุสมผล แต่ไม่ได้อ้างอิงราคาตลาด ณ วันใดวันหนึ่ง

import type { Crop, Farmer, Listing } from '../core/types.js';

export const CROP_LABEL_TH: Record<Crop, string> = {
  rice_hommali: 'ข้าวเปลือกหอมมะลิ',
  bitter_gourd: 'มะระจีน',
  cassava: 'มันสำปะหลังสด',
};

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
];

export const listings: Listing[] = [
  { id: 'L01', farmerId: 'F01', crop: 'rice_hommali', grade: 'A', quantityKg: 12_000, harvestDate: '2026-11-10', deliveryDate: '2026-11-20', floorPricePerKg: 13.2 },
  { id: 'L02', farmerId: 'F02', crop: 'rice_hommali', grade: 'A', quantityKg: 8_500, harvestDate: '2026-11-12', deliveryDate: '2026-11-21', floorPricePerKg: 13.0 },
  { id: 'L03', farmerId: 'F03', crop: 'rice_hommali', grade: 'A', quantityKg: 15_000, harvestDate: '2026-11-14', deliveryDate: '2026-11-22', floorPricePerKg: 13.5 },
  { id: 'L04', farmerId: 'F04', crop: 'rice_hommali', grade: 'A', quantityKg: 6_000, harvestDate: '2026-11-15', deliveryDate: '2026-11-24', floorPricePerKg: 12.8 },
  { id: 'L05', farmerId: 'F05', crop: 'rice_hommali', grade: 'B', quantityKg: 9_000, harvestDate: '2026-11-11', deliveryDate: '2026-11-20', floorPricePerKg: 12.0 },
  { id: 'L06', farmerId: 'F06', crop: 'bitter_gourd', grade: 'A', quantityKg: 1_800, harvestDate: '2026-10-28', deliveryDate: '2026-10-29', floorPricePerKg: 18.0 },
  { id: 'L07', farmerId: 'F07', crop: 'bitter_gourd', grade: 'A', quantityKg: 2_200, harvestDate: '2026-10-28', deliveryDate: '2026-10-30', floorPricePerKg: 17.5 },
  { id: 'L08', farmerId: 'F08', crop: 'bitter_gourd', grade: 'A', quantityKg: 1_500, harvestDate: '2026-10-29', deliveryDate: '2026-10-30', floorPricePerKg: 19.0 },
  { id: 'L09', farmerId: 'F09', crop: 'cassava', grade: 'A', quantityKg: 25_000, harvestDate: '2026-12-05', deliveryDate: '2026-12-08', floorPricePerKg: 2.6 },
  { id: 'L10', farmerId: 'F10', crop: 'cassava', grade: 'A', quantityKg: 30_000, harvestDate: '2026-12-06', deliveryDate: '2026-12-09', floorPricePerKg: 2.5 },
];
