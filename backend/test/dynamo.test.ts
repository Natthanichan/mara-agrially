import { describe, expect, it } from 'vitest';
import { DynamoDealStore } from '../src/store/dynamo.js';

// DynamoDB จริงปฏิเสธคำสั่งที่ประกาศ ExpressionAttributeNames/Values แต่ไม่ได้ใช้ในนิพจน์ (ValidationException)
// memory store ไม่เช็กเรื่องนี้ จึงจำลองกฎนี้ไว้ที่นี่ เพื่อกันบั๊กที่เจอบน AWS จริงกลับมา
function strictDb() {
  const calls: Record<string, unknown>[] = [];
  const db = {
    send: async (cmd: { input: Record<string, unknown> }) => {
      const i = cmd.input;
      const expr = `${i.UpdateExpression ?? ''} ${i.ConditionExpression ?? ''}`;
      for (const k of Object.keys((i.ExpressionAttributeNames as object) ?? {})) if (!expr.includes(k)) throw Object.assign(new Error(`unused name ${k}`), { name: 'ValidationException' });
      for (const k of Object.keys((i.ExpressionAttributeValues as object) ?? {})) if (!expr.includes(k)) throw Object.assign(new Error(`unused value ${k}`), { name: 'ValidationException' });
      calls.push(i);
      return {};
    },
  };
  return { store: new DynamoDealStore(db as never, 'T'), calls };
}

describe('DynamoDealStore.updateDeal', () => {
  it('อัปเดตโดยไม่ระบุสถานะที่คาดหวัง (ตอนเจรจาเสร็จ) ต้องไม่ประกาศชื่อที่ไม่ได้ใช้', async () => {
    const { store, calls } = strictDb();
    await expect(store.updateDeal('d1', { status: 'pending_approval', updatedAt: 'x' })).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ExpressionAttributeNames).not.toHaveProperty('#status');
  });

  it('อัปเดตแบบมีเงื่อนไขสถานะ (queued → negotiating) ยังใช้ #status ได้', async () => {
    const { store, calls } = strictDb();
    await expect(store.updateDeal('d1', { status: 'negotiating' }, 'queued')).resolves.toBe(true);
    expect(calls[0]!.ConditionExpression).toContain('#status = :expect');
  });
});

describe('DynamoDealStore.createBuyerRequest', () => {
  it('เขียน 2 รายการ: ของผู้ซื้อ และดัชนีตามพืช (ไว้จับคู่ภายหลัง)', async () => {
    const puts: Record<string, unknown>[] = [];
    const db = { send: async (cmd: { input: { Item?: Record<string, unknown> } }) => (cmd.input.Item && puts.push(cmd.input.Item), {}) };
    const store = new DynamoDealStore(db as never, 'T');
    await store.createBuyerRequest({ id: 'r1', userId: 'U1', crop: 'cassava', quantityKg: 5000, location: 'โคราช', offerPerKg: 4, status: 'open', createdAt: '2026-10-23T17:00:00.000Z' });
    expect(puts.map((p) => p.pk)).toEqual(['BUYERREQ#U1', 'BUYERREQ#OPEN#cassava']);
    expect(puts[0]).toMatchObject({ sk: '2026-10-23T17:00:00.000Z#r1', location: 'โคราช', offerPerKg: 4 });
    expect(puts[1]).not.toHaveProperty('location'); // ดัชนีไม่ต้องเก็บที่อยู่
  });
});
