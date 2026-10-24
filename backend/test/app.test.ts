import { readFileSync } from 'node:fs';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { MockBuyerApi } from '../src/buyer/mockBuyer.js';
import { RuleBasedMockLlm } from '../src/agent/llm/mock.js';
import { AppError, getDeal, recordApproval, runDeal, startDeal, type AppContext } from '../src/app/service.js';
import { handleHttp } from '../src/aws/http.js';
import { KNOWLEDGE_FILES } from '../src/generated/knowledge.js';
import { summarize } from '../src/market/nabcClient.js';
import { chunkFiles, loadKnowledgeDir } from '../src/rag/chunker.js';
import { KnowledgeIndex } from '../src/rag/search.js';
import { MemoryDealStore } from '../src/store/memory.js';
import { fileURLToPath } from 'node:url';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/nabc-2026-10-19.json', import.meta.url), 'utf8'));
const knowledge = new KnowledgeIndex(chunkFiles(KNOWLEDGE_FILES));

function makeCtx(opts: { autoRun?: boolean; dailyLimit?: number } = {}) {
  const store = new MemoryDealStore();
  const queued: string[] = [];
  let n = 0;
  const ctx: AppContext = {
    store,
    dailyLimit: opts.dailyLimit ?? 10,
    newId: () => `deal-${++n}`,
    now: () => new Date('2026-10-19T03:00:00Z'),
    llm: () => new RuleBasedMockLlm(),
    agentDeps: () => ({ buyers: new MockBuyerApi(), knowledge, market: { getReference: async (c, d, p) => summarize(fixture.data, c, d, false, p) } }),
    invokeWorker: async (id) => {
      queued.push(id);
      if (opts.autoRun !== false) await runDeal(ctx, id);
    },
  };
  return { ctx, store, queued };
}

const http = (method: string, path: string, body?: unknown): APIGatewayProxyEventV2 =>
  ({ rawPath: path, requestContext: { http: { method } }, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false }) as unknown as APIGatewayProxyEventV2;

