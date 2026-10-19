// ราคาอ้างอิงตลาดจริงจาก NABC (agriapi.nabc.go.th) — ใช้เป็น tool "ดูราคาตลาด" ของ Agent
//
// ทำไมไม่ใส่ราคาใน RAG: ราคาเป็นตัวเลขที่ต้องแม่น ให้โค้ดอ่านและคำนวณ ไม่ให้ LLM สรุปเอง
// ลำดับการดึงข้อมูล: API สด → snapshot ของวันเดียวกัน → snapshot ล่าสุด (ระบุว่า stale) → ไม่มีข้อมูล

import type { Crop } from '../core/types.js';

export const NABC_BASE_URL = 'https://agriapi.nabc.go.th';
export const NABC_SOURCE_LABEL = 'ศูนย์ข้อมูลเกษตร NABC (agriapi.nabc.go.th)';

/** หน้าตาข้อมูล 1 แถวจาก API (เฉพาะ field ที่ใช้) */
export interface NabcRecord {
  data_date: string;
  product_category: string;
  product_name: string;
  market_name: string;
  province: string;
  day_price: number;
  unit: string;
}

export interface PriceQuote {
  crop: Crop;
  productName: string;
  market: string;
  province: string;
  pricePerKg: number;
}

export interface MarketReference {
  crop: Crop;
  date: string;
  source: string;
  /** true เมื่อใช้ snapshot ของวันก่อนหน้าเพราะดึงข้อมูลวันนี้ไม่ได้ */
  stale: boolean;
  quotes: PriceQuote[];
  minPerKg: number;
  maxPerKg: number;
  medianPerKg: number;
  /** ราคาในจังหวัดเดียวกับกลุ่ม (ถ้ามี) */
  provinceQuotes: PriceQuote[];
}

/** ที่เก็บ snapshot รายวัน — ตอนเทสใช้ memory, บน AWS ใช้ S3 raw/ (ทำในขั้น deploy) */
export interface SnapshotStore {
  get(date: string): Promise<NabcRecord[] | undefined>;
  put(date: string, records: NabcRecord[]): Promise<void>;
  latestBefore(date: string): Promise<{ date: string; records: NabcRecord[] } | undefined>;
}

export class MemorySnapshotStore implements SnapshotStore {
  private data = new Map<string, NabcRecord[]>();
  async get(date: string) {
    return this.data.get(date);
  }
  async put(date: string, records: NabcRecord[]) {
    this.data.set(date, structuredClone(records));
  }
  async latestBefore(date: string) {
    const dates = [...this.data.keys()].filter((d) => d < date).sort();
    const d = dates[dates.length - 1];
    return d ? { date: d, records: this.data.get(d)! } : undefined;
  }
}

export class NabcError extends Error {}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface NabcClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  /** กันวนไม่รู้จบถ้า API ตอบ pagination ผิด */
  maxPages?: number;
  store?: SnapshotStore;
}

/** จับคู่ชื่อสินค้าใน NABC กับพืชในระบบเรา — มะระไม่มีใน NABC */
const CROP_MATCHERS: Partial<Record<Crop, (r: NabcRecord) => boolean>> = {
  rice_hommali: (r) => r.product_name.includes('ข้าวเปลือก') && r.product_name.includes('หอมมะลิ'),
  cassava: (r) => r.product_name.includes('มันสำปะหลังสด'),
};

export const isCropCovered = (crop: Crop) => crop in CROP_MATCHERS;

/** แปลงหน่วยเป็นบาท/กก. คืน undefined ถ้าไม่รู้จักหน่วย (ไม่เดา) */
export function toPerKg(price: number, unit: string): number | undefined {
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const u = unit.replace(/\s/g, '');
  if (u === 'บาท/กก.' || u === 'บาท/กก' || u === 'บาท/กิโลกรัม') return Math.round(price * 100) / 100;
  if (u === 'บาท/ตัน') return Math.round((price / 1000) * 100) / 100;
  return undefined;
}

