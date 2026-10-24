// ตรรกะของแอป (ไม่ผูกกับ AWS) — Lambda handler แค่แปลง HTTP ↔ ฟังก์ชันเหล่านี้
// ทุก dependency ส่งเข้ามา (store, LLM, ผู้ซื้อ, ตลาด) จึงเทสได้ครบโดยไม่ต้องใช้ AWS

import { MockBuyerApi } from '../buyer/mockBuyer.js';
import { canFinalize, nextDealStatus } from '../core/stateMachine.js';
import { checkPriceFloor, computeNetPerFarmer } from '../core/pricing.js';
import { groupListings } from '../core/grouping.js';
import { Ledger, type LedgerEvent } from '../core/ledger.js';
import type { Crop, Group, Listing } from '../core/types.js';
import { farmers, listings } from '../data/synthetic.js';
import { runNegotiation, type AgentDeps } from '../agent/index.js';
import type { LlmClient } from '../agent/llm/types.js';
import { planTrips } from '../agent/transport.js';
import { buildDealView, type DealView } from '../agent/view.js';
import type { ApprovalDecision, DealRecord, DealStore, ListingDraft } from '../store/types.js';

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
  /** ตัวเชื่อม LINE (ไม่บังคับ) — ถ้าไม่ตั้ง ระบบทำงานเฉพาะหน้าเว็บ/API */
  line?: LineHooks;
  /** LLM สำหรับแชตใน LINE (ไม่บังคับ) — ไม่ตั้ง = ใช้การอ่านข้อความแบบกฎเหมือนเดิม */
  chatLlm?: () => LlmClient | undefined;
  /** จำนวนข้อความแชตที่เรียก AI ได้ต่อวัน (กันค่าใช้จ่าย) */
  chatDailyLimit?: number;
}

