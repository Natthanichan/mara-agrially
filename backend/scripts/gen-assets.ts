// ฝังเอกสารความรู้ลงในโค้ด เพื่อให้ Lambda มีไฟล์ knowledge โดยไม่ต้องอ่านจากดิสก์
//   npm run build:assets  (รันทุกครั้งที่แก้ไฟล์ใน knowledge/ หรือหน้าเว็บ)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../knowledge/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((file) => ({ file, content: readFileSync(dir + file, 'utf8') }));
writeFileSync(
  fileURLToPath(new URL('../src/generated/knowledge.ts', import.meta.url)),
  `// สร้างอัตโนมัติจาก knowledge/*.md ด้วย npm run build:assets — ห้ามแก้ไฟล์นี้เอง\nexport const KNOWLEDGE_FILES: { file: string; content: string }[] = ${JSON.stringify(files, null, 1)};\n`,
);
console.log(`knowledge: ${files.length} ไฟล์`);
