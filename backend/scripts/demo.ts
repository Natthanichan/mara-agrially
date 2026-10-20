// รันเจรจาให้ดูใน terminal:  npm run agent:demo -- [rice_hommali|bitter_gourd|cassava]
// LLM_PROVIDER=bedrock BEDROCK_MODEL_ID=... AWS_REGION=ap-southeast-1 → ใช้ Nova จริง (มีค่าใช้จ่ายเล็กน้อย)
// NABC_OFFLINE=1 → ใช้ข้อมูลราคาตัวอย่าง 19 ต.ค. แทนการเรียก API จริง
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MockBuyerApi } from '../src/buyer/mockBuyer.js';
import { groupListings } from '../src/core/grouping.js';
import { Ledger } from '../src/core/ledger.js';
import type { Crop } from '../src/core/types.js';
import { farmers, listings } from '../src/data/synthetic.js';
import { MemorySnapshotStore, NabcClient } from '../src/market/nabcClient.js';
import { loadKnowledgeDir } from '../src/rag/chunker.js';
import { KnowledgeIndex } from '../src/rag/search.js';
import { createLlm, runNegotiation } from '../src/agent/index.js';

const crop = (process.argv[2] ?? 'rice_hommali') as Crop;
const offline = process.env.NABC_OFFLINE === '1';
const date = process.env.MARKET_DATE ?? (offline ? '2026-10-19' : new Date().toISOString().slice(0, 10));

const store = new MemorySnapshotStore();
if (offline) {
  const fx = JSON.parse(readFileSync(fileURLToPath(new URL('../test/fixtures/nabc-2026-10-19.json', import.meta.url)), 'utf8'));
  await store.put('2026-10-19', fx.data);
}
const market = new NabcClient({ store, ...(offline ? { fetch: async () => { throw new Error('offline'); } } : {}) });
const knowledge = new KnowledgeIndex(loadKnowledgeDir(fileURLToPath(new URL('../knowledge', import.meta.url))));
const group = groupListings(listings, farmers).find((g) => g.crop === crop);
if (!group) throw new Error(`ไม่มีกลุ่มของ ${crop}`);

const ledger = new Ledger();
const result = await runNegotiation(
  { dealId: `D-${group.id}`, group, farmers, listings, date },
  { buyers: new MockBuyerApi(), market, knowledge },
  createLlm(),
  { ledger },
);

const short = (v: unknown) => { const s = JSON.stringify(v); return s.length > 220 ? s.slice(0, 220) + '…' : s; };
for (const e of result.trace) {
  if (e.type === 'tool_result') continue;
  const d = e.data;
  const line =
    e.type === 'plan' || e.type === 'reasoning' ? `💭 ${d.text}` :
    e.type === 'tool_call' ? `🔧 ${d.tool} ${short(d.input)}` :
    e.type === 'buyer_response' ? `🏪 ${d.buyerName}: ${d.message} [${d.decision}]` :
    e.type === 'counter_sent' ? `📤 ${d.message}` :
    e.type === 'guardrail_blocked' ? `🛑 บล็อก (${d.code}): ${d.reason}` :
    `• ${e.type} ${short(d)}`;
  console.log(line);
}
console.log('\nสถานะ:', result.status, '| ledger ตรวจสอบได้:', ledger.verify().ok);
console.log('Metrics:', result.metrics);
