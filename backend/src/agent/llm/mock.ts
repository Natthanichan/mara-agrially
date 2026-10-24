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
  /** ข้อโต้แย้งล่าสุดของผู้ซื้อ */
  objection?: string;
  /** หลักฐานที่อ้างกับผู้ซื้อรายนี้ไปแล้ว */
  cited: Set<string>;
  buyerId: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** ข้อโต้แย้ง → หลักฐานที่ตอบได้ตรงที่สุด */
const OBJECTION_EVIDENCE: Record<string, string> = {
  need_market_reference: 'market',
  need_volume: 'E-VOL',
  need_quality_grade: 'E-GRADE',
  need_delivery_ready: 'E-DELIVERY',
  need_consolidated_logistics: 'E-LOGISTICS',
  need_competing_offer: 'competing',
  need_buyer_history: 'history',
};

/** ข้อเท็จจริงของกลุ่มที่ใช้ได้ตั้งแต่ต้น (LLM จริงเห็นใน brief) — ข้อความไม่มีตัวเลข */
const BASE_SAY: Record<string, string> = {
  'E-VOL': 'กลุ่มเรารวมผลผลิตส่งเป็นล็อตเดียว',
  'E-GRADE': 'ผลผลิตเกรดเดียวกันทุกราย ยินดีให้ตรวจคุณภาพก่อนรับ',
  'E-DELIVERY': 'ส่งมอบได้ตามช่วงที่ตกลง พร้อมนัดวันชัดเจน',
  'E-LOGISTICS': 'เราจัดรถรวมส่งให้ ผู้ซื้อไม่ต้องรับทีละแปลง',
};

/** ข้อโต้แย้ง → คำอธิบายภาษาไทยสำหรับเหตุผลที่แสดงบนหน้าเว็บ */
const CONCERN_TH: Record<string, string> = {
  need_market_reference: 'ราคาตลาด',
  need_volume: 'ปริมาณ',
  need_quality_grade: 'คุณภาพและเกรด',
  need_delivery_ready: 'การส่งมอบ',
  need_consolidated_logistics: 'การรับสินค้าจากหลายแปลง',
  need_competing_offer: 'ข้อเสนอของรายอื่น',
  need_buyer_history: 'ราคาที่เคยซื้อขายกัน',
};

/** ประโยคเปิดเพื่อตอบข้อโต้แย้ง (ไม่มีตัวเลข) */
const OBJECTION_REPLY: Record<string, string> = {
  need_market_reference: 'เรื่องราคาตลาด ขอให้ข้อมูลอ้างอิงค่ะ',
  need_volume: 'เรื่องปริมาณ กลุ่มเราส่งเป็นล็อตเดียวค่ะ',
  need_quality_grade: 'เรื่องคุณภาพ ขอยืนยันข้อมูลเกรดค่ะ',
  need_delivery_ready: 'เรื่องการส่งมอบ เราพร้อมตามช่วงนี้ค่ะ',
  need_consolidated_logistics: 'เรื่องการรับสินค้า เราจัดรถรวมให้แล้วค่ะ',
  price_above_budget: 'เข้าใจเรื่องงบค่ะ ขอปรับให้ใกล้กันขึ้น',
  unrealistic_ask: 'ขอปรับข้อเสนอให้สมเหตุสมผลขึ้นค่ะ',
  repeated_argument: 'ขอเพิ่มข้อมูลใหม่ค่ะ',
  final_stretch: 'ใกล้กันมากแล้วค่ะ',
};
const fmt = (n: number) => n.toFixed(2);

export class RuleBasedMockLlm implements LlmClient {
  readonly name = 'mock:rule-based';
  private seq = 0;
  private dropped = new Set<string>();
  /** หลักฐานที่มีตอนนี้ id → label (อ่านจากผล tool เหมือน LLM จริง) */
  private evidence = new Map<string, string>();
  private searchedDeduction = new Set<string>();

