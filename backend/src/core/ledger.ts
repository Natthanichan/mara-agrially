// บันทึกเหตุการณ์แบบต่อท้ายเท่านั้น (append-only) พร้อม hash chain
// ช่วยให้ตรวจย้อนหลังได้ว่ามีการแก้ไขบันทึกหรือไม่ — ไม่ได้ป้องกันการทุจริตได้ทั้งหมด

import { createHash } from 'node:crypto';

export type LedgerActor = 'farmer' | 'agent' | 'buyer' | 'system';

export interface LedgerEvent {
  seq: number;
  at: string;
  dealId: string;
  actor: LedgerActor;
  actorId?: string;
  type: string; // เช่น offer_received, counter_offer_sent, floor_blocked, approval, status_changed
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

const hashOf = (e: Omit<LedgerEvent, 'hash'>) =>
  createHash('sha256').update(JSON.stringify([e.seq, e.at, e.dealId, e.actor, e.actorId ?? null, e.type, e.data, e.prevHash])).digest('hex');

export class Ledger {
  private events: LedgerEvent[] = [];
  constructor(private now: () => Date = () => new Date()) {}

  append(input: { dealId: string; actor: LedgerActor; actorId?: string; type: string; data?: Record<string, unknown> }): LedgerEvent {
    const prev = this.events[this.events.length - 1];
    const base = {
      seq: this.events.length + 1,
      at: this.now().toISOString(),
      dealId: input.dealId,
      actor: input.actor,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      type: input.type,
      data: structuredClone(input.data ?? {}),
      prevHash: prev?.hash ?? GENESIS,
    };
    const ev = Object.freeze({ ...base, hash: hashOf(base) });
    this.events.push(ev);
    return ev;
  }

  list(dealId?: string): readonly LedgerEvent[] {
    return dealId ? this.events.filter((e) => e.dealId === dealId) : [...this.events];
  }

  /** ตรวจว่า hash chain ต่อเนื่องและไม่ถูกแก้ไข */
  verify(events: readonly LedgerEvent[] = this.events): { ok: boolean; brokenAt?: number } {
    let prev = GENESIS;
    for (const e of events) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || hashOf(rest) !== hash) return { ok: false, brokenAt: e.seq };
      prev = hash;
    }
    return { ok: true };
  }
}
