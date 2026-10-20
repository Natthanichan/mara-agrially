// LLM จำลองแบบกฎตายตัว (rule-based) — ไม่ได้ฉลาดเท่า Nova แต่:
//  1) ใช้เทส Agent loop ได้โดยไม่ต้องเรียก AWS และได้ผลเหมือนเดิมทุกครั้ง
//  2) เป็นแผนสำรองตอนเดโม ถ้า Bedrock ใช้ไม่ได้ (ตั้ง LLM_PROVIDER=mock)
// มันอ่านผลของ tool จากประวัติข้อความ เหมือนที่ LLM จริงอ่าน แล้วตัดสินใจขั้นต่อไป

import type { OfferEvaluation } from '../tools.js';
import { isToolResult, isToolUse, type ContentBlock, type LlmClient, type LlmRequest, type LlmResponse } from './types.js';

interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
}

interface SessionView {
  id: string;
  buyer: string;
  decision: string;
  price: number;
  deductions: string[];
  prices: number[];
  asks: number[];
  rounds: number;
  contested: boolean;
  /** ข้อความล่าสุดถูกบล็อกเพราะมีตัวเลขต้องห้าม → รอบหน้าเขียนใหม่โดยไม่ใส่ตัวเลข */
  leakBlocked: boolean;
  evaluation?: OfferEvaluation;
  roundsLeft: number;
  lastAttempt?: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toFixed(2);

export class RuleBasedMockLlm implements LlmClient {
  readonly name = 'mock:rule-based';
  private seq = 0;
  private dropped = new Set<string>();
  private searchedDeduction = new Set<string>();

  constructor(private maxRoundsPerBuyer = 5) {}

  async converse(req: LlmRequest): Promise<LlmResponse> {
    const calls = this.collectCalls(req);
    return { content: this.decide(calls, req), usage: { inputTokens: 0, outputTokens: 0 } };
  }

  private collectCalls(req: LlmRequest): Call[] {
    const calls: Call[] = [];
    const byId = new Map<string, Call>();
    for (const msg of req.messages) {
      for (const b of msg.content) {
        if (isToolUse(b)) {
          const c = { id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input };
          calls.push(c);
          byId.set(c.id, c);
        } else if (isToolResult(b)) {
          const c = byId.get(b.toolResult.toolUseId);
          if (c) c.result = (b.toolResult.content[0]?.json ?? {}) as Record<string, unknown>;
        }
      }
    }
    return calls;
  }

  private use(name: string, input: Record<string, unknown>): ContentBlock {
    return { toolUse: { toolUseId: `mock-${++this.seq}`, name, input } };
  }

  private decide(calls: Call[], req: LlmRequest): ContentBlock[] {
    const has = (n: string) => calls.some((c) => c.name === n);
    const brief = req.messages[0]?.content.find((b): b is { text: string } => 'text' in b)?.text ?? '';
    const cropLine = brief.split('\n')[0]?.split(': ')[1] ?? 'ผลผลิต';
    const kg = /ปริมาณรวม ([\d,]+) กก\./.exec(brief)?.[1] ?? '';

    // 1) เก็บข้อมูล
    if (!calls.length) {
      return [
        {
          text: `แผน: (1) ดูราคาตลาดจริงและประวัติผู้ซื้อ (2) ขอราคาผู้ซื้อทุกรายแล้วเทียบด้วยราคาสุทธิ (3) เจรจาโดยอ้างราคาตลาดและปริมาณรวม ${kg} กก. ต่อรองส่วนหักแฝงก่อนราคา (4) เตรียมข้อเสนอที่ดีที่สุดให้เกษตรกรอนุมัติ`,
        },
        this.use('get_market_price', {}),
        this.use('search_knowledge', { query: `ประวัติผู้ซื้อ ${cropLine} การจ่ายเงิน ค่าหัก` }),
        this.use('list_buyers', {}),
      ];
    }
    const market = calls.find((c) => c.name === 'get_market_price')?.result as { available?: boolean; medianPerKg?: number; source?: string } | undefined;
    const median = market?.available ? market.medianPerKg : undefined;

    // 2) ขอราคาจากทุกราย
    if (!has('request_quote')) {
      const buyers = ((calls.find((c) => c.name === 'list_buyers')?.result?.buyers ?? []) as { id: string; name: string }[]);
      if (!buyers.length) return [this.use('escalate_to_farmers', { reason: 'ไม่มีผู้ซื้อที่รับพืช เกรด และปริมาณของกลุ่มนี้' })];
      return [
        { text: `พบผู้ซื้อ ${buyers.length} ราย (${buyers.map((b) => b.name).join(', ')}) ขอใบเสนอราคาทุกรายเพื่อเทียบกัน${median ? ` ราคากลางตลาดวันนี้ ${fmt(median)} บาท/กก.` : ''}` },
        ...buyers.map((b) => this.use('request_quote', { buyer_id: b.id })),
      ];
    }

    const sessions = this.sessions(calls);

    // 3) ประเมินราคาสุทธิของใบเสนอราคาแรก
    if (!has('evaluate_offer')) {
      return [{ text: 'ได้ใบเสนอราคาแล้ว คำนวณราคาสุทธิหลังค่าขนส่งและส่วนหักก่อนตัดสินใจ' }, ...sessions.map((s) => this.use('evaluate_offer', { session_id: s.id }))];
    }

    // 4) เจรจา
    return this.negotiate(sessions, median, cropLine, kg);
  }