describe('บริการดีล (ไม่ใช้ AWS)', () => {
  it('เริ่มดีล → worker เจรจา → บันทึก timeline และผลลงที่เก็บข้อมูล', async () => {
    const { ctx, store } = makeCtx();
    const { id } = await startDeal(ctx, { crop: 'rice_hommali' });
    const view = await getDeal(ctx, id);
    expect(view.status).toBe('pending_approval');
    expect(view.deal).toMatchObject({ buyerId: 'B-C' });
    expect(view.steps.some((s) => s.kind === 'rag')).toBe(true);
    expect(view.ledgerVerified).toBe(true);
    expect(view.buyerMinKg).toBe(10_000);
    expect((await store.listEvents(id)).length).toBeGreaterThan(40);
  });

  it('worker ถูกเรียกซ้ำ (Lambda retry) → ไม่เจรจาซ้ำ', async () => {
    const { ctx, store } = makeCtx();
    const { id } = await startDeal(ctx, { crop: 'cassava' });
    const before = (await store.listEvents(id)).length;
    await runDeal(ctx, id);
    expect((await store.listEvents(id)).length).toBe(before);
  });

  it('ทุกคนอนุมัติ → ตกลงดีล แยกสถานะส่งมอบ/ชำระเงิน และต่อ hash chain', async () => {
    const { ctx } = makeCtx();
    const { id } = await startDeal(ctx, { crop: 'rice_hommali' });
    const ids = (await getDeal(ctx, id)).farmers.map((f) => String(f.id));
    for (const f of ids.slice(0, -1)) expect((await recordApproval(ctx, id, { farmerId: f, decision: 'approve' })).status).toBe('pending_approval');
    expect((await recordApproval(ctx, id, { farmerId: ids.at(-1), decision: 'approve' })).status).toBe('agreed');
    const v = await getDeal(ctx, id);
    expect(v).toMatchObject({ status: 'agreed', deliveryStatus: 'not_started', paymentStatus: 'not_due', ledgerVerified: true });
    await expect(recordApproval(ctx, id, { farmerId: ids[0], decision: 'reject' })).rejects.toMatchObject({ status: 409 });
  });

  it('สมาชิกปฏิเสธ → ถอนตัว คนที่เหลืออนุมัติแล้วไปต่อได้', async () => {
    const { ctx } = makeCtx();
    const { id } = await startDeal(ctx, { crop: 'rice_hommali' });
    await recordApproval(ctx, id, { farmerId: 'F04', decision: 'reject' });
    for (const f of ['F01', 'F02']) await recordApproval(ctx, id, { farmerId: f, decision: 'approve' });
    const r = await recordApproval(ctx, id, { farmerId: 'F03', decision: 'approve' });
    expect(r.status).toBe('agreed');
  });

  it('คนในเส้นทางเดียวกันถอนตัว → ค่าขนส่งต่อกก. ของคนที่เหลือเพิ่ม และระบบตรวจ floor ใหม่', async () => {
    const { ctx } = makeCtx();
    const { id } = await startDeal(ctx, { crop: 'rice_hommali' });
    // F04 (6 ตัน) ถอน → F03 แบกค่าขนส่งเที่ยว RE-2 คนเดียว 8,000/15,000 = 0.53 บาท/กก.
    await recordApproval(ctx, id, { farmerId: 'F04', decision: 'reject' });
    const r = await recordApproval(ctx, id, { farmerId: 'F03', decision: 'approve' });
    // 18.55 × (1 − 1.5%) − 0.53 = 17.74 ≥ ขั้นต่ำของ F03 (17.00) → ยังผ่าน ไม่ต้องเจรจาใหม่ แค่รอ F01, F02
    expect(r).toMatchObject({ status: 'pending_approval', needsRenegotiation: false, reason: expect.stringContaining('2 คน') });
  });

  it('ตรวจข้อมูลผิด และโควตาต่อวัน', async () => {
    const { ctx } = makeCtx({ autoRun: false, dailyLimit: 2 });
    await expect(startDeal(ctx, { crop: 'durian' })).rejects.toBeInstanceOf(AppError);
    await startDeal(ctx, { crop: 'rice_hommali' });
    await startDeal(ctx, { crop: 'rice_hommali' });
    await expect(startDeal(ctx, { crop: 'rice_hommali' })).rejects.toMatchObject({ status: 429 });
    const { id } = { id: 'deal-1' };
    await expect(recordApproval(ctx, id, { farmerId: 'F01', decision: 'approve' })).rejects.toMatchObject({ status: 409 }); // ยัง queued
    await expect(recordApproval(ctx, id, { farmerId: 'F99', decision: 'approve' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('HTTP routes', () => {
  it('หน้าเว็บ, เริ่มดีล, ดูดีล, อนุมัติ, 404', async () => {
    const { ctx } = makeCtx();
    const page = await handleHttp(ctx, http('GET', '/'));
    expect(page.statusCode).toBe(200);
    expect(String(page.body)).toContain('window.MARA_LIVE = true');

    const created = await handleHttp(ctx, http('POST', '/api/deals', { crop: 'rice_hommali' }));
    expect(created.statusCode).toBe(202);
    const { id } = JSON.parse(String(created.body));

    const got = await handleHttp(ctx, http('GET', `/api/deals/${id}`));
    expect(JSON.parse(String(got.body)).status).toBe('pending_approval');

    const appr = await handleHttp(ctx, http('POST', `/api/deals/${id}/approvals`, { farmerId: 'F01', decision: 'approve' }));
    expect(appr.statusCode).toBe(200);

    expect((await handleHttp(ctx, http('GET', '/api/deals'))).statusCode).toBe(200);
    expect((await handleHttp(ctx, http('GET', '/api/deals/nope'))).statusCode).toBe(404);
    expect((await handleHttp(ctx, http('GET', '/etc/passwd'))).statusCode).toBe(404);
    expect((await handleHttp(ctx, http('POST', '/api/deals', 'not json{'))).statusCode).toBe(400);
  });

  it('ข้อผิดพลาดที่ไม่คาดคิด → 500 โดยไม่เผยรายละเอียดภายใน', async () => {
    const { ctx } = makeCtx();
    ctx.store.getDeal = async () => { throw new Error('secret table name'); };
    const r = await handleHttp(ctx, http('GET', '/api/deals/x1'));
    expect(r.statusCode).toBe(500);
    expect(String(r.body)).not.toContain('secret');
  });
});

describe('ไฟล์ที่สร้างอัตโนมัติ', () => {
  it('knowledge ที่ฝังใน Lambda ตรงกับโฟลเดอร์ knowledge/ (ถ้าไม่ตรง ให้รัน npm run build:assets)', () => {
    const fromDisk = loadKnowledgeDir(fileURLToPath(new URL('../knowledge', import.meta.url)));
    expect(chunkFiles(KNOWLEDGE_FILES)).toEqual(fromDisk);
  });
});

describe('ประวัติการเจรจาจริง', () => {
  it('จบดีลแล้วบันทึกราคาเปิด/สุดท้ายของผู้ซื้อแต่ละราย และดีลถัดไปดึงมาเป็นหลักฐาน E-HIST', async () => {
    const { ctx, store } = makeCtx();
    const { id } = await startDeal(ctx, { crop: 'rice_hommali' });
    const rows = await store.listBuyerOutcomes('B-C', 'rice_hommali', 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dealId: id, openingPerKg: 18.4, chosen: true });
    expect(rows[0]!.finalPerKg).toBeGreaterThan(18.4);

    const { id: second } = await startDeal(ctx, { crop: 'rice_hommali' });
    const events = await store.listEvents(second);
    const histResults = events.filter((e) => e.type === 'agent.tool_result' && e.data.tool === 'get_negotiation_history');
    expect(histResults.some((e) => JSON.stringify(e.data).includes('E-HIST-B-C'))).toBe(true);
  });
});
