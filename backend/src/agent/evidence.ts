// ทะเบียนหลักฐาน — ข้อเท็จจริงที่ Agent อ้างกับผู้ซื้อได้ ทุกรายการมาจาก tool หรือข้อมูลในระบบ ไม่ใช่จาก LLM
//  - verified = ข้อมูลจริงจากแหล่งที่ตรวจได้ (NABC, ข้อมูลกลุ่ม, ข้อเสนอของผู้ซื้อ, ประวัติที่ระบบบันทึก)
//  - verified = false = ข้อมูลจำลอง/สมมติฐาน (เช่น ความรู้ใน RAG ที่เขียนขึ้นเพื่อต้นแบบ) อ้างได้แต่ต้องบอกว่าไม่ใช่ข้อเท็จจริงยืนยัน
// ข้อความถึงผู้ซื้อใช้ตัวเลขได้เฉพาะที่อยู่ในทะเบียนนี้ (และราคาที่กำลังเสนอ) — กันการแต่งสถิติ ราคาคนกลาง หรือข้อเสนอคู่แข่ง

import type { ArgumentClaim, ArgumentTag } from '../buyer/mockBuyer.js';

export type EvidenceKind = 'market' | 'volume' | 'grade' | 'delivery' | 'logistics' | 'members' | 'buyer_offer' | 'competing' | 'history' | 'knowledge';

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  /** ข้อความสั้นสำหรับแสดงบนหน้าเว็บและให้ LLM อ่าน */
  label: string;
  /** ประโยคสั้นสำหรับพูดกับผู้ซื้อ (ไม่มีวันที่หรือตัวเลขอื่นนอกจาก value) */
  say?: string;
  value?: number;
  unit?: string;
  verified: boolean;
  source: string;
  /** เหตุผลที่ผู้ซื้อรับรู้ได้เมื่ออ้างหลักฐานนี้ */
  tag?: ArgumentTag;
  /** ตัวเลขอื่นในหลักฐานนี้ที่พูดถึงได้ (เช่น วันที่ ตัน) */
  extraNumbers?: number[];
  /** competing: ใช้อ้างกับผู้ซื้อรายนี้ไม่ได้ (เป็นข้อเสนอของเขาเอง) */
  excludeBuyerId?: string;
}

export const STRATEGIES = [
  'anchor', // เปิดราคาสูงอย่างมีเหตุผลรองรับ
  'evidence_value', // ชี้คุณค่าด้วยหลักฐาน (ราคาตลาด ปริมาณ คุณภาพ)
  'address_objection', // ตอบข้อกังวลที่ผู้ซื้อยกมาโดยตรง
  'conditional_concession', // ยอมลดถ้าผู้ซื้อให้เงื่อนไขแลก
  'trade_off', // แลกเงื่อนไขอื่น (ส่วนหัก วันส่ง การรับของ)
  'contest_deduction', // ต่อรองลดส่วนหัก
  'competitive_leverage', // ใช้ข้อเสนอจริงของผู้ซื้อรายอื่น
  'final_push', // ขอปิดที่ราคานี้ก่อนหมดรอบ
] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const STRATEGY_TH: Record<Strategy, string> = {
  anchor: 'ตั้งราคาเปิดพร้อมเหตุผล',
  evidence_value: 'ชี้คุณค่าด้วยหลักฐาน',
  address_objection: 'ตอบข้อกังวลของผู้ซื้อ',
  conditional_concession: 'ยอมลดแบบมีเงื่อนไข',
  trade_off: 'แลกเงื่อนไข',
  contest_deduction: 'ต่อรองส่วนหัก',
  competitive_leverage: 'อ้างข้อเสนอจริงของรายอื่น',
  final_push: 'ขอปิดดีล',
};

const THAI_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const thaiDay = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${THAI_MONTH[(m ?? 1) - 1]}`;
};

export class EvidenceRegistry {
  private items = new Map<string, Evidence>();

  add(e: Evidence): Evidence {
    this.items.set(e.id, e);
    return e;
  }
  remove(id: string) {
    this.items.delete(id);
  }
  get(id: string) {
    return this.items.get(id);
  }
  list(): Evidence[] {
    return [...this.items.values()];
  }
  /** สำหรับใส่ในผล tool ให้ LLM เห็นว่ามีอะไรอ้างได้ */
  brief(items: Evidence[] = this.list()) {
    return items.map((e) => ({ id: e.id, label: e.label, ...(e.say ? { say: e.say } : {}), ...(e.verified ? {} : { note: 'ข้อมูลจำลอง/สมมติฐาน ห้ามอ้างเป็นข้อเท็จจริง' }) }));
  }

  /**
   * ตัวเลขที่พูดถึงได้ (ไม่รวมราคาขั้นต่ำ ซึ่งไม่เคยอยู่ในทะเบียน)
   * withExtra=false: เฉพาะค่าหลัก (ราคา ปริมาณ) — ใช้เป็นข้อยกเว้นของการตรวจการรั่ว
   * วันที่และตัวเลขประกอบ (extraNumbers) ไม่ได้รับยกเว้น: ถ้าบังเอิญตรงกับราคาขั้นต่ำ ข้อความจะถูกบล็อกไว้ก่อน
   */
  numbers(withExtra = true): number[] {
    const out: number[] = [];
    for (const e of this.items.values()) {
      if (typeof e.value === 'number') {
        out.push(e.value);
        if (e.unit === 'กก.' && e.value >= 1000) out.push(e.value / 1000); // 41,500 กก. = 41.5 ตัน
      }
      if (withExtra) out.push(...(e.extraNumbers ?? []));
    }
    return out;
  }

  /** แปลงหลักฐานที่อ้างเป็นเหตุผลที่ผู้ซื้อรับรู้ได้ */
  claims(ids: string[]): ArgumentClaim[] {
    return ids.flatMap((id) => {
      const e = this.items.get(id);
      return e?.tag ? [{ tag: e.tag, ...(typeof e.value === 'number' ? { value: e.value } : {}) }] : [];
    });
  }
}

/** ตัวเลขของวันที่ ISO (ปี เดือน วัน และปี พ.ศ.) เพื่อให้อ้างวันที่ของแหล่งข้อมูลได้ */
export const dateNumbers = (iso: string): number[] => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return [y, m, d, (y ?? 0) + 543].filter((n): n is number => Number.isFinite(n));
};

/** ตัวเลขในข้อความที่ไม่มีในทะเบียนหลักฐาน (และไม่ใช่ตัวเลขที่อนุญาต) */
export function unverifiedNumbers(numbersInMessage: number[], allowed: number[]): number[] {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  return numbersInMessage.filter((n) => !allowed.some((a) => near(a, n)));
}