  private sessions(calls: Call[]): SessionView[] {
    const map = new Map<string, SessionView>();
    for (const c of calls) {
      const r = c.result ?? {};
      if (c.name === 'request_quote' && typeof r.session_id === 'string') {
        map.set(r.session_id, {
          id: r.session_id,
          buyer: String(r.buyer ?? r.session_id),
          decision: String(r.decision),
          price: Number(r.pricePerKg),
          deductions: (r.deductions as string[]) ?? [],
          prices: [Number(r.pricePerKg)],
          asks: [],
          rounds: 0,
          contested: false,
          leakBlocked: false,
          roundsLeft: this.maxRoundsPerBuyer,
        });
      }
      const s = map.get(String(c.input.session_id ?? ''));
      if (!s) continue;
      if (c.name === 'evaluate_offer' && r.sessionId) s.evaluation = r as unknown as OfferEvaluation;
      if (c.name === 'submit_counter' && !r.blocked && !r.error && r.decision) {
        s.asks.push(Number(c.input.price_per_kg));
        s.leakBlocked = false;
        if (Array.isArray(c.input.contest_deductions) && c.input.contest_deductions.length) s.contested = true;
        s.decision = String(r.decision);
        s.price = Number(r.pricePerKg);
        s.prices.push(s.price);
        s.deductions = (r.deductions as string[]) ?? [];
        s.rounds = Number(r.roundsUsed ?? s.rounds + 1);
        s.roundsLeft = Number(r.roundsLeft ?? 0);
        s.evaluation = r.evaluation as OfferEvaluation;
      }
      if (c.name === 'submit_counter') s.lastAttempt = Number(c.input.price_per_kg);
      if (c.name === 'submit_counter' && r.blocked) {
        // ถูกบล็อก (เช่น ต่ำกว่า floor) → จำราคาที่พยายามไว้ จะขยับขึ้นรอบหน้า
        if (r.code === 'private_data_leak') s.leakBlocked = true; // ราคาเดิมใช้ได้ แค่ข้อความผิด
        else s.asks.push(Math.max(Number(c.input.price_per_kg), s.evaluation?.minGrossPriceToPassAll ?? 0));
      }
    }
    return [...map.values()];
  }

