// สร้างข้อมูลดีลในรูปแบบที่หน้าเว็บใช้ (ทั้งหน้าเดโมแบบบันทึกไว้ และดีลสดจาก API)

import { checkPriceFloor, computeNetPerFarmer } from '../core/pricing.js';
import type { DealStatus } from '../core/stateMachine.js';
import type { DealTerms, Farmer, Group, Listing } from '../core/types.js';
import { CROP_LABEL_TH } from '../data/synthetic.js';
import type { AgentMetrics, AgentOutcome, TraceEvent } from './loop.js';
import { toSteps, type Step } from './steps.js';

export interface DealView {
  id: string;
  title: string;
  note: string;
  llm: string;
  status: DealStatus | 'queued';
  outcome?: string;
  group: { id: string; crop: string; cropLabel: string; grade: string; province: string; window: { from: string; to: string }; totalKg: number; members: number };
  farmers: Record<string, unknown>[];
  deal?: { buyer: string; buyerId: string; price: number; deductions: string[]; netAvg: number; total: number; summary: string; terms: DealTerms };
  reason?: string;
  metrics?: AgentMetrics;
  steps: Step[];
}

export function buildDealView(args: {
  id: string;
  title: string;
  note: string;
  llm: string;
  status: DealView['status'];
  group: Group;
  farmers: Farmer[];
  listings: Listing[];
  trace: readonly Pick<TraceEvent, 'type' | 'data' | 'at'>[];
  outcome?: AgentOutcome;
  metrics?: AgentMetrics;
}): DealView {
  const { group, outcome } = args;
  const terms = outcome?.kind === 'prepared' ? outcome.terms : undefined;
  const nets = terms ? computeNetPerFarmer(group.members, terms) : [];
  const violations = terms ? checkPriceFloor(group.members, args.listings, terms).violations : [];
  const farmers = group.members.map((m) => {
    const f = args.farmers.find((x) => x.id === m.farmerId)!;
    const n = nets.find((x) => x.farmerId === m.farmerId);
    return {
      id: f.id,
      name: f.name,
      district: f.district,
      route: f.routeId,
      kg: m.quantityKg,
      account: f.bankAccountMasked,
      ...(n ? { transportPerKg: n.transportPerKg, otherPerKg: n.otherDeductionsPerKg, netPerKg: n.netPerKg, netTotal: n.netTotal, passesFloor: !violations.some((v) => v.farmerId === f.id) } : {}),
    };
  });
  return {
    id: args.id,
    title: args.title,
    note: args.note,
    llm: args.llm,
    status: args.status,
    ...(outcome ? { outcome: outcome.kind } : {}),
    group: {
      id: group.id,
      crop: group.crop,
      cropLabel: CROP_LABEL_TH[group.crop],
      grade: group.grade,
      province: group.province,
      window: group.deliveryWindow,
      totalKg: group.members.reduce((s, m) => s + m.quantityKg, 0),
      members: group.members.length,
    },
    farmers,
    ...(outcome?.kind === 'prepared'
      ? {
          deal: {
            buyer: outcome.buyerName,
            buyerId: outcome.buyerId,
            price: outcome.terms.pricePerKg,
            deductions: outcome.evaluation.deductions,
            netAvg: outcome.evaluation.netPerKgAvg,
            total: outcome.evaluation.totalNetBaht,
            summary: outcome.summary,
            terms: outcome.terms,
          },
        }
      : {}),
    ...(outcome && outcome.kind !== 'prepared' ? { reason: outcome.reason } : {}),
    ...(args.metrics ? { metrics: args.metrics } : {}),
    steps: toSteps(args.trace),
  };
}
