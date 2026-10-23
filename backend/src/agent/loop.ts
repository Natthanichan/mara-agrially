// Agent loop: วางแผน → เรียก tool → ดูผล → ประเมินใหม่ → ทำซ้ำ
// มีขีดจำกัดทุกด้าน (จำนวนขั้น, เวลา, retry, token) และหยุดอย่างปลอดภัยเมื่อ LLM ล่ม

import type { Ledger, LedgerActor } from '../core/ledger.js';
import { nextDealStatus, type DealStatus } from '../core/stateMachine.js';
import { isText, isToolUse, type ContentBlock, type LlmClient, type LlmResponse, type Message } from './llm/types.js';
import { SYSTEM_PROMPT, initialBrief } from './prompts.js';
import { NegotiationState, TOOL_SPECS, ToolError, executeTool, type AgentDeps, type NegotiationInput, type OfferEvaluation, type Terminal } from './tools.js';

export interface AgentLimits {
  maxSteps: number;
  llmTimeoutMs: number;
  llmRetries: number;
  maxTokensPerCall: number;
  maxTotalTokens: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 18,
  llmTimeoutMs: 20_000,
  llmRetries: 1,
  maxTokensPerCall: 1200,
  maxTotalTokens: 80_000,
};

export interface TraceEvent {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}

export interface AgentMetrics {
  label: string;
  steps: number;
  llmCalls: number;
  llmModel: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  buyersContacted: number;
  roundsByBuyer: Record<string, number>;
  guardrailBlocks: number;
  elapsedMs: number;
  marketMedianPerKg?: number;
  finalNetPerKgAvg?: number;
  bestOpeningNetPerKgAvg?: number;
  /** ราคาสุทธิเฉลี่ยที่ได้เพิ่มจากข้อเสนอแรกที่ดีที่สุด */
  upliftVsBestOpeningPerKg?: number;
  upliftVsBestOpeningBaht?: number;
}

export type AgentOutcome = Terminal | { kind: 'failed'; reason: string };

export interface AgentResult {
  dealId: string;
  status: DealStatus;
  outcome: AgentOutcome;
  trace: TraceEvent[];
  metrics: AgentMetrics;
}