function parseRecord(x: unknown): NabcRecord | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const price = typeof o.day_price === 'number' ? o.day_price : typeof o.day_price === 'string' ? Number(o.day_price) : NaN;
  const rec = {
    data_date: str('data_date'),
    product_category: str('product_category') ?? '',
    product_name: str('product_name'),
    market_name: str('market_name') ?? '',
    province: str('province') ?? '',
    day_price: price,
    unit: str('unit'),
  };
  if (!rec.data_date || !rec.product_name || !rec.unit || !Number.isFinite(price)) return undefined;
  return rec as NabcRecord;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round(((s[m - 1]! + s[m]!) / 2) * 100) / 100;
};

/** สรุปราคาอ้างอิงของพืชหนึ่งชนิดจากข้อมูลดิบ (pure function — เทสได้ง่าย) */
export function summarize(records: NabcRecord[], crop: Crop, date: string, stale: boolean, province?: string): MarketReference | undefined {
  const match = CROP_MATCHERS[crop];
  if (!match) return undefined;
  const quotes: PriceQuote[] = [];
  for (const r of records) {
    if (!match(r)) continue;
    const perKg = toPerKg(r.day_price, r.unit);
    if (perKg === undefined) continue;
    quotes.push({ crop, productName: r.product_name, market: r.market_name, province: r.province, pricePerKg: perKg });
  }
  if (!quotes.length) return undefined;
  const prices = quotes.map((q) => q.pricePerKg);
  return {
    crop,
    date,
    source: NABC_SOURCE_LABEL,
    stale,
    quotes,
    minPerKg: Math.min(...prices),
    maxPerKg: Math.max(...prices),
    medianPerKg: median(prices),
    provinceQuotes: province ? quotes.filter((q) => q.province === province) : [],
  };
}

export class NabcClient {
  private fetchFn: FetchLike;
  private baseUrl: string;
  private timeoutMs: number;
  private maxPages: number;
  private store: SnapshotStore;

  constructor(opts: NabcClientOptions = {}) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = opts.baseUrl ?? NABC_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxPages = opts.maxPages ?? 10;
    this.store = opts.store ?? new MemorySnapshotStore();
  }

  /** ดึงข้อมูลดิบทั้งวัน (ทุกหน้า) จาก API */
  async fetchDay(date: string): Promise<NabcRecord[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new NabcError(`รูปแบบวันที่ไม่ถูกต้อง: ${date}`);
    const all: NabcRecord[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const body = await this.getJson(`${this.baseUrl}/api/daily-prices/date?date=${date}&page=${page}`);
      const o = body as { success?: unknown; data?: unknown; pagination?: { total?: unknown; limit?: unknown } };
      if (o?.success !== true || !Array.isArray(o.data)) throw new NabcError('รูปแบบข้อมูลจาก NABC ไม่ถูกต้อง');
      for (const x of o.data) {
        const r = parseRecord(x);
        if (r) all.push(r);
      }
      const total = Number(o.pagination?.total);
      const limit = Number(o.pagination?.limit);
      if (!Number.isFinite(total) || !Number.isFinite(limit) || limit <= 0 || page * limit >= total || o.data.length === 0) break;
    }
    return all;
  }

  /**
   * ราคาอ้างอิงของพืชในวันที่กำหนด
   * API ล่มหรือช้าเกิน timeout → ใช้ snapshot แทน และระบุ stale=true ถ้าเป็นข้อมูลวันก่อน
   */
  async getReference(crop: Crop, date: string, province?: string): Promise<MarketReference | undefined> {
    if (!isCropCovered(crop)) return undefined; // เช่น มะระ → ให้ Agent ใช้ข้อมูลจาก RAG/จำลองแทน
    let records = await this.store.get(date);
    let usedDate = date;
    let stale = false;
    if (!records) {
      try {
        records = await this.fetchDay(date);
        if (records.length) await this.store.put(date, records);
      } catch {
        records = undefined;
      }
    }
    if (!records?.length) {
      const prev = await this.store.latestBefore(date);
      if (!prev) return undefined;
      records = prev.records;
      usedDate = prev.date;
      stale = true;
    }
    return summarize(records, crop, usedDate, stale, province);
  }

  private async getJson(url: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, { signal: ctrl.signal });
      if (!res.ok) throw new NabcError(`NABC ตอบกลับ HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e instanceof NabcError) throw e;
      throw new NabcError(ctrl.signal.aborted ? `NABC ไม่ตอบภายใน ${this.timeoutMs} ms` : `เรียก NABC ไม่สำเร็จ: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
