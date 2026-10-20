// จุดเริ่มต้นของ Agent: เลือก LLM จาก env แล้วรันการเจรจา
import { BedrockLlm } from './llm/bedrock.js';
import { RuleBasedMockLlm } from './llm/mock.js';
import type { LlmClient } from './llm/types.js';

export { runNegotiation, DEFAULT_LIMITS, type AgentResult, type TraceEvent, type AgentMetrics } from './loop.js';
export { NegotiationState, TOOL_SPECS, type AgentDeps, type NegotiationInput, type MarketProvider } from './tools.js';

/** LLM_PROVIDER=bedrock → Nova บน Bedrock, อื่น ๆ → LLM จำลอง (ค่าเริ่มต้น ปลอดภัย ไม่มีค่าใช้จ่าย) */
export function createLlm(env: Record<string, string | undefined> = process.env, maxRoundsPerBuyer = 5): LlmClient {
  if (env.LLM_PROVIDER === 'bedrock') {
    return new BedrockLlm({ modelId: env.BEDROCK_MODEL_ID ?? '', region: env.AWS_REGION });
  }
  return new RuleBasedMockLlm(maxRoundsPerBuyer);
}