const ACTOR: Record<string, LedgerActor> = {
  plan: 'agent',
  reasoning: 'agent',
  tool_call: 'agent',
  tool_result: 'system',
  counter_sent: 'agent',
  buyer_response: 'buyer',
  guardrail_blocked: 'system',
  llm_error: 'system',
  outcome: 'system',
  status_changed: 'system',
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function runNegotiation(
  input: NegotiationInput,
  deps: AgentDeps,
  llm: LlmClient,
  opts: {
    ledger?: Ledger;
    limits?: Partial<AgentLimits>;
    now?: () => Date;
    /** เรียกทุกครั้งที่มีเหตุการณ์ใหม่ (เช่น เขียนลงฐานข้อมูลให้หน้าเว็บเห็นแบบสด) — ล้มเหลวได้โดยไม่ทำให้ Agent หยุด */
    onEvent?: (e: TraceEvent) => void | Promise<void>;
  } = {},
): Promise<AgentResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const st = new NegotiationState(input);
  const trace: TraceEvent[] = [];
  const m = { steps: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 };

  const pending: Promise<unknown>[] = [];
  const emit = (type: string, data: Record<string, unknown>) => {
    const ev = { seq: trace.length + 1, at: now().toISOString(), type, data };
    trace.push(ev);
    opts.ledger?.append({ dealId: input.dealId, actor: ACTOR[type] ?? 'system', type: `agent.${type}`, data });
    if (opts.onEvent) {
      try {
        pending.push(Promise.resolve(opts.onEvent(ev)).catch(() => undefined));
      } catch {
        /* การบันทึกล้มเหลวไม่ควรทำให้การเจรจาพัง */
      }
    }
  };

  let status: DealStatus = 'draft';
  const setStatus = (to: DealStatus) => {
    const from = status;
    status = nextDealStatus(status, to);
    emit('status_changed', { from, to });
  };
  setStatus('negotiating');

  const messages: Message[] = [{ role: 'user', content: [{ text: initialBrief(st) }] }];
  let outcome: AgentOutcome | undefined;
  let nudged = false;

  const callLlm = async (): Promise<LlmResponse> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= limits.llmRetries; attempt++) {
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        m.llmCalls += 1;
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            ctrl.abort();
            rej(new Error(`LLM ไม่ตอบภายใน ${limits.llmTimeoutMs} ms`));
          }, limits.llmTimeoutMs);
        });
        const res = await Promise.race([
          llm.converse({ system: SYSTEM_PROMPT, messages, tools: TOOL_SPECS, maxTokens: limits.maxTokensPerCall, signal: ctrl.signal }),
          timeout,
        ]);
        m.inputTokens += res.usage?.inputTokens ?? 0;
        m.outputTokens += res.usage?.outputTokens ?? 0;
        return res;
      } catch (e) {
        lastErr = e;
        emit('llm_error', { attempt: attempt + 1, error: (e as Error).message });
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  };

  while (!outcome) {
    if (m.steps >= limits.maxSteps) {
      outcome = { kind: 'failed', reason: `ครบจำนวนขั้นสูงสุด ${limits.maxSteps} ขั้น โดยยังไม่ได้ข้อสรุป` };
      break;
    }
    if (m.inputTokens + m.outputTokens >= limits.maxTotalTokens) {
      outcome = { kind: 'failed', reason: 'ใช้ token ครบงบที่ตั้งไว้' };
      break;
    }
    m.steps += 1;

    let res: LlmResponse;
    try {
      res = await callLlm();
    } catch (e) {
      outcome = { kind: 'failed', reason: `AI ไม่พร้อมใช้งาน (${(e as Error).message}) — หยุดเจรจาอย่างปลอดภัย ไม่มีดีลใดถูกสร้าง` };
      break;
    }

    const content: ContentBlock[] = res.content.length ? res.content : [{ text: '' }];
    messages.push({ role: 'assistant', content });
    for (const b of content.filter(isText)) {
      if (b.text.trim()) emit(m.steps === 1 ? 'plan' : 'reasoning', { text: b.text.trim() });
    }

    const uses = content.filter(isToolUse);
    if (!uses.length) {
      if (nudged) {
        outcome = { kind: 'failed', reason: 'AI ไม่ได้เลือกการกระทำต่อ' };
        break;
      }
      nudged = true;
      messages.push({ role: 'user', content: [{ text: 'กรุณาเรียก tool เพื่อทำขั้นต่อไป หรือ prepare_deal_for_approval / escalate_to_farmers ถ้าได้ข้อสรุปแล้ว' }] });
      continue;
    }

    const results: ContentBlock[] = [];
    for (const u of uses) {
      const { toolUseId, name, input: toolInput } = u.toolUse;
      m.toolCalls += 1;
      emit('tool_call', { tool: name, input: toolInput });
      let json: unknown;
      let ok = true;
      try {
        json = await executeTool(name, toolInput ?? {}, st, deps, emit);
      } catch (e) {
        ok = false;
        json = { error: e instanceof ToolError ? e.message : 'เกิดข้อผิดพลาดภายใน' };
        if (!(e instanceof ToolError)) emit('tool_result', { tool: name, internalError: (e as Error).message });
      }
      emit('tool_result', { tool: name, ok, result: json });
      results.push({ toolResult: { toolUseId, content: [{ json }], status: ok ? 'success' : 'error' } });
      if (st.terminal) break; // prepare/escalate แล้ว ไม่ทำ tool ที่เหลือในรอบนี้
    }
    // Converse API ต้องการ toolResult ครบทุก toolUse — ที่ข้ามไปให้ตอบว่าไม่ได้ทำ
    for (const u of uses.slice(results.length)) {
      results.push({ toolResult: { toolUseId: u.toolUse.toolUseId, content: [{ json: { skipped: 'งานจบแล้ว' } }], status: 'error' } });
    }
    // บอกโมเดลว่าเหลืออีกกี่ขั้น และเมื่อใกล้หมดให้สรุปเลย (เจอจริงบน Nova: ค้นข้อมูลวนจนหมดขั้นโดยไม่ได้สรุป)
    const left = limits.maxSteps - m.steps;
    if (!st.terminal) {
      results.push({
        text:
          left <= 3
            ? `[ระบบ] เหลืออีก ${left} ขั้น ต้องสรุปตอนนี้: เรียก prepare_deal_for_approval กับข้อเสนอที่ผ่านขั้นต่ำทุกคนและดีที่สุดที่มี หรือ escalate_to_farmers ถ้าไม่มีข้อเสนอที่ผ่าน`
            : `[ระบบ] ใช้ไป ${m.steps}/${limits.maxSteps} ขั้น เหลืออีก ${left} ขั้น`,
      });
    }
    messages.push({ role: 'user', content: results });

    if (st.terminal) outcome = st.terminal;
  }

  setStatus(outcome.kind === 'prepared' ? 'pending_approval' : 'failed');
  emit('outcome', outcome.kind === 'prepared' ? { kind: 'prepared', buyerId: outcome.buyerId, buyerName: outcome.buyerName, summary: outcome.summary, evaluation: outcome.evaluation } : { ...outcome });

  await Promise.all(pending);
  return { dealId: input.dealId, status, outcome, trace, metrics: buildMetrics(st, m, llm.name, Date.now() - started, outcome) };
}

function buildMetrics(
  st: NegotiationState,
  m: { steps: number; llmCalls: number; inputTokens: number; outputTokens: number; toolCalls: number },
  model: string,
  elapsedMs: number,
  outcome: AgentOutcome,
): AgentMetrics {
  const sessions = [...st.sessions.values()];
  const openings: OfferEvaluation[] = sessions.map((s) => st.evaluate(s, { pricePerKg: s.history[0]!.pricePerKg, deductions: s.history[0]!.deductions }));
  const bestOpening = openings.filter((o) => o.passesAllFloors).sort((a, b) => b.netPerKgAvg - a.netPerKgAvg)[0] ?? openings.sort((a, b) => b.netPerKgAvg - a.netPerKgAvg)[0];
  const final = outcome.kind === 'prepared' ? outcome.evaluation : undefined;
  return {
    label: 'ผลทดสอบจากข้อมูลจำลอง (ไม่ใช่ผลลัพธ์จริงในตลาด)',
    ...m,
    llmModel: model,
    buyersContacted: sessions.length,
    roundsByBuyer: Object.fromEntries(sessions.map((s) => [s.buyerId, s.rounds])),
    guardrailBlocks: st.violations.length,
    elapsedMs,
    ...(st.market ? { marketMedianPerKg: st.market.medianPerKg } : {}),
    ...(final ? { finalNetPerKgAvg: final.netPerKgAvg } : {}),
    ...(bestOpening ? { bestOpeningNetPerKgAvg: bestOpening.netPerKgAvg } : {}),
    ...(final && bestOpening
      ? { upliftVsBestOpeningPerKg: r2(final.netPerKgAvg - bestOpening.netPerKgAvg), upliftVsBestOpeningBaht: r2(final.totalNetBaht - bestOpening.totalNetBaht) }
      : {}),
  };
}
