// ตรรกะของแอป (ไม่ผูกกับ AWS) — Lambda handler แค่แปลง HTTP ↔ ฟังก์ชันเหล่านี้
// ทุก dependency ส่งเข้ามา (store, LLM, ผู้ซื้อ, ตลาด) จึงเทสได้ครบโดยไม่ต้องใช้ AWS

import { MockBuyerApi } from '../buyer/mockBuyer.js';
import { canFinalize, nextDealStatus } from '../core/stateMachine.js';
import { checkPriceFloor } from '../core/pricing.js';
import { groupListings } from '../core/grouping.js';
import { Ledger, type LedgerEvent } from '../core/ledger.js';
import type { Crop, Group } from '../core/types.js';
import { farmers, listings } from '../data/synthetic.js';
import { runNegotiation, type AgentDeps } from '../agent/index.js';
import type { LlmClient } from '../agent/llm/types.js';
import { planTrips } from '../agent/transport.js';
import { buildDealView, type DealView } from '../agent/view.js';
import type { ApprovalDecision, DealRecord, DealStore } from '../store/types.js';

export interface AppContext {
  store: DealStore;
  /** เรียก worker แบบไม่รอผล (บน AWS = Lambda async invoke) */
  invokeWorker: (dealId: string) => Promise<void>;
  /** สร้าง dependency ของ Agent (ผู้ซื้อ ตลาด ความรู้) ใหม่ทุกดีล */
  agentDeps: () => AgentDeps;
  llm: () => LlmClient;
  now?: () => Date;
  dailyLimit?: number;
  newId?: () => string;
}

export class AppError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const CROPS: Crop[] = ['rice_hommali', 'bitter_gourd', 'cassava'];
const TITLES: Record<Crop, string> = { rice_hommali: 'ข้าวหอมมะลิ · ร้อยเอ็ด', bitter_gourd: 'มะระจีน · ราชบุรี', cassava: 'มันสำปะหลัง · นครราชสีมา' };

/** วันที่ตามเวลาไทย (YYYY-MM-DD) */
export const bangkokDate = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

const groupFor = (crop: Crop): Group => {
  const g = groupListings(listings, farmers).find((x) => x.crop === crop);
  if (!g) throw new AppError(400, `ไม่มีกลุ่มของพืช ${crop}`);
  return g;
};

const randomId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function startDeal(ctx: AppContext, body: { crop?: unknown }): Promise<{ id: string }> {
  const crop = body.crop as Crop;
  if (!CROPS.includes(crop)) throw new AppError(400, `crop ต้องเป็น ${CROPS.join(', ')}`);
  const now = (ctx.now ?? (() => new Date()))();
  if (!(await ctx.store.takeDailyQuota(bangkokDate(now), ctx.dailyLimit ?? 60))) {
    throw new AppError(429, 'วันนี้เจรจาครบโควตาแล้ว (กันค่าใช้จ่าย AI เกินงบ) ลองใหม่พรุ่งนี้');
  }
  const group = groupFor(crop);
  const id = (ctx.newId ?? randomId)();
  const at = now.toISOString();
  await ctx.store.createDeal({ id, crop, groupId: group.id, status: 'queued', llm: ctx.llm().name, createdAt: at, updatedAt: at, marketDate: bangkokDate(now), approvals: {} });
  await ctx.invokeWorker(id);
  return { id };
}

/** worker: รันการเจรจา 1 ดีล — เรียกซ้ำได้อย่างปลอดภัย (ทำงานเฉพาะดีลที่ยัง queued) */
export async function runDeal(ctx: AppContext, id: string): Promise<void> {
  const now = ctx.now ?? (() => new Date());
  const deal = await ctx.store.getDeal(id);
  if (!deal) throw new AppError(404, `ไม่พบดีล ${id}`);
  if (!(await ctx.store.updateDeal(id, { status: 'negotiating', updatedAt: now().toISOString() }, 'queued'))) return; // มีคนรันไปแล้ว

  const group = groupFor(deal.crop);
  const ledger = new Ledger(now);
  let chain: Promise<void> = Promise.resolve();
  try {
    const res = await runNegotiation({ dealId: id, group, farmers, listings, date: deal.marketDate }, ctx.agentDeps(), ctx.llm(), {
      ledger,
      now,
      // เขียนเหตุการณ์ตามลำดับทีละรายการ เพื่อให้หน้าเว็บเห็นความคืบหน้าแบบสด
      onEvent: () => {
        const ev = ledger.list().at(-1)!;
        chain = chain.then(() => ctx.store.appendEvents(id, [ev]));
        return chain;
      },
    });
    await chain;
    await ctx.store.updateDeal(id, { status: res.status, outcome: res.outcome, metrics: res.metrics, updatedAt: now().toISOString() });
  } catch (e) {
    await chain.catch(() => undefined);
    await ctx.store.updateDeal(id, { status: 'failed', error: (e as Error).message, updatedAt: now().toISOString() });
    throw e;
  }
}

export interface LiveDealView extends DealView {
  approvals: Record<string, ApprovalDecision>;
  createdAt: string;
  deliveryStatus?: string;
  paymentStatus?: string;
  buyerMinKg?: number;
  attention?: string;
  ledgerVerified: boolean;
}

