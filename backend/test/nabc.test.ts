import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemorySnapshotStore, NabcClient, summarize, toPerKg, type NabcRecord } from '../src/market/nabcClient.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/nabc-2026-10-19.json', import.meta.url), 'utf8'));
const DAY = '2026-10-19';

/** fetch ปลอม: ไม่เรียกเน็ตจริงตอนเทส */
const fakeFetch = (handler: (url: string) => unknown) => async (url: string) => {
  const body = handler(url);
  if (body instanceof Error) throw body;
  return { ok: true, status: 200, json: async () => body };
};

describe('NABC: แปลงหน่วยและสรุปราคา', () => {
  it('แปลง บาท/ตัน → บาท/กก. และไม่เดาหน่วยที่ไม่รู้จัก', () => {
    expect(toPerKg(17800, 'บาท/ตัน')).toBe(17.8);
    expect(toPerKg(18333, 'บาท/ตัน')).toBe(18.33);
    expect(toPerKg(3.65, 'บาท/กก.')).toBe(3.65);
    expect(toPerKg(100, 'บาท/ลูก')).toBeUndefined();
    expect(toPerKg(0, 'บาท/กก.')).toBeUndefined();
  });

  it('สรุปข้าวหอมมะลิจากข้อมูลจริง 19 ต.ค. และดึงราคาจังหวัดร้อยเอ็ด', () => {
    const ref = summarize(fixture.data, 'rice_hommali', DAY, false, 'ร้อยเอ็ด')!;
    expect(ref.quotes).toHaveLength(6);
    expect([ref.minPerKg, ref.maxPerKg, ref.medianPerKg]).toEqual([14.4, 18.33, 17.65]);
    expect(ref.provinceQuotes).toEqual([
      expect.objectContaining({ market: 'โรงสีสหกรณ์การเกษตรสุวรรณภูมิ', pricePerKg: 17.8 }),
    ]);
  });

  it('สรุปมันสำปะหลัง และไม่นับข้าวโพดที่มีคำว่า "ข้าว"', () => {
    const maize: NabcRecord = { data_date: DAY, product_category: 'ข้าวโพด', product_name: 'ข้าวโพดเลี้ยงสัตว์ (ตัวอย่างทดสอบ)', market_name: 'x', province: 'x', day_price: 9000, unit: 'บาท/ตัน' };
    const rice = summarize([...fixture.data, maize], 'rice_hommali', DAY, false)!;
    expect(rice.quotes).toHaveLength(6);
    const cassava = summarize(fixture.data, 'cassava', DAY, false, 'นครราชสีมา')!;
    expect([cassava.minPerKg, cassava.maxPerKg, cassava.medianPerKg]).toEqual([3.65, 4.3, 4]);
    expect(cassava.provinceQuotes).toHaveLength(3);
  });

  it('มะระไม่มีใน NABC → คืน undefined (ไม่สร้างราคาขึ้นเอง)', () => {
    expect(summarize(fixture.data, 'bitter_gourd', DAY, false)).toBeUndefined();
  });
});

describe('NabcClient: ดึงข้อมูลและสำรองเมื่อ API ล่ม', () => {
  it('ดึงหลายหน้าจนครบ total', async () => {
    const urls: string[] = [];
    const rows = fixture.data as NabcRecord[];
    const client = new NabcClient({
      fetch: fakeFetch((url) => {
        urls.push(url);
        const page = Number(new URL(url).searchParams.get('page'));
        return { success: true, data: rows.slice((page - 1) * 5, page * 5), pagination: { limit: 5, total: rows.length } };
      }),
    });
    const all = await client.fetchDay(DAY);
    expect(all).toHaveLength(13);
    expect(urls).toHaveLength(3);
  });

  it('เก็บ snapshot แล้วใช้ซ้ำ ไม่เรียก API ซ้ำในวันเดียวกัน', async () => {
    let calls = 0;
    const client = new NabcClient({ fetch: fakeFetch(() => (calls++, fixture)) });
    await client.getReference('rice_hommali', DAY);
    const ref = await client.getReference('cassava', DAY);
    expect(calls).toBe(1);
    expect(ref?.stale).toBe(false);
  });

  it('API ล่ม → ใช้ snapshot วันก่อนหน้า และระบุว่าเป็นข้อมูลเก่า', async () => {
    const store = new MemorySnapshotStore();
    await store.put(DAY, fixture.data);
    const client = new NabcClient({ store, fetch: fakeFetch(() => new Error('ECONNRESET')) });
    const ref = await client.getReference('rice_hommali', '2026-10-20');
    expect(ref).toMatchObject({ date: DAY, stale: true, medianPerKg: 17.65 });
  });

  it('API ล่มและไม่มี snapshot → คืน undefined ให้ Agent หยุดอย่างปลอดภัย', async () => {
    const client = new NabcClient({ fetch: fakeFetch(() => new Error('down')) });
    expect(await client.getReference('rice_hommali', DAY)).toBeUndefined();
  });

  it('timeout เมื่อ API ช้าเกินกำหนด', async () => {
    const client = new NabcClient({
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    await expect(client.fetchDay(DAY)).rejects.toThrow(/ไม่ตอบภายใน 20 ms/);
  });

  it('ปฏิเสธข้อมูลรูปแบบผิดและวันที่ผิด', async () => {
    const client = new NabcClient({ fetch: fakeFetch(() => ({ success: false })) });
    await expect(client.fetchDay(DAY)).rejects.toThrow(/รูปแบบข้อมูล/);
    await expect(client.fetchDay('19/10/2026')).rejects.toThrow(/วันที่/);
  });
});
