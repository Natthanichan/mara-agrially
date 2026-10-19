// ค้นหาความรู้สำหรับ Agent
//
// 1) Lexical (BM25 + character bigram) — ทำงานเสมอ ไม่ต้องใช้ AWS ผลเหมือนเดิมทุกครั้ง
//    ภาษาไทยไม่เว้นวรรคระหว่างคำ จึงตัดเป็นคู่ตัวอักษร เช่น "ความชื้น" → คว วา าม มช ชื ื้ ้น
//    ทำให้ "หักความชื้น" กับ "ความชื้นสูง" มีคู่ตัวอักษรร่วมกัน โดยไม่ต้องมีพจนานุกรมตัดคำ
// 2) Hybrid (ถ้ามี embedding model) — รวมคะแนนความหมาย ถ้า embedding ล่ม/ช้า กลับไปใช้ lexical

import type { Chunk } from './chunker.js';

export interface SearchFilter {
  crop?: string;
  buyer?: string;
  docType?: string;
}

export interface SearchHit {
  chunkId: string;
  source: string;
  docTitle: string;
  heading: string;
  text: string;
  score: number;
  disclaimer?: string;
}

export interface SearchResult {
  mode: 'lexical' | 'hybrid';
  hits: SearchHit[];
  /** เหตุผลที่ไม่ได้ใช้ hybrid (ถ้ามี) — แสดงใน log/UI */
  fallbackReason?: string;
}

/** แปลงข้อความเป็น token: ไทย → bigram, อังกฤษ/ตัวเลข → ทั้งคำ */
export function tokenize(text: string): string[] {
  const s = text.normalize('NFC').toLowerCase();
  const out: string[] = [];
  for (const m of s.matchAll(/[฀-๿]+|[a-z0-9]+(?:[.\-_][a-z0-9]+)*/g)) {
    const run = m[0];
    if (/^[฀-๿]/.test(run)) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    } else {
      out.push(run);
    }
  }
  return out;
}

const matchesFilter = (c: Chunk, f?: SearchFilter) =>
  !f ||
  ((!f.crop || !c.meta.crop || c.meta.crop === f.crop) &&
    (!f.buyer || c.meta.buyer === f.buyer) &&
    (!f.docType || c.meta.docType === f.docType));

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export class KnowledgeIndex {
  private docs: { chunk: Chunk; tf: Map<string, number>; len: number }[];
  private df = new Map<string, number>();
  private avgLen: number;
  private vectors?: number[][];

  constructor(chunks: Chunk[], private k1 = 1.2, private b = 0.75) {
    this.docs = chunks.map((chunk) => {
      const toks = tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { chunk, tf, len: toks.length };
    });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }

  get size() {
    return this.docs.length;
  }

  /** ค้นแบบ lexical (BM25) */
  search(query: string, opts: { topK?: number; filter?: SearchFilter } = {}): SearchResult {
    return { mode: 'lexical', hits: this.rank(this.bm25(query), opts) };
  }

  /** สร้าง embedding ให้ทุกชิ้น (เรียกครั้งเดียวตอน build/cold start) */
  async attachEmbeddings(embedder: Embedder): Promise<void> {
    const v = await embedder.embed(this.docs.map((d) => d.chunk.text));
    if (v.length !== this.docs.length) throw new Error('จำนวน embedding ไม่ตรงกับจำนวนชิ้นเอกสาร');
    this.vectors = v;
  }

  /** ค้นแบบ hybrid ถ้ามี embedding — ล่ม/timeout → กลับไปใช้ lexical */
  async searchHybrid(
    query: string,
    opts: { topK?: number; filter?: SearchFilter; embedder?: Embedder; timeoutMs?: number; weight?: number } = {},
  ): Promise<SearchResult> {
    const lexical = this.bm25(query);
    if (!opts.embedder || !this.vectors) {
      return { mode: 'lexical', hits: this.rank(lexical, opts), fallbackReason: 'ยังไม่มี embedding' };
    }
    let qv: number[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('timeout')), opts.timeoutMs ?? 3000);
      });
      [qv] = (await Promise.race([opts.embedder.embed([query]), timeout])) as number[][] as [number[]];
      if (!qv) throw new Error('embedding ว่าง');
    } catch (e) {
      return { mode: 'lexical', hits: this.rank(lexical, opts), fallbackReason: `embedding ใช้ไม่ได้: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
    // ปรับ BM25 ให้อยู่ช่วง 0–1 ก่อนรวมกับ cosine
    const maxBm = Math.max(1e-9, ...lexical);
    const w = opts.weight ?? 0.5;
    const combined = lexical.map((s, i) => w * (s / maxBm) + (1 - w) * Math.max(0, cosine(qv, this.vectors![i]!)));
    return { mode: 'hybrid', hits: this.rank(combined, opts) };
  }

  private bm25(query: string): number[] {
    const qTerms = [...new Set(tokenize(query))];
    const N = this.docs.length;
    return this.docs.map((d) => {
      let score = 0;
      for (const t of qTerms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
      }
      return score;
    });
  }

  private rank(scores: number[], opts: { topK?: number; filter?: SearchFilter }): SearchHit[] {
    return this.docs
      .map((d, i) => ({ d, s: scores[i]! }))
      .filter(({ d, s }) => s > 0 && matchesFilter(d.chunk, opts.filter))
      // คะแนนเท่ากัน → เรียงตาม id เพื่อให้ผลเหมือนเดิมทุกครั้ง
      .sort((a, b) => b.s - a.s || a.d.chunk.id.localeCompare(b.d.chunk.id))
      .slice(0, opts.topK ?? 3)
      .map(({ d, s }) => ({
        chunkId: d.chunk.id,
        source: d.chunk.source,
        docTitle: d.chunk.docTitle,
        heading: d.chunk.heading,
        text: d.chunk.text,
        score: Math.round(s * 1000) / 1000,
        ...(d.chunk.meta.disclaimer ? { disclaimer: d.chunk.meta.disclaimer } : {}),
      }));
  }
}
