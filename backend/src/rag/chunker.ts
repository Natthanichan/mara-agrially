// Custom chunking: ตัดเอกสารตามหัวข้อ (##) แทนการตัดตามจำนวนตัวอักษร
//
// ทำไม: หัวข้อหนึ่งมักเป็น "หนึ่งความคิด" ครบในตัว เช่น "โรงสีจำลอง C" ทั้งย่อหน้า
// ถ้าตัดทุก 500 ตัวอักษร อาจได้ครึ่งแรกพูดถึงโรงสี C แต่ครึ่งหลัง (เรื่องค่าหักแฝง) ไปอยู่อีกชิ้น
// และค้นเจอแค่ชิ้นเดียว → Agent ได้ข้อมูลไม่ครบ

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ChunkMeta {
  /** ประเภทเอกสาร เช่น rule, buyer_history, playbook, market_note */
  docType?: string;
  crop?: string;
  buyer?: string;
  /** ข้อความเตือน เช่น "ข้อมูลจำลอง" — แสดงคู่กับผลค้นหาใน UI */
  disclaimer?: string;
}

export interface Chunk {
  id: string;
  source: string; // ชื่อไฟล์
  docTitle: string;
  heading: string;
  /** ข้อความที่ใช้ค้นและส่งให้ LLM (มีชื่อเอกสาร > หัวข้อ นำหน้าเพื่อให้มีบริบท) */
  text: string;
  meta: ChunkMeta;
}

export interface ChunkOptions {
  /** ความยาวสูงสุดของเนื้อหาต่อชิ้น (ตัวอักษร) */
  maxChars: number;
  /** ส่วนที่ซ้อนกันระหว่างชิ้นที่ถูกแบ่งย่อย เพื่อไม่ให้ประโยคขาดกลางทาง */
  overlapChars: number;
}

const DEFAULTS: ChunkOptions = { maxChars: 700, overlapChars: 120 };

function parseKv(s: string, sep: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(sep)) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** แบ่งเนื้อหายาวเป็นหลายชิ้น ตามย่อหน้าก่อน แล้วค่อยตามช่องว่าง */
function splitLong(body: string, opts: ChunkOptions): string[] {
  if (body.length <= opts.maxChars) return [body];
  const units: string[] = [];
  for (const para of body.split(/\n\s*\n/)) {
    if (para.length <= opts.maxChars) units.push(para);
    else units.push(...para.split(/(?<=\s)/)); // ภาษาไทยเว้นวรรคระหว่างประโยค
  }
  const parts: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && (cur + u).length > opts.maxChars) {
      parts.push(cur.trim());
      // overlap: เอาท้ายชิ้นก่อนมาขึ้นต้นชิ้นถัดไป
      cur = cur.slice(-opts.overlapChars);
    }
    cur += (cur && !/\s$/.test(cur) && !/^\s/.test(u) ? '\n\n' : '') + u;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function chunkMarkdown(source: string, content: string, opts: Partial<ChunkOptions> = {}): Chunk[] {
  const o = { ...DEFAULTS, ...opts };
  let text = content.replace(/\r\n/g, '\n');

  // front matter ระดับเอกสาร
  let docMeta: Record<string, string> = {};
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (fm) {
    docMeta = parseKv(fm[1]!, /\n/);
    text = text.slice(fm[0].length);
  }

  const lines = text.split('\n');
  const h1 = lines.find((l) => /^# /.test(l))?.slice(2).trim();
  const docTitle = docMeta.title ?? h1 ?? source;

  // ข้อความเตือน (blockquote ก่อนหัวข้อแรก) ใช้กับทุกชิ้นในเอกสาร
  const firstH2 = lines.findIndex((l) => /^## /.test(l));
  const preamble = lines.slice(0, firstH2 < 0 ? lines.length : firstH2);
  const disclaimer = preamble.filter((l) => /^>\s?/.test(l)).map((l) => l.replace(/^>\s?/, '')).join(' ').trim() || undefined;

  const chunks: Chunk[] = [];
  if (firstH2 < 0) return chunks;

  const sections: { heading: string; body: string[] }[] = [];
  for (const line of lines.slice(firstH2)) {
    if (/^## /.test(line)) sections.push({ heading: line.slice(3).trim(), body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }

  sections.forEach((sec, si) => {
    let body = sec.body.join('\n');
    // meta ระดับหัวข้อ: <!-- buyer: B-C; crop: rice_hommali -->
    let secMeta: Record<string, string> = {};
    body = body.replace(/<!--([\s\S]*?)-->/g, (_, inner: string) => {
      secMeta = { ...secMeta, ...parseKv(inner, /;/) };
      return '';
    });
    body = body.trim();
    if (!body) return;

    const meta: ChunkMeta = {
      ...(docMeta.doc_type ? { docType: docMeta.doc_type } : {}),
      ...((secMeta.crop ?? docMeta.crop) ? { crop: secMeta.crop ?? docMeta.crop } : {}),
      ...((secMeta.buyer ?? docMeta.buyer) ? { buyer: secMeta.buyer ?? docMeta.buyer } : {}),
      ...(disclaimer ? { disclaimer } : {}),
    };
    const parts = splitLong(body, o);
    parts.forEach((part, pi) => {
      chunks.push({
        id: `${source}#${si + 1}${parts.length > 1 ? `.${pi + 1}` : ''}`,
        source,
        docTitle,
        heading: sec.heading,
        text: `${docTitle} > ${sec.heading}\n${part}`,
        meta,
      });
    });
  });
  return chunks;
}

/** อ่านไฟล์ .md ทั้งโฟลเดอร์ (เรียงตามชื่อ เพื่อให้ผลเหมือนเดิมทุกครั้ง) */
export function loadKnowledgeDir(dir: string, opts?: Partial<ChunkOptions>): Chunk[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .flatMap((f) => chunkMarkdown(f, readFileSync(join(dir, f), 'utf8'), opts));
}
