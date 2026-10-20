// รูปแบบข้อความกลางระหว่าง Agent กับ LLM — ออกแบบให้ตรงกับ Bedrock Converse API
// เพื่อให้สลับระหว่าง LLM จริง (Nova) กับ LLM จำลองได้โดยไม่ต้องแก้ loop

export type ContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: [{ json: unknown }]; status: 'success' | 'error' } };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { json: Record<string, unknown> };
}

export interface LlmRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: ContentBlock[];
  stopReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  readonly name: string;
  converse(req: LlmRequest): Promise<LlmResponse>;
}

export const isText = (b: ContentBlock): b is { text: string } => 'text' in b;
export const isToolUse = (b: ContentBlock): b is Extract<ContentBlock, { toolUse: unknown }> => 'toolUse' in b;
export const isToolResult = (b: ContentBlock): b is Extract<ContentBlock, { toolResult: unknown }> => 'toolResult' in b;
