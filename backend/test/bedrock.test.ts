import { describe, expect, it } from 'vitest';
import { BedrockLlm } from '../src/agent/llm/bedrock.js';
import { TOOL_SPECS } from '../src/agent/tools.js';
import { createLlm } from '../src/agent/index.js';

describe('BedrockLlm (ไม่เรียก AWS จริง)', () => {
  it('ส่ง system, messages, tools ตามรูปแบบ Converse API และกรองเฉพาะ text/toolUse', async () => {
    let sent: any;
    const client = {
      send: async (cmd: any) => {
        sent = cmd.input;
        return {
          output: { message: { content: [{ text: 'แผน' }, { reasoningContent: {} }, { toolUse: { toolUseId: 't1', name: 'list_buyers', input: {} } }] } },
          stopReason: 'tool_use',
          usage: { inputTokens: 120, outputTokens: 30 },
        };
      },
    };
    const llm = new BedrockLlm({ modelId: 'apac.amazon.nova-2-lite-v1:0', client: client as never });
    const res = await llm.converse({ system: 'sys', messages: [{ role: 'user', content: [{ text: 'hi' }] }], tools: TOOL_SPECS });
    expect(sent.modelId).toBe('apac.amazon.nova-2-lite-v1:0');
    expect(sent.system).toEqual([{ text: 'sys' }]);
    expect(sent.toolConfig.tools).toHaveLength(TOOL_SPECS.length);
    expect(sent.toolConfig.tools[0].toolSpec.inputSchema.json.type).toBe('object');
    expect(res.content).toHaveLength(2);
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it('ต้องตั้ง model ID และค่าเริ่มต้นเป็น LLM จำลอง (ไม่มีค่าใช้จ่าย)', () => {
    expect(() => new BedrockLlm({ modelId: '' })).toThrow(/BEDROCK_MODEL_ID/);
    expect(createLlm({}).name).toBe('mock:rule-based');
  });
});