export async function getDeal(ctx: AppContext, id: string): Promise<LiveDealView> {
  const deal = await ctx.store.getDeal(id);
  if (!deal) throw new AppError(404, `ไม่พบดีล ${id}`);
  const events = await ctx.store.listEvents(id);
  const group = groupFor(deal.crop);
  const view = buildDealView({
    id,
    title: `ดีลสด · ${TITLES[deal.crop]}`,
    note: deal.status === 'queued' || deal.status === 'negotiating' ? 'น้องมะระกำลังเจรจาอยู่ หน้านี้อัปเดตเองทุกไม่กี่วินาที' : 'การเจรจาสดบน AWS',
    llm: deal.llm,
    status: deal.status,
    group,
    farmers,
    listings,
    trace: events.filter((e) => e.type.startsWith('agent.')).map((e) => ({ type: e.type.slice(6), data: e.data, at: e.at })),
    ...(deal.outcome ? { outcome: deal.outcome } : {}),
    ...(deal.metrics ? { metrics: deal.metrics } : {}),
  });
  let ledgerVerified = true;
  try {
    Ledger.from(events);
  } catch {
    ledgerVerified = false;
  }
  return {
    ...view,
    ...(deal.error ? { reason: deal.error } : {}),
    approvals: deal.approvals ?? {},
    createdAt: deal.createdAt,
    ...(deal.deliveryStatus ? { deliveryStatus: deal.deliveryStatus } : {}),
    ...(deal.paymentStatus ? { paymentStatus: deal.paymentStatus } : {}),
    ...(view.deal ? { buyerMinKg: buyerMinKg(view.deal.buyerId) } : {}),
    ...(deal.status === 'pending_approval' ? { attention: approvalState(deal, group).blockedReason } : {}),
    ledgerVerified,
  };
}

export async function listDeals(ctx: AppContext) {
  return (await ctx.store.listRecentDeals(20)).map((d) => ({ id: d.id, crop: d.crop, status: d.status, createdAt: d.createdAt, llm: d.llm }));
}

const buyerMinKg = (buyerId: string) => new MockBuyerApi().getProfile(buyerId)?.minKg ?? 0;

/** สมาชิกที่ปฏิเสธถอนตัว คนที่เหลือต้องยังผ่าน floor (ค่าขนส่งต่อกก. อาจเพิ่มเมื่อคนในเส้นทางเดียวกันถอนตัว) */
function approvalState(deal: DealRecord, group: Group) {
  if (deal.outcome?.kind !== 'prepared') return { ok: false as const, blockedReason: 'ไม่มีดีลให้อนุมัติ' };
  const active = group.members.filter((m) => deal.approvals[m.farmerId] !== 'reject');
  const terms = { ...deal.outcome.terms, trips: planTrips(active, farmers) };
  const floorPasses = active.length > 0 && checkPriceFloor(active, listings, terms).passes;
  const remainingKg = active.reduce((s, m) => s + m.quantityKg, 0);
  const minKg = buyerMinKg(deal.outcome.buyerId);
  const r = canFinalize({
    status: 'pending_approval',
    activeFarmerIds: active.map((m) => m.farmerId),
    approvals: deal.approvals,
    floorPasses,
    remainingKg,
    buyerMinKg: minKg,
  });
  const needsRenegotiation = !floorPasses || remainingKg < minKg;
  return { ok: r.ok, needsRenegotiation, blockedReason: r.ok ? undefined : r.reason, terms };
}

/** เกษตรกรกดอนุมัติ/ปฏิเสธ — บันทึกลง ledger (hash chain ต่อจากของ Agent) แล้วตรวจว่าปิดดีลได้หรือยัง */
export async function recordApproval(ctx: AppContext, id: string, body: { farmerId?: unknown; decision?: unknown }) {
  const farmerId = String(body.farmerId ?? '');
  const decision = body.decision as ApprovalDecision;
  if (decision !== 'approve' && decision !== 'reject') throw new AppError(400, 'decision ต้องเป็น approve หรือ reject');
  const now = (ctx.now ?? (() => new Date()))();
  const deal = await ctx.store.getDeal(id);
  if (!deal) throw new AppError(404, `ไม่พบดีล ${id}`);
  const group = groupFor(deal.crop);
  if (!group.members.some((m) => m.farmerId === farmerId)) throw new AppError(400, `เกษตรกร ${farmerId} ไม่ได้อยู่ในกลุ่มนี้`);
  if (!(await ctx.store.setApproval(id, farmerId, decision, now.toISOString()))) throw new AppError(409, 'ดีลนี้ไม่ได้อยู่ในสถานะรออนุมัติแล้ว');

  await appendLedger(ctx, id, { actor: 'farmer', actorId: farmerId, type: `approval.${decision}`, data: { farmerId, decision } }, now);

  const fresh = (await ctx.store.getDeal(id))!;
  const st = approvalState(fresh, group);
  if (st.ok) {
    const to = nextDealStatus('pending_approval', 'agreed');
    if (await ctx.store.updateDeal(id, { status: to, deliveryStatus: 'not_started', paymentStatus: 'not_due', updatedAt: now.toISOString() }, 'pending_approval')) {
      await appendLedger(ctx, id, { actor: 'system', type: 'deal.agreed', data: { approvals: fresh.approvals } }, now);
    }
  }
  return { status: st.ok ? 'agreed' : 'pending_approval', reason: st.blockedReason, needsRenegotiation: st.needsRenegotiation ?? false };
}

async function appendLedger(ctx: AppContext, id: string, ev: { actor: LedgerEvent['actor']; actorId?: string; type: string; data: Record<string, unknown> }, now: Date) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ledger = Ledger.from(await ctx.store.listEvents(id), () => now);
    const e = ledger.append({ dealId: id, ...ev });
    if (await ctx.store.appendEventIfNew(id, e)) return;
  }
  throw new AppError(409, 'บันทึกลง ledger ไม่สำเร็จเพราะมีการแก้ไขพร้อมกัน ลองใหม่อีกครั้ง');
}
