// Farm Profile: ข้อมูลแปลงของเกษตรกรที่เก็บไว้ตั้งแต่ช่วงวางแผนปลูก เพื่อให้พร้อมขายทันทีเมื่อถึงรอบ
// คำแนะนำพืชและผลผลิตคาดการณ์คิดด้วยตารางกฎในโค้ด (ไม่ใช้ AI) — เป็นค่าประมาณเบื้องต้น ไม่ใช่คำแนะนำทางวิชาการ

import type { Crop } from './types.js';
import { regionOf, type Region } from './transportEstimate.js';

export type Soil = 'loam' | 'clay' | 'sand' | 'unknown';
export const SOIL_TH: Record<Soil, string> = { loam: 'ดินร่วน', clay: 'ดินเหนียว', sand: 'ดินทราย', unknown: 'ไม่แน่ใจ' };

export interface FarmProfile {
  /** พืชที่วางแผนจะปลูก (undefined = ยังไม่ตัดสินใจ ขอคำแนะนำ) */
  crop?: Crop;
  rai: number;
  soil: Soil;
  /** พืชที่ปลูกรอบก่อน (ชื่อตามที่เกษตรกรพิมพ์/กด) */
  previousCrop?: string;
  province?: string;
  /** เดือนที่คาดว่าจะเก็บเกี่ยว YYYY-MM */
  harvestMonth?: string;
  /** ราคาสุทธิขั้นต่ำที่ตั้งไว้ล่วงหน้า (บาท/กก.) — ใช้ตอนขายจริง ข้อมูลส่วนตัว ไม่ส่งให้ผู้ซื้อ */
  floorPerKg?: number;
  /** ดีลที่ปิดสำเร็จแล้ว (ประวัติการส่งมอบ) */
  deliveries: number;
  updatedAt: string;
}

/** ผลผลิตเฉลี่ยต่อไร่โดยประมาณ (กก.) — ตัวเลขกลม ๆ สำหรับวางแผนคร่าว ๆ */
export const YIELD_PER_RAI: Record<Crop, number> = { rice_hommali: 380, cassava: 3_300, corn: 700, rubber: 250, bitter_gourd: 2_500 };

/** ระยะเวลาปลูกถึงเก็บเกี่ยวโดยประมาณ (เดือน) */
export const GROW_MONTHS: Record<Crop, number> = { rice_hommali: 4, cassava: 10, corn: 4, rubber: 84, bitter_gourd: 2 };

const SOIL_FIT: Record<Crop, Record<Exclude<Soil, 'unknown'>, number>> = {
  rice_hommali: { clay: 3, loam: 2, sand: 2 },
  cassava: { sand: 3, loam: 3, clay: 1 },
  corn: { loam: 3, clay: 2, sand: 1 },
  rubber: { loam: 3, sand: 2, clay: 1 },
  bitter_gourd: { loam: 3, clay: 2, sand: 1 },
};
const REGION_FIT: Record<Crop, Record<Region, number>> = {
  rice_hommali: { northeast: 3, north: 2, central: 2, east: 1, west: 1, south: 1 },
  cassava: { northeast: 3, east: 3, central: 2, west: 2, north: 1, south: 0 },
  corn: { north: 3, west: 3, central: 2, northeast: 2, east: 1, south: 0 },
  rubber: { south: 3, east: 3, northeast: 2, north: 1, central: 1, west: 1 },
  bitter_gourd: { central: 3, west: 3, east: 2, north: 2, northeast: 2, south: 2 },
};
const REASON_SOIL: Record<Crop, string> = {
  rice_hommali: 'ดินเหนียวอุ้มน้ำดี เหมาะกับนาข้าว',
  cassava: 'ทนแล้ง ขึ้นได้ดีในดินร่วนปนทราย',
  corn: 'ชอบดินร่วนระบายน้ำดี',
  rubber: 'ชอบดินร่วนลึก ระบายน้ำดี',
  bitter_gourd: 'รอบสั้น ขายได้ไว ต้องมีน้ำรดสม่ำเสมอ',
};
const REGION_TH: Record<Region, string> = { north: 'ภาคเหนือ', northeast: 'ภาคอีสาน', central: 'ภาคกลาง', east: 'ภาคตะวันออก', west: 'ภาคตะวันตก', south: 'ภาคใต้' };

export interface CropAdvice {
  crop: Crop;
  score: number;
  reasons: string[];
  expectedKg: number;
}

/** แนะนำพืช 2 อันดับจาก เนื้อดิน × ภาค × พืชรอบก่อน (กันปลูกซ้ำจนดินเสื่อม) */
export function recommendCrops(p: Pick<FarmProfile, 'soil' | 'province' | 'previousCrop' | 'rai'>, previousCropCode?: Crop): CropAdvice[] {
  const region = p.province ? regionOf(p.province) : undefined;
  const crops = Object.keys(SOIL_FIT) as Crop[];
  return crops
    .map((crop) => {
      const reasons: string[] = [];
      let score = 0;
      if (p.soil !== 'unknown') {
        const s = SOIL_FIT[crop][p.soil];
        score += s;
        if (s >= 3) reasons.push(`${SOIL_TH[p.soil]}: ${REASON_SOIL[crop]}`);
      } else score += 2;
      if (region) {
        const r = REGION_FIT[crop][region];
        score += r;
        if (r >= 3) reasons.push(`${REGION_TH[region]}ปลูกกันมาก ตลาดรับซื้อใกล้`);
        if (r === 0) reasons.push(`${REGION_TH[region]}ไม่ค่อยเหมาะ`);
      }
      if (previousCropCode === crop && (crop === 'cassava' || crop === 'corn')) {
        score -= 2;
        reasons.push('ปลูกซ้ำติดกันทำให้ดินเสื่อม ควรสลับพืช');
      }
      if (previousCropCode === 'rice_hommali' && (crop === 'corn' || crop === 'bitter_gourd')) {
        score += 1;
        reasons.push('ปลูกหลังนาได้ ใช้แปลงคุ้มขึ้น');
      }
      if (crop === 'rubber') reasons.push('ใช้เวลา 6–7 ปีกว่าจะกรีดได้ เหมาะกับคนวางแผนระยะยาว');
      return { crop, score, reasons, expectedKg: Math.round(YIELD_PER_RAI[crop] * p.rai) };
    })
    .sort((a, b) => b.score - a.score || a.crop.localeCompare(b.crop))
    .slice(0, 2);
}

export const expectedYieldKg = (p: Pick<FarmProfile, 'crop' | 'rai'>) => (p.crop ? Math.round(YIELD_PER_RAI[p.crop] * p.rai) : undefined);

/** เดือนถัดไป n เดือน (YYYY-MM) นับจากวันนี้ (เวลาไทย) */
export function upcomingMonths(now: Date, n: number): string[] {
  const d = new Date(now.getTime() + 7 * 3600_000);
  return Array.from({ length: n }, (_, i) => {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i + 1, 1));
    return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

const MONTHS_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const monthTh = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_TH[(m ?? 1) - 1]} ${String((y ?? 2026) + 543).slice(2)}`;
};

/** อ่านจำนวนไร่: "10 ไร่", "10", "สิบไร่", "2.5" */
export function parseRai(raw: string): number | undefined {
  const t = raw.replace(/[๐-๙]/g, (d) => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d))).replace(/,/g, '');
  const m = /(\d+(?:\.\d+)?)\s*(?:ไร่)?/.exec(t);
  const n = m ? Number(m[1]) : undefined;
  return n !== undefined && n > 0 && n <= 10_000 ? n : undefined;
}
