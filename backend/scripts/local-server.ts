// รันระบบทั้งหมดในเครื่อง (ไม่ใช้ AWS): ที่เก็บข้อมูลใน memory + LLM จำลอง + ราคา NABC ตัวอย่าง
//   npm run dev  → เปิด http://localhost:3000
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { MockBuyerApi } from '../src/buyer/mockBuyer.js';
import { createLlm } from '../src/agent/index.js';
import { runDeal, type AppContext } from '../src/app/service.js';
import { handleHttp } from '../src/aws/http.js';
import { KNOWLEDGE_FILES } from '../src/generated/knowledge.js';
import { MemorySnapshotStore, NabcClient } from '../src/market/nabcClient.js';
import { chunkFiles } from '../src/rag/chunker.js';
import { KnowledgeIndex } from '../src/rag/search.js';
import { MemoryDealStore } from '../src/store/memory.js';

const snapshots = new MemorySnapshotStore();
const fx = JSON.parse(readFileSync(fileURLToPath(new URL('../test/fixtures/nabc-2026-10-19.json', import.meta.url)), 'utf8'));
await snapshots.put('2026-10-19', fx.data);
const knowledge = new KnowledgeIndex(chunkFiles(KNOWLEDGE_FILES));
const ctx: AppContext = {
  store: new MemoryDealStore(),
  llm: () => createLlm(),
  agentDeps: () => ({ buyers: new MockBuyerApi(), knowledge, market: new NabcClient({ store: snapshots, timeoutMs: 3000 }) }),
  invokeWorker: async (id) => { setTimeout(() => runDeal(ctx, id).catch((e) => console.error(e)), 50); },
};
const port = Number(process.env.PORT ?? 3000);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = new URL(req.url ?? '/', 'http://x');
  const r = await handleHttp(ctx, { rawPath: url.pathname, requestContext: { http: { method: req.method } }, body: Buffer.concat(chunks).toString('utf8') || undefined, isBase64Encoded: false } as unknown as APIGatewayProxyEventV2);
  res.writeHead(r.statusCode ?? 200, r.headers as Record<string, string>);
  res.end(r.body);
}).listen(port, () => console.log(`http://localhost:${port}`));
