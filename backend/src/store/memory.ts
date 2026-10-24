import type { LedgerEvent } from '../core/ledger.js';
import type { BuyerOutcome, BuyerRequest, DealRecord, DealStore, FarmerGroup, LineSession } from './types.js';

export class MemoryDealStore implements DealStore {
  sessions = new Map<string, LineSession>();
  webhookEvents = new Set<string>();
  buyerRequests: BuyerRequest[] = [];
  groups = new Map<string, FarmerGroup>();
  outcomes: BuyerOutcome[] = [];
  deals = new Map<string, DealRecord>();
  events = new Map<string, LedgerEvent[]>();
  counters = new Map<string, number>();

  async createDeal(rec: DealRecord) {
    if (this.deals.has(rec.id)) throw new Error(`ดีล ${rec.id} มีอยู่แล้ว`);
    this.deals.set(rec.id, structuredClone(rec));
  }
  async getDeal(id: string) {
    const d = this.deals.get(id);
    return d ? structuredClone(d) : undefined;
  }
  async updateDeal(id: string, patch: Partial<DealRecord>, expectStatus?: DealRecord['status']) {
    const d = this.deals.get(id);
    if (!d || (expectStatus && d.status !== expectStatus)) return false;
    this.deals.set(id, { ...d, ...structuredClone(patch) });
    return true;
  }
  async appendEvents(dealId: string, evs: LedgerEvent[]) {
    const list = this.events.get(dealId) ?? [];
    for (const e of evs) {
      if (list.some((x) => x.seq === e.seq)) throw new Error(`event ${e.seq} ซ้ำ`);
      list.push(structuredClone(e));
    }
    this.events.set(dealId, list);
  }
  async listEvents(dealId: string) {
    return [...(this.events.get(dealId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
  async listRecentDeals(limit: number) {
    return [...this.deals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async setApproval(id: string, farmerId: string, decision: 'approve' | 'reject', at: string) {
    const d = this.deals.get(id);
    if (!d || d.status !== 'pending_approval') return false;
    d.approvals = { ...d.approvals, [farmerId]: decision };
    d.updatedAt = at;
    return true;
  }
  async appendEventIfNew(dealId: string, e: LedgerEvent) {
    const list = this.events.get(dealId) ?? [];
    if (list.some((x) => x.seq === e.seq)) return false;
    list.push(structuredClone(e));
    this.events.set(dealId, list);
    return true;
  }
  async takeDailyQuota(date: string, limit: number) {
    const n = (this.counters.get(date) ?? 0) + 1;
    if (n > limit) return false;
    this.counters.set(date, n);
    return true;
  }
  async getLineSession(userId: string) {
    const s = this.sessions.get(userId);
    return s ? structuredClone(s) : undefined;
  }
  async putLineSession(userId: string, s: LineSession) {
    this.sessions.set(userId, structuredClone(s));
  }
  async createBuyerRequest(r: BuyerRequest) {
    this.buyerRequests.push(structuredClone(r));
  }
  async listBuyerRequests(userId: string, limit: number) {
    return this.buyerRequests.filter((r) => r.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((r) => structuredClone(r));
  }
  async listOpenBuyerRequestsByCrop(crop: BuyerRequest['crop'], limit: number) {
    return this.buyerRequests
      .filter((r) => r.crop === crop && r.status === 'open')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ id, userId, quantityKg, offerPerKg, location }) => ({ id, userId, quantityKg, offerPerKg, location }));
  }
  async recordBuyerOutcomes(rows: BuyerOutcome[]) {
    this.outcomes.push(...structuredClone(rows));
  }
  async listBuyerOutcomes(buyerId: string, crop: BuyerOutcome['crop'], limit: number) {
    return this.outcomes.filter((o) => o.buyerId === buyerId && o.crop === crop).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit).map((o) => structuredClone(o));
  }
  async createFarmerGroup(g: FarmerGroup) {
    if (this.groups.has(g.code)) return false;
    this.groups.set(g.code, structuredClone(g));
    return true;
  }
  async getFarmerGroup(code: string) {
    const g = this.groups.get(code);
    return g ? structuredClone(g) : undefined;
  }
  async joinFarmerGroup(code: string, userId: string) {
    const g = this.groups.get(code);
    if (!g) return undefined;
    if (!g.members.includes(userId)) g.members.push(userId);
    return structuredClone(g);
  }
  async claimWebhookEvent(eventId: string) {
    if (this.webhookEvents.has(eventId)) return false;
    this.webhookEvents.add(eventId);
    return true;
  }
}