  private negotiate(sessions: SessionView[], median: number | undefined, crop: string, kg: string): ContentBlock[] {
    const isDone = (s: SessionView) =>
      this.dropped.has(s.id) || ['accept', 'final_offer', 'walk_away'].includes(s.decision) || s.roundsLeft <= 0;
    const passing = sessions
      .filter((s) => s.decision !== 'walk_away' && s.evaluation?.passesAllFloors)
      .sort((a, b) => b.evaluation!.netPerKgAvg - a.evaluation!.netPerKgAvg);

    const notes: string[] = [];
    const actions: ContentBlock[] = [];

    const accepted = passing.find((s) => s.decision === 'accept');
    const allDone = sessions.every(isDone);
    if (accepted || allDone) {
      const best = passing[0];
      if (!best) {
        return [
          { text: 'ไม่มีข้อเสนอใดที่ทำให้สมาชิกทุกคนได้ไม่ต่ำกว่าขั้นต่ำ ส่งเรื่องให้กลุ่มตัดสินใจ' },
          this.use('escalate_to_farmers', { reason: 'ผู้ซื้อทุกรายให้ราคาสุทธิต่ำกว่าขั้นต่ำของสมาชิกบางคน' }),
        ];
      }
      return [{ text: `สรุป: ${best.buyer} ให้ราคาสุทธิดีที่สุดและผ่านขั้นต่ำทุกคน เตรียมให้เกษตรกรอนุมัติ` }, this.use('prepare_deal_for_approval', { session_id: best.id, summary_for_farmers: this.summary(best, sessions, median) })];
    }

    // อ้างว่า "รายอื่นดีกว่า" ได้เฉพาะเมื่อจริง (ราคาสุทธิของรายอื่นสูงกว่าจริง ๆ) — ห้ามหลอกผู้ซื้อ
    const bestOther = (s: SessionView) =>
      passing.find((p) => p.id !== s.id && p.evaluation!.netPerKgAvg > (s.evaluation?.netPerKgAvg ?? Infinity));

    for (const s of sessions) {
      if (isDone(s) || !s.evaluation) continue;
      const minPass = s.evaluation.minGrossPriceToPassAll;

      // อ่านนิสัยผู้ซื้อ: ขยับครั้งละเท่าไร จะถึงเป้าทันรอบที่เหลือไหม
      if (s.prices.length >= 2 && s.price < minPass) {
        const step = r2(s.prices[s.prices.length - 1]! - s.prices[s.prices.length - 2]!);
        const need = step > 0 ? Math.ceil(r2(minPass - s.price) / step) : Infinity;
        if (need > s.roundsLeft) {
          this.dropped.add(s.id);
          notes.push(`${s.buyer} ขยับครั้งละ ${fmt(step)} บาท ต้องอีกอย่างน้อย ${Number.isFinite(need) ? need : 'หลาย'} รอบจึงจะผ่านขั้นต่ำทุกคน แต่เหลือ ${s.roundsLeft} รอบ → หยุดเจรจากับรายนี้`);
          continue;
        }
      }

      const hasMoisture = s.deductions.some((d) => d.includes('หักความชื้น'));
      const contest = hasMoisture && !s.contested;
      if (contest && !this.searchedDeduction.has(s.id)) {
        this.searchedDeduction.add(s.id);
        notes.push(`${s.buyer} ราคาหน้า ${fmt(s.price)} แต่มี "${s.deductions.join(', ')}" ราคาสุทธิเฉลี่ยเหลือ ${fmt(s.evaluation.netPerKgAvg)} → ค้นกติกาแล้วต่อรองลดส่วนหักก่อน`);
        actions.push(this.use('search_knowledge', { query: 'สัญญาณค่าหักแฝง หักความชื้นเหมา วิธีต่อรอง' }));
      }

      const prevAsk = s.asks[s.asks.length - 1];
      let ask =
        s.leakBlocked && s.lastAttempt !== undefined
          ? s.lastAttempt
          : prevAsk === undefined
          ? Math.max(minPass + 0.3, (median ?? s.price) + 0.9, s.price + 0.3)
          : Math.max(minPass, s.price + 0.05, s.price + (prevAsk - s.price) * 0.7);
      ask = r2(Math.ceil(ask * 100 - 1e-6) / 100);

      const other = bestOther(s);
      const parts = [
        s.leakBlocked ? `กลุ่มเรามี${crop} ปริมาณมาก ส่งมอบพร้อมกัน` : `กลุ่มเรามี${crop} รวม ${kg} กก. ส่งมอบพร้อมกัน`,
        median && !s.leakBlocked ? `ราคากลางตลาดวันนี้ ${fmt(median)} บาท/กก. (NABC)` : '',
        other ? 'ตอนนี้มีข้อเสนอจากผู้ซื้อรายอื่นที่ให้ราคาสุทธิดีกว่า' : '',
        `ขอเสนอ ${fmt(ask)} บาท/กก.`,
        contest ? 'และขอให้วัดความชื้นจริงต่อหน้าตัวแทนกลุ่มแทนการหักเหมา' : '',
      ].filter(Boolean);
      actions.push(
        this.use('submit_counter', {
          session_id: s.id,
          price_per_kg: ask,
          ...(contest ? { contest_deductions: ['หักความชื้น'] } : {}),
          message: parts.join(' '),
        }),
      );
      notes.push(`${s.buyer}: ตอนนี้ ${fmt(s.price)} → เสนอ ${fmt(ask)}${contest ? ' + ขอลดหักความชื้น' : ''}`);
    }

    if (!actions.some((a) => isToolUse(a) && a.toolUse.name === 'submit_counter')) {
      if (sessions.every(isDone)) {
        // ทุกรายหยุดแล้วในรอบนี้ → สรุปผล
        const [first, ...rest] = this.negotiate(sessions, median, crop, kg);
        const text = [notes.join('\n'), first && 'text' in first ? first.text : ''].filter(Boolean).join('\n');
        return [{ text }, ...(first && 'text' in first ? rest : [first!, ...rest])];
      }
      // ยังมีรายที่ไม่มีผลประเมิน → ประเมินก่อน
      return [{ text: notes.join('\n') || 'ประเมินข้อเสนอที่เหลือ' }, ...sessions.filter((s) => !isDone(s)).map((s) => this.use('evaluate_offer', { session_id: s.id }))];
    }
    return [{ text: `ประเมินใหม่:\n${notes.join('\n')}` }, ...actions];
  }

  private summary(best: SessionView, all: SessionView[], median?: number): string {
    const e = best.evaluation!;
    const others = all
      .filter((s) => s.id !== best.id && s.evaluation)
      .map((s) => `${s.buyer} สุทธิเฉลี่ย ${fmt(s.evaluation!.netPerKgAvg)}${s.evaluation!.passesAllFloors ? '' : ' (ต่ำกว่าขั้นต่ำบางคน)'}`);
    return [
      `แนะนำ ${best.buyer}: ราคา ${fmt(e.pricePerKg)} บาท/กก.${e.deductions.length ? ` (${e.deductions.join(', ')})` : ''}`,
      `ราคาสุทธิหลังค่าขนส่งและส่วนหัก เฉลี่ย ${fmt(e.netPerKgAvg)} บาท/กก. ทุกคนได้ไม่ต่ำกว่าขั้นต่ำของตัวเอง`,
      median ? `ราคากลางตลาดวันนี้ ${fmt(median)} บาท/กก. (NABC)` : '',
      others.length ? `เทียบรายอื่น: ${others.join(' · ')}` : '',
      'กรุณาตรวจสอบและกดอนุมัติ ปฏิเสธ หรือขอให้เจรจาใหม่',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