export interface LineHooks {
  /** ประมวลผล webhook ที่ผ่านการตรวจลายเซ็นแล้วเท่านั้น */
  handleWebhook(rawBody: string, signature: string | undefined, baseUrl?: string): Promise<{ status: number; error?: string }>;
  /** worker เรียกเมื่อดีลที่เริ่มจาก LINE เจรจาเสร็จ (ส่งผลหาเกษตรกรครั้งเดียว) */
  notifyDealReady(dealId: string): Promise<void>;
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

/** เกษตรกรในข้อมูลจำลองที่ผู้ใช้ LINE สวมบทบาท (1 คนต่อพืช) */
export const LINE_FARMER_SLOT: Record<Crop, string> = { rice_hommali: 'F01', bitter_gourd: 'F06', cassava: 'F09' };

/** รายการผลผลิตของดีลนี้: ข้อมูลจำลอง โดยแทนที่รายการของเกษตรกรใน LINE ด้วยที่เขาพิมพ์ */
export const dealListings = (d: Pick<DealRecord, 'listingOverrides'>): Listing[] => {
  const ov = new Map((d.listingOverrides ?? []).map((l) => [l.farmerId, l]));
  return ov.size ? listings.map((l) => ov.get(l.farmerId) ?? l) : listings;
};

const groupFor = (crop: Crop, ls: Listing[] = listings, mustInclude?: string): Group => {
  const gs = groupListings(ls, farmers).filter((x) => x.crop === crop);
  if (mustInclude) {
    const mine = gs.find((x) => x.members.some((m) => m.farmerId === mustInclude));
    if (!mine) throw new AppError(400, 'ผลผลิตเกรดนี้ยังไม่มีเพื่อนเกษตรกรในกลุ่มเดียวกันให้รวมขาย (ต้องมีอย่างน้อย 2 คน เกรดเดียวกัน จังหวัดเดียวกัน) ลองระบุเกรด A');
    return mine;
  }
  const g = gs[0];
  if (!g) throw new AppError(400, `ไม่มีกลุ่มของพืช ${crop}`);
  return g;
};
const groupForDeal = (d: DealRecord) => groupFor(d.crop, dealListings(d), d.lineFarmerId);

const randomId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface LineStart {
  userId: string;
  draft: ListingDraft;
  /** ต่อรองใหม่ครั้งที่เท่าไร (0 = ครั้งแรก) */
  round?: number;
  baseUrl?: string;
}

export const MAX_LINE_ROUNDS = 3;

export async function startDeal(ctx: AppContext, body: { crop?: unknown }, opts: { line?: LineStart } = {}): Promise<{ id: string }> {
  const crop = (opts.line ? opts.line.draft.crop : body.crop) as Crop;
  if (!CROPS.includes(crop)) throw new AppError(400, `crop ต้องเป็น ${CROPS.join(', ')}`);
  const now = (ctx.now ?? (() => new Date()))();

  // ผู้ใช้ LINE สวมบทบาทเกษตรกร 1 คนในกลุ่มจำลอง โดยใช้ผลผลิตที่เขาพิมพ์แทนรายการเดิม
  let override: Listing | undefined;
  let lineFarmerId: string | undefined;
  if (opts.line) {
    if ((opts.line.round ?? 0) > MAX_LINE_ROUNDS) throw new AppError(409, `ต่อรองใหม่ได้ไม่เกิน ${MAX_LINE_ROUNDS} ครั้งต่อรายการ`);
    lineFarmerId = LINE_FARMER_SLOT[crop];
    const base = listings.find((l) => l.farmerId === lineFarmerId)!;
    const d = opts.line.draft;
    override = { ...base, grade: d.grade, quantityKg: d.quantityKg, floorPricePerKg: d.floorPricePerKg };
  }
  const ls = override ? dealListings({ listingOverrides: [override] }) : listings;
  const group = groupFor(crop, ls, lineFarmerId); // ตรวจว่าจัดกลุ่มได้ก่อนหักโควตา

  if (!(await ctx.store.takeDailyQuota(bangkokDate(now), ctx.dailyLimit ?? 60))) {
    throw new AppError(429, 'วันนี้เจรจาครบโควตาแล้ว (กันค่าใช้จ่าย AI เกินงบ) ลองใหม่พรุ่งนี้');
  }
  const id = (ctx.newId ?? randomId)();
  const at = now.toISOString();
  await ctx.store.createDeal({
    id,
    crop,
    groupId: group.id,
    status: 'queued',
    llm: ctx.llm().name,
    createdAt: at,
    updatedAt: at,
    marketDate: bangkokDate(now),
    approvals: {},
    ...(opts.line && override && lineFarmerId ? { lineUserId: opts.line.userId, lineFarmerId, listingOverrides: [override], round: opts.line.round ?? 0, ...(opts.line.baseUrl ? { lineBaseUrl: opts.line.baseUrl } : {}) } : {}),
  });
  await ctx.invokeWorker(id);
  return { id };
}

/** ประวัติการเจรจาจริงจากที่เก็บข้อมูล → ให้ Agent อ้างเป็นหลักฐานได้ */
const storeHistory = (store: DealStore) => ({
  forBuyer: async (buyerId: string, crop: Crop) => (await store.listBuyerOutcomes(buyerId, crop, 5)).map(({ dealId, at, openingPerKg, finalPerKg, decision, chosen }) => ({ dealId, at, openingPerKg, finalPerKg, decision, chosen })),
});

/** บันทึกราคาเปิด/ราคาสุดท้ายของผู้ซื้อแต่ละรายในดีลนี้ — ล้มเหลวได้โดยไม่กระทบผลเจรจา */
async function recordOutcomes(ctx: AppContext, dealId: string, crop: Crop, trace: { type: string; data: Record<string, unknown> }[], outcome: { kind: string; buyerId?: string }, at: string) {
  try {
    const byBuyer = new Map<string, { opening: number; final: number; decision: string }>();
    for (const t of trace) {
      if (t.type !== 'buyer_response') continue;
      const id = String(t.data.buyerId);
      const price = Number(t.data.pricePerKg);
      const cur = byBuyer.get(id);
      byBuyer.set(id, { opening: cur?.opening ?? price, final: price, decision: String(t.data.decision) });
    }
    const rows = [...byBuyer].map(([buyerId, v]) => ({ buyerId, crop, dealId, at, openingPerKg: v.opening, finalPerKg: v.final, decision: v.decision, chosen: outcome.kind === 'prepared' && outcome.buyerId === buyerId }));
    if (rows.length) await ctx.store.recordBuyerOutcomes(rows);
  } catch (e) {
    console.error('record buyer outcomes failed', (e as Error).message);
  }
}

/** แจ้งผลหาเกษตรกรใน LINE — ล้มเหลวได้โดยไม่ทำให้ดีลพัง */
async function notifyReady(ctx: AppContext, id: string) {
  try {
    await ctx.line?.notifyDealReady(id);
  } catch (e) {
    console.error('line notify failed', (e as Error).message);
  }
}

/** worker: รันการเจรจา 1 ดีล — เรียกซ้ำได้อย่างปลอดภัย (ทำงานเฉพาะดีลที่ยัง queued) */
export async function runDeal(ctx: AppContext, id: string): Promise<void> {
  const now = ctx.now ?? (() => new Date());
  const deal = await ctx.store.getDeal(id);
  if (!deal) throw new AppError(404, `ไม่พบดีล ${id}`);
  if (!(await ctx.store.updateDeal(id, { status: 'negotiating', updatedAt: now().toISOString() }, 'queued'))) return; // มีคนรันไปแล้ว

  const ls = dealListings(deal);
  const group = groupForDeal(deal);
  const ledger = new Ledger(now);
  let chain: Promise<void> = Promise.resolve();
  try {
    const base = ctx.agentDeps();
    const deps = { ...base, history: base.history ?? storeHistory(ctx.store) };
    const res = await runNegotiation({ dealId: id, group, farmers, listings: ls, date: deal.marketDate }, deps, ctx.llm(), {
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
    await recordOutcomes(ctx, id, deal.crop, res.trace, res.outcome, now().toISOString());
  } catch (e) {
    await chain.catch(() => undefined);
    await ctx.store.updateDeal(id, { status: 'failed', error: (e as Error).message, updatedAt: now().toISOString() });
    await notifyReady(ctx, id);
    throw e;
  }
  await notifyReady(ctx, id);
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
  const group = groupForDeal(deal);
  const view = buildDealView({
    id,
    title: `ดีลสด · ${TITLES[deal.crop]}`,
    note: deal.status === 'queued' || deal.status === 'negotiating' ? 'น้องมะระกำลังเจรจาอยู่ หน้านี้อัปเดตเองทุกไม่กี่วินาที' : 'การเจรจาสดบน AWS',
    llm: deal.llm,
    status: deal.status,
    group,
    farmers,
    listings: dealListings(deal),
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
  const floorPasses = active.length > 0 && checkPriceFloor(active, dealListings(deal), terms).passes;
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
export async function recordApproval(ctx: AppContext, id: string, body: { farmerId?: unknown; decision?: unknown }, opts: { simulated?: boolean } = {}) {
  const farmerId = String(body.farmerId ?? '');
  const decision = body.decision as ApprovalDecision;
  if (decision !== 'approve' && decision !== 'reject') throw new AppError(400, 'decision ต้องเป็น approve หรือ reject');
  const now = (ctx.now ?? (() => new Date()))();
  const deal = await ctx.store.getDeal(id);
  if (!deal) throw new AppError(404, `ไม่พบดีล ${id}`);
  const group = groupForDeal(deal);
  if (!group.members.some((m) => m.farmerId === farmerId)) throw new AppError(400, `เกษตรกร ${farmerId} ไม่ได้อยู่ในกลุ่มนี้`);
  if (!(await ctx.store.setApproval(id, farmerId, decision, now.toISOString()))) throw new AppError(409, 'ดีลนี้ไม่ได้อยู่ในสถานะรออนุมัติแล้ว');

  await appendLedger(ctx, id, { actor: 'farmer', actorId: farmerId, type: `approval.${decision}`, data: { farmerId, decision, ...(opts.simulated ? { simulated: true } : {}) } }, now);

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

/** บันทึกเหตุการณ์ลง ledger (hash chain) ของรหัสใดก็ได้ — ใช้กับการเจรจาฝั่งผู้ซื้อใน LINE ด้วย */
export const appendAudit = (ctx: AppContext, id: string, ev: { actor: LedgerEvent['actor']; actorId?: string; type: string; data: Record<string, unknown> }) =>
  appendLedger(ctx, id, ev, (ctx.now ?? (() => new Date()))());

async function appendLedger(ctx: AppContext, id: string, ev: { actor: LedgerEvent['actor']; actorId?: string; type: string; data: Record<string, unknown> }, now: Date) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ledger = Ledger.from(await ctx.store.listEvents(id), () => now);
    const e = ledger.append({ dealId: id, ...ev });
    if (await ctx.store.appendEventIfNew(id, e)) return;
  }
  throw new AppError(409, 'บันทึกลง ledger ไม่สำเร็จเพราะมีการแก้ไขพร้อมกัน ลองใหม่อีกครั้ง');
}

export interface FarmerOffer {
  buyerName: string;
  pricePerKg: number;
  deductions: string[];
  /** ตัวเลขของเกษตรกรคนนี้ (คิดด้วยโค้ด ไม่ใช่ AI) */
  mine: { quantityKg: number; netPerKg: number; netTotal: number; transportPerKg: number; floorPerKg: number; passesFloor: boolean };
  group: { memberCount: number; totalKg: number; netPerKgAvg: number; totalNetBaht: number };
  /** ราคาตลาดอ้างอิง (มัธยฐาน) ถ้ามี */
  marketMedianPerKg?: number;
}

/** ข้อมูลดีลที่ส่งให้เกษตรกรอ่านก่อนกดอนุมัติ */
export async function getFarmerOffer(ctx: AppContext, id: string, farmerId: string): Promise<FarmerOffer> {
  const deal = await ctx.store.getDeal(id);
  if (!deal) throw new AppError(404, `ไม่พบดีล ${id}`);
  if (deal.outcome?.kind !== 'prepared') throw new AppError(409, 'ดีลนี้ยังไม่มีข้อเสนอให้อนุมัติ');
  const group = groupForDeal(deal);
  const st = approvalState(deal, group);
  if (!st.terms) throw new AppError(409, 'ดีลนี้ยังไม่มีข้อเสนอให้อนุมัติ');
  const active = group.members.filter((m) => deal.approvals[m.farmerId] !== 'reject');
  const nets = computeNetPerFarmer(active, st.terms);
  const mine = nets.find((n) => n.farmerId === farmerId);
  const floor = dealListings(deal).find((l) => l.farmerId === farmerId)?.floorPricePerKg;
  if (!mine || floor === undefined) throw new AppError(400, `เกษตรกร ${farmerId} ไม่ได้อยู่ในดีลนี้`);
  const totalKg = active.reduce((s, m) => s + m.quantityKg, 0);
  const totalNet = nets.reduce((s, n) => s + n.netTotal, 0);
  return {
    buyerName: deal.outcome.buyerName,
    pricePerKg: st.terms.pricePerKg,
    deductions: deal.outcome.evaluation.deductions,
    mine: { quantityKg: mine.quantityKg, netPerKg: mine.netPerKg, netTotal: mine.netTotal, transportPerKg: mine.transportPerKg, floorPerKg: floor, passesFloor: mine.netPerKg >= floor },
    group: { memberCount: active.length, totalKg, netPerKgAvg: totalKg > 0 ? Math.floor((totalNet / totalKg) * 100) / 100 : 0, totalNetBaht: Math.round(totalNet * 100) / 100 },
    ...(deal.metrics?.marketMedianPerKg !== undefined ? { marketMedianPerKg: deal.metrics.marketMedianPerKg } : {}),
  };
}

/**
 * สมาชิกกลุ่มคนอื่นในเดโมเป็นตัวจำลอง — อนุมัติให้อัตโนมัติ (บันทึกใน ledger ว่า simulated)
 * คืนผลของการอนุมัติครั้งสุดท้าย (หรือสถานะปัจจุบันถ้าไม่มีใครต้องอนุมัติเพิ่ม)
 */
export async function approveSimulatedMembers(ctx: AppContext, id: string, exceptFarmerId: string) {
  const deal = await ctx.store.getDeal(id);
  if (!deal) throw new AppError(404, `ไม่พบดีล ${id}`);
  const group = groupForDeal(deal);
  let last: Awaited<ReturnType<typeof recordApproval>> | undefined;
  for (const m of group.members) {
    if (m.farmerId === exceptFarmerId || deal.approvals[m.farmerId]) continue;
    try {
      last = await recordApproval(ctx, id, { farmerId: m.farmerId, decision: 'approve' }, { simulated: true });
    } catch (e) {
      if (!(e instanceof AppError && e.status === 409)) throw e;
    }
  }
  if (last) return last;
  const fresh = (await ctx.store.getDeal(id))!;
  const st = approvalState(fresh, group);
  return { status: fresh.status === 'agreed' ? 'agreed' : 'pending_approval', reason: st.blockedReason, needsRenegotiation: st.needsRenegotiation ?? false };
}

/** เกษตรกรสั่งต่อรองใหม่ — ยกเลิกดีลเดิม (ถ้ายังรออนุมัติ) แล้วเริ่มดีลใหม่ด้วยผลผลิตเดิม */
export async function renegotiate(ctx: AppContext, id: string, lineUserId: string, baseUrl?: string): Promise<{ id: string }> {
  const deal = await ctx.store.getDeal(id);
  if (!deal) throw new AppError(404, `ไม่พบดีล ${id}`);
  const mine = deal.listingOverrides?.[0];
  if (deal.lineUserId !== lineUserId || !mine) throw new AppError(403, 'ดีลนี้ไม่ใช่ของคุณ');
  if (deal.status !== 'pending_approval' && deal.status !== 'failed') throw new AppError(409, 'ดีลนี้ต่อรองใหม่ไม่ได้แล้ว');
  const next = (deal.round ?? 0) + 1;
  if (next > MAX_LINE_ROUNDS) throw new AppError(409, `ต่อรองใหม่ได้ไม่เกิน ${MAX_LINE_ROUNDS} ครั้งต่อรายการ`);

  const draft: ListingDraft = { crop: deal.crop, quantityKg: mine.quantityKg, grade: mine.grade, floorPricePerKg: mine.floorPricePerKg };
  const created = await startDeal(ctx, {}, { line: { userId: lineUserId, draft, round: next, ...((baseUrl ?? deal.lineBaseUrl) ? { baseUrl: baseUrl ?? deal.lineBaseUrl } : {}) } });
  if (deal.status === 'pending_approval') {
    const now = (ctx.now ?? (() => new Date()))();
    if (await ctx.store.updateDeal(id, { status: nextDealStatus('pending_approval', 'cancelled'), updatedAt: now.toISOString() }, 'pending_approval')) {
      await appendLedger(ctx, id, { actor: 'farmer', actorId: deal.lineFarmerId ?? '', type: 'deal.renegotiation_requested', data: { newDealId: created.id } }, now);
    }
  }
  return created;
}
