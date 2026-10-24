// LLM จริง: Amazon Nova ผ่าน Bedrock Converse API (รองรับ tool use)
// ตั้งค่าด้วย env: AWS_REGION=ap-southeast-1, BEDROCK_MODEL_ID=<model ID หรือ inference profile จาก console>

import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import type { ContentBlock, LlmClient, LlmRequest, LlmResponse } from './types.js';

export interface BedrockLlmOptions {
  modelId: string;
  region?: string;
  temperature?: number;
  /** ส่ง client เองได้ (ใช้ตอนเทส) */
  client?: Pick<BedrockRuntimeClient, 'send'>;
}

export class BedrockLlm implements LlmClient {
  readonly name: string;
  private client: Pick<BedrockRuntimeClient, 'send'>;

  constructor(private opts: BedrockLlmOptions) {
    if (!opts.modelId) throw new Error('ต้องตั้งค่า BEDROCK_MODEL_ID');
    this.name = `bedrock:${opts.modelId}`;
    // maxAttempts: 1 → ให้ loop ของเราคุม retry เอง จะได้นับและจำกัดได้
    this.client = opts.client ?? new BedrockRuntimeClient({ region: opts.region ?? process.env.AWS_REGION, maxAttempts: 1 });
  }

  async converse(req: LlmRequest): Promise<LlmResponse> {
    const input: ConverseCommandInput = {
      modelId: this.opts.modelId,
      system: [{ text: req.system }],
      messages: req.messages as ConverseCommandInput['messages'],
      // Converse ไม่รับ toolConfig ที่ไม่มี tool — แชตบางโหมดไม่ใช้ tool
      ...(req.tools.length ? { toolConfig: { tools: req.tools.map((t) => ({ toolSpec: t })) as NonNullable<ConverseCommandInput['toolConfig']>['tools'] } } : {}),
      inferenceConfig: { maxTokens: req.maxTokens ?? 1200, temperature: this.opts.temperature ?? 0.2 },
    };
    const out = await this.client.send(new ConverseCommand(input), { abortSignal: req.signal });
    // เก็บเฉพาะ text และ toolUse (ข้าม block ประเภทอื่น เช่น reasoning)
    const content = (out.output?.message?.content ?? []).filter(
      (b) => typeof b === 'object' && b !== null && ('text' in b || 'toolUse' in b),
    ) as unknown as ContentBlock[];
    return {
      content,
      stopReason: out.stopReason,
      usage: { inputTokens: out.usage?.inputTokens ?? 0, outputTokens: out.usage?.outputTokens ?? 0 },
    };
  }
}
