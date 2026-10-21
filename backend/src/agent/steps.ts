// แปลง trace ดิบของ Agent เป็น "ขั้น" ที่หน้าเว็บแสดงได้ทันที
// ใช้ทั้งตอน export หน้าเดโม และตอน API ส่งความคืบหน้าแบบสด

import type { TraceEvent } from './loop.js';

export type Step = Record<string, unknown> & { kind: string; at: string };

export function toSteps(trace: readonly Pick<TraceEvent, 'type' | 'data' | 'at'>[]): Step[] {
  const steps: Step[] = [];
  const buyerBySession = new Map<string, string>();
  let lastCall: { tool: string; input: Record<string, unknown> } | undefined;
  for (const e of trace) {
    const d = e.data as Record<string, any>;
    const at = e.at;
    switch (e.type) {
      case 'plan':
      case 'reasoning':
        steps.push({ kind: e.type, at, text: d.text });
        break;
      case 'tool_call':
        lastCall = { tool: d.tool, input: d.input };
        break;
      case 'buyer_response':
        buyerBySession.set(d.sessionId, d.buyerName);
        steps.push({ kind: 'buyer', at, buyer: d.buyerName, buyerId: d.buyerId, decision: d.decision, price: d.pricePerKg, deductions: d.deductions, message: d.message, round: d.round });
        break;
      case 'counter_sent':
        steps.push({ kind: 'counter', at, buyerId: d.buyerId, price: d.pricePerKg, contest: d.contestDeductions, message: d.message });
        break;
      case 'guardrail_blocked':
        steps.push({ kind: 'blocked', at, buyerId: d.buyerId, code: d.code, reason: d.reason, attemptedPrice: d.attemptedPricePerKg ?? d.pricePerKg });
        break;
      case 'tool_result': {
        const r = d.result as Record<string, any>;
        if (!r || d.ok === false) {
          if (r?.error) steps.push({ kind: 'tool_error', at, tool: d.tool, error: r.error });
          break;
        }
        if (d.tool === 'get_market_price') steps.push({ kind: 'market', at, ...r });
        if (d.tool === 'search_knowledge')
          steps.push({
            kind: 'rag',
            at,
            query: lastCall?.input.query,
            mode: r.mode,
            hits: (r.results ?? []).map((h: any) => ({ source: h.source, text: String(h.text).split('\n').slice(1).join(' '), disclaimer: h.disclaimer })),
          });
        if (d.tool === 'list_buyers') steps.push({ kind: 'buyers', at, buyers: r.buyers });
        const ev = d.tool === 'evaluate_offer' ? r : d.tool === 'submit_counter' ? r.evaluation : undefined;
        if (ev?.sessionId)
          steps.push({ kind: 'evaluation', at, buyer: buyerBySession.get(ev.sessionId), buyerId: ev.buyerId, price: ev.pricePerKg, deductions: ev.deductions, netAvg: ev.netPerKgAvg, netMin: ev.netPerKgMin, passes: ev.passesAllFloors, below: ev.membersBelowFloor, total: ev.totalNetBaht });
        break;
      }
      case 'outcome':
        steps.push({ ...d, outcomeKind: d.kind, kind: 'outcome', at });
        break;
      case 'llm_error':
        steps.push({ kind: 'llm_error', at, error: d.error });
        break;
    }
  }
  return steps;
}
