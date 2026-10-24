// ประกอบ dependency จริงบน AWS จาก environment variables (ตั้งใน template.yaml)
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { MockBuyerApi } from '../buyer/mockBuyer.js';
import { createLlm } from '../agent/index.js';
import { BedrockLlm } from '../agent/llm/bedrock.js';
import type { AppContext } from '../app/service.js';
import { KNOWLEDGE_FILES } from '../generated/knowledge.js';
import { NabcClient } from '../market/nabcClient.js';
import { LineBot } from '../line/bot.js';
import { secretsLoader } from '../line/secrets.js';
import { chunkFiles } from '../rag/chunker.js';
import { KnowledgeIndex } from '../rag/search.js';
import { docClient, DynamoDealStore, DynamoSnapshotStore } from '../store/dynamo.js';

const env = process.env;
const table = env.TABLE_NAME ?? '';
const db = docClient(env.AWS_REGION);
const lambda = new LambdaClient({ region: env.AWS_REGION });
// สร้างครั้งเดียวต่อ container (cold start) แล้วใช้ซ้ำ
const knowledge = new KnowledgeIndex(chunkFiles(KNOWLEDGE_FILES));
const snapshots = new DynamoSnapshotStore(db, table);
// แชต LINE ใช้ Nova ตัวเดียวกับ Agent (อุณหภูมิสูงขึ้นเล็กน้อยให้คุยเป็นธรรมชาติ) — ถ้าตั้ง LLM_PROVIDER=mock จะไม่มีแชต AI
const chat = env.LLM_PROVIDER === 'bedrock' && env.BEDROCK_MODEL_ID ? new BedrockLlm({ modelId: env.BEDROCK_MODEL_ID, temperature: 0.4 }) : undefined;

export const ctx: AppContext = {
  // อ่าน secret จาก SSM ตอนมีคำขอแรกเท่านั้น (ถ้ายังไม่ตั้งค่า ส่วนอื่นของระบบยังทำงานได้)
  line: new LineBot(() => ctx, secretsLoader(env)),
  store: new DynamoDealStore(db, table),
  dailyLimit: Number(env.DAILY_NEGOTIATION_LIMIT ?? 60),
  chatLlm: () => chat,
  chatDailyLimit: Number(env.CHAT_DAILY_LIMIT ?? 300),
  llm: () => createLlm(env, Number(env.AGENT_MAX_ROUNDS ?? 5)),
  agentDeps: () => ({
    buyers: new MockBuyerApi(),
    knowledge,
    market: new NabcClient({ store: snapshots, timeoutMs: Number(env.NABC_TIMEOUT_MS ?? 5000), ...(env.NABC_BASE_URL ? { baseUrl: env.NABC_BASE_URL } : {}) }),
  }),
  invokeWorker: async (dealId) => {
    await lambda.send(new InvokeCommand({ FunctionName: env.WORKER_FUNCTION_NAME, InvocationType: 'Event', Payload: new TextEncoder().encode(JSON.stringify({ dealId })) }));
  },
};