  /** useEvidence=false: เจรจาด้วยตัวเลขอย่างเดียว ไม่อ้างหลักฐาน (ใช้เป็น baseline ใน eval) */
  constructor(private maxRoundsPerBuyer = 5, private opts: { useEvidence?: boolean } = {}) {}

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
      return [
        { text: 'ได้ใบเสนอราคาแล้ว คำนวณราคาสุทธิและดูประวัติผู้ซื้อก่อนตัดสินใจ' },
        ...sessions.map((s) => this.use('evaluate_offer', { session_id: s.id })),
        ...sessions.map((s) => this.use('get_negotiation_history', { buyer_id: s.buyerId })),
      ];
    }

    // 4) เจรจา
    this.evidence = this.collectEvidence(calls);
    return this.negotiate(sessions, median, cropLine, kg);
  }

  private collectEvidence(calls: Call[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const c of calls) {
      const listed = [...((c.result?.evidence ?? []) as unknown[]), ...((c.result?.leverage ?? []) as unknown[])] as { id: string; label: string; say?: string; note?: string }[];
      for (const e of listed) if (!e.note) m.set(e.id, e.say ?? e.id); // ไม่อ้างข้อมูลจำลองเป็นข้อเท็จจริง
    }
    // ข้อเท็จจริงของกลุ่มที่อยู่ใน brief ตั้งแต่ต้น
    for (const [id, say] of Object.entries(BASE_SAY)) if (!m.has(id)) m.set(id, say);
    return m;
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
          cited: new Set(),
          buyerId: String(r.session_id).split('-').slice(2, 4).join('-'),
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
        s.objection = (r.objection as { code?: string } | undefined)?.code;
        for (const id of (c.input.evidence_ids as string[] | undefined) ?? []) s.cited.add(id);
      }
      if (c.name === 'submit_counter') s.lastAttempt = Number(c.input.price_per_kg);
      if (c.name === 'submit_counter' && r.blocked) {
        // ถูกบล็อก (เช่น ต่ำกว่า floor) → จำราคาที่พยายามไว้ จะขยับขึ้นรอบหน้า
        if (r.code === 'private_data_leak' || r.code === 'unverified_number') s.leakBlocked = true; // ราคาเดิมใช้ได้ แค่ข้อความผิด
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

    const bestRival = (s: SessionView) => Math.max(0, ...sessions.filter((o) => o.id !== s.id && o.decision !== 'walk_away').map((o) => o.price));
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

      // ราคา: เปิดสูงกว่าเป้าแบบสัดส่วน (ไม่ใช่บาทตายตัว — พืชราคาถูกจะเกินจริง) แล้วค่อยลดช่องว่างลง
      const prevAsk = s.asks[s.asks.length - 1];
      let ask =
        s.leakBlocked && s.lastAttempt !== undefined
          ? s.lastAttempt
          : prevAsk === undefined
          ? Math.max(minPass * 1.02, (median ?? s.price) * 1.05, s.price * 1.03, bestRival(s) * 1.02) // ไม่เปิดต่ำกว่าข้อเสนอจริงที่ดีที่สุดของรายอื่น
          : s.objection === 'unrealistic_ask'
          ? Math.max(minPass, s.price + (prevAsk - s.price) * 0.4)
          : this.concedesProportionally(s)
          ? Math.max(minPass, s.price + 0.05, prevAsk - (prevAsk - s.price) * 0.1) // ผู้ซื้อขยับตามสัดส่วนช่องว่าง → ยืนราคาไว้ใกล้เดิม ได้มากกว่า
          : Math.max(minPass, s.price + 0.05, s.price + (prevAsk - s.price) * 0.7);
      ask = r2(Math.ceil(ask * 100 - 1e-6) / 100);

      const move = this.useEvidence ? this.pickMove(s, sessions, median, contest, prevAsk === undefined) : { strategy: contest ? 'contest_deduction' : prevAsk === undefined ? 'anchor' : 'final_push', ids: [] as string[], why: 'เจรจาด้วยตัวเลขอย่างเดียว (baseline)' };
      const said = move.ids.map((id) => this.evidence.get(id)).filter((l): l is string => !!l && !/^E-/.test(l));
      const parts = [
        move.strategy === 'address_objection' || move.strategy === 'conditional_concession' ? OBJECTION_REPLY[s.objection ?? ''] ?? '' : '',
        ...said,
        `ขอเสนอ ${fmt(ask)} บาท/กก.`,
        contest ? 'และขอให้วัดความชื้นจริงต่อหน้าตัวแทนกลุ่มแทนการหักเหมา' : '',
      ].filter(Boolean);
      actions.push(
        this.use('submit_counter', {
          session_id: s.id,
          strategy: move.strategy,
          rationale: move.why,
          evidence_ids: move.ids,
          price_per_kg: ask,
          ...(contest ? { contest_deductions: ['หักความชื้น'] } : {}),
          message: s.leakBlocked ? `ขอเสนอ ${fmt(ask)} บาท/กก.` : parts.join(' '),
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

  /** ผู้ซื้อขยับเป็นสัดส่วนของช่องว่างราคา (≥40%) หรือไม่ — ถ้าใช่ การลดราคาที่ขอเร็วเกินไปจะเสียประโยชน์ */
  private concedesProportionally(s: SessionView): boolean {
    const n = s.prices.length;
    const ask = s.asks[s.asks.length - 1];
    if (n < 2 || ask === undefined || s.decision === 'final_offer') return false;
    const before = s.prices[n - 2]!;
    const gap = ask - before;
    return gap > 0 && (s.prices[n - 1]! - before) / gap >= 0.4;
  }

  private get useEvidence() {
    return this.opts.useEvidence !== false;
  }

  /** เลือกกลยุทธ์และหลักฐานให้ตรงข้อโต้แย้งล่าสุดของผู้ซื้อ และไม่ใช้หลักฐานซ้ำ */
  private pickMove(s: SessionView, all: SessionView[], median: number | undefined, contest: boolean, opening: boolean): { strategy: string; ids: string[]; why: string } {
    const has = (id: string) => this.evidence.has(id) && !s.cited.has(id);
    const marketStrong = median !== undefined && median > s.price && this.evidence.has('E-MKT-MEDIAN');
    const better = all.find((o) => o.id !== s.id && o.evaluation && s.evaluation && o.evaluation.netPerKgAvg > s.evaluation.netPerKgAvg && this.evidence.has(`E-COMP-${o.buyerId}`));
    const hist = this.evidence.has(`E-HIST-${s.buyerId}`) ? `E-HIST-${s.buyerId}` : undefined;

    if (contest) return { strategy: 'contest_deduction', ids: ['E-GRADE'].filter(has), why: 'ส่วนหักแบบเหมาทำให้ราคาสุทธิต่ำกว่าราคาหน้ามาก ต่อรองส่วนหักก่อนขึ้นราคา' };
    if (opening) {
      if (better) return { strategy: 'competitive_leverage', ids: [`E-COMP-${better.buyerId}`, 'E-VOL'].filter(has), why: 'มีข้อเสนอจริงจากรายอื่นที่ราคาสุทธิดีกว่า ใช้เป็นแรงต่อรองพร้อมปริมาณรวม' };
      return { strategy: 'anchor', ids: [...(marketStrong ? ['E-MKT-MEDIAN'] : []), 'E-VOL'].filter(has), why: marketStrong ? 'ราคาตลาดสูงกว่าที่ผู้ซื้อเสนอ เปิดราคาสูงกว่าเป้าโดยอ้างราคาตลาดและปริมาณรวม' : 'ราคาตลาดไม่ได้สูงกว่าข้อเสนอ จึงเปิดราคาโดยอ้างปริมาณรวมแทน' };
    }
    const want = OBJECTION_EVIDENCE[s.objection ?? ''];
    const target = want === 'market' ? (marketStrong ? 'E-MKT-MEDIAN' : undefined) : want === 'competing' ? (better ? `E-COMP-${better.buyerId}` : undefined) : want === 'history' ? hist : want;
    if (target && has(target)) return { strategy: 'address_objection', ids: [target], why: `ผู้ซื้อกังวลเรื่อง${CONCERN_TH[s.objection ?? ''] ?? 'ราคา'} ตอบด้วยหลักฐานที่ตรงข้อกังวลโดยตรง` };
    const fresh = [...(marketStrong ? ['E-MKT-MEDIAN'] : []), 'E-VOL', 'E-GRADE', 'E-DELIVERY', 'E-LOGISTICS', ...(hist ? [hist] : []), ...(better ? [`E-COMP-${better.buyerId}`] : [])].find(has);
    if (fresh) return { strategy: 'evidence_value', ids: [fresh], why: 'ข้อโต้แย้งนี้ไม่มีหลักฐานตรง ใช้หลักฐานใหม่ที่ยังไม่ได้อ้าง แทนการพูดเหตุผลเดิม' };
    return { strategy: s.objection === 'price_above_budget' ? 'conditional_concession' : 'final_push', ids: [], why: 'ใช้หลักฐานครบแล้ว ลดช่องว่างราคาลงเพื่อปิดดีลก่อนหมดรอบ' };
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
