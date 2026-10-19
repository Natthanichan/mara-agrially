import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chunkMarkdown, loadKnowledgeDir } from '../src/rag/chunker.js';
import { KnowledgeIndex, tokenize, type Embedder } from '../src/rag/search.js';
import { farmers, listings } from '../src/data/synthetic.js';

const KNOWLEDGE_DIR = fileURLToPath(new URL('../knowledge', import.meta.url));
const chunks = loadKnowledgeDir(KNOWLEDGE_DIR);
const index = new KnowledgeIndex(chunks);

describe('custom chunking', () => {
  it('ตัดตามหัวข้อ ## และใส่ชื่อเอกสาร > หัวข้อ นำหน้า', () => {
    const c = chunkMarkdown('x.md', '# เอกสาร\n\n## หัวข้อ 1\nเนื้อหา 1\n\n## หัวข้อ 2\nเนื้อหา 2\n');
    expect(c.map((x) => x.id)).toEqual(['x.md#1', 'x.md#2']);
    expect(c[1]!.text).toBe('เอกสาร > หัวข้อ 2\nเนื้อหา 2');
  });

  it('อ่าน meta ระดับเอกสารและระดับหัวข้อ และข้อความเตือน', () => {
    const c = chunks.find((x) => x.heading === 'โรงสีจำลอง C')!;
    expect(c.meta).toEqual({ docType: 'buyer_history', crop: 'rice_hommali', buyer: 'B-C', disclaimer: expect.stringContaining('จำลอง') });
    expect(c.text).not.toContain('<!--'); // ลบ comment ออกจากเนื้อหา
  });

  it('แบ่งหัวข้อที่ยาวเกินเป็นหลายชิ้น โดยมีส่วนซ้อนกัน', () => {
    const words = Array.from({ length: 120 }, (_, i) => `คำที่${i}`).join(' ');
    const c = chunkMarkdown('long.md', `# ยาว\n## ส่วนเดียว\n${words}`, { maxChars: 200, overlapChars: 40 });
    expect(c.length).toBeGreaterThan(3);
    expect(c.map((x) => x.id).slice(0, 2)).toEqual(['long.md#1.1', 'long.md#1.2']);
    const firstBody = c[0]!.text.split('\n')[1]!;
    const secondBody = c[1]!.text.split('\n')[1]!;
    expect(secondBody.startsWith(firstBody.slice(-40).trimStart().slice(0, 10))).toBe(true);
    for (const x of c) expect(x.text.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(200);
  });

  it('โหลดเอกสารความรู้จริงได้ครบ ทุกชิ้นมี id ไม่ซ้ำ', () => {
    expect(new Set(chunks.map((c) => c.source))).toEqual(
      new Set(['bitter-gourd-market.md', 'buyer-history.md', 'moisture-deduction.md', 'negotiation-playbook.md', 'rice-grading.md']),
    );
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });
});

describe('ค้นหา (lexical BM25 + bigram)', () => {
  it('ตัดภาษาไทยเป็นคู่ตัวอักษร และเก็บคำอังกฤษ/รหัสทั้งคำ', () => {
    expect(tokenize('ความชื้น')).toEqual(['คว', 'วา', 'าม', 'มช', 'ชื', 'ื้', '้น']);
    expect(tokenize('ผู้ซื้อ B-C')).toContain('b-c');
  });

  it('"ค่าหักความชื้น โรงสี C" → เจอประวัติโรงสี C เป็นอันดับแรก', () => {
    const r = index.search('โรงสี C หักความชื้นเหมา', { filter: { docType: 'buyer_history' } });
    expect(r.hits[0]).toMatchObject({ heading: 'โรงสีจำลอง C', source: 'buyer-history.md' });
  });

  it('ค้นกติกาการต่อรองค่าหัก → เจอเอกสารกติกาความชื้น', () => {
    const r = index.search('สัญญาณค่าหักแฝง ความชื้นเหมา');
    expect(r.hits.map((h) => h.heading)).toContain('สัญญาณเตือนค่าหักแฝง');
  });

  it('กรองตามพืช: ค้นเรื่องมะระไม่ได้เอกสารเฉพาะข้าว', () => {
    const r = index.search('ราคา ขนส่ง เกรด', { filter: { crop: 'bitter_gourd' }, topK: 10 });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(chunks.find((c) => c.id === h.chunkId)!.meta.crop ?? 'bitter_gourd').toBe('bitter_gourd');
  });

  it('ผลเหมือนเดิมทุกครั้ง และไม่เจออะไรเมื่อไม่มีคำตรงเลย', () => {
    expect(index.search('ผู้ส่งออก ปริมาณ')).toEqual(index.search('ผู้ส่งออก ปริมาณ'));
    expect(index.search('xyz').hits).toEqual([]);
  });

  it('ส่งข้อความเตือน "ข้อมูลจำลอง" ไปกับผลค้นหา', () => {
    const r = index.search('ตลาดค้าส่งจำลอง D มะระ');
    expect(r.hits[0]!.disclaimer).toMatch(/จำลอง/);
  });
});

describe('hybrid + fallback', () => {
  // embedder ปลอม: vector จากการนับตัวอักษรบางตัว (พอให้เทสกลไกได้ โดยไม่เรียก AWS)
  const fakeEmbedder: Embedder = { embed: async (ts) => ts.map((t) => ['ชื้น', 'มะระ', 'ส่งออก'].map((k) => (t.includes(k) ? 1 : 0))) };

  it('ใช้ hybrid เมื่อ embedding พร้อม', async () => {
    const idx = new KnowledgeIndex(chunks);
    await idx.attachEmbeddings(fakeEmbedder);
    const r = await idx.searchHybrid('ความชื้น', { embedder: fakeEmbedder });
    expect(r.mode).toBe('hybrid');
    expect(r.hits[0]!.text).toContain('ชื้น');
  });

  it('embedding ล่ม → กลับไปใช้ lexical และบอกเหตุผล', async () => {
    const idx = new KnowledgeIndex(chunks);
    await idx.attachEmbeddings(fakeEmbedder);
    const broken: Embedder = { embed: async () => { throw new Error('ThrottlingException'); } };
    const r = await idx.searchHybrid('ความชื้น', { embedder: broken });
    expect(r).toMatchObject({ mode: 'lexical', fallbackReason: expect.stringContaining('ThrottlingException') });
    expect(r.hits).toEqual(idx.search('ความชื้น').hits);
  });

  it('embedding ช้าเกิน timeout → lexical', async () => {
    const idx = new KnowledgeIndex(chunks);
    await idx.attachEmbeddings(fakeEmbedder);
    const slow: Embedder = { embed: () => new Promise(() => {}) };
    const r = await idx.searchHybrid('ความชื้น', { embedder: slow, timeoutMs: 20 });
    expect(r.mode).toBe('lexical');
  });
});

describe('privacy: เอกสารความรู้ไม่มีข้อมูลส่วนตัวของเกษตรกร', () => {
  const all = chunks.map((c) => c.text).join('\n');
  it('ไม่มีชื่อเกษตรกร รหัส หรือเลขบัญชี', () => {
    for (const f of farmers) {
      expect(all).not.toContain(f.name);
      expect(all).not.toContain(f.bankAccountMasked);
      expect(all).not.toMatch(new RegExp(`\\b${f.id}\\b`));
    }
  });
  it('ไม่มี field ราคาขั้นต่ำ', () => {
    expect(all).not.toMatch(/floorPrice/i);
    expect(listings.length).toBeGreaterThan(0);
  });
});
