import { describe, expect, it, vi } from 'vitest';
import {
  createAnthropicChatAdapter,
  isAnthropicApiKey,
  toAnthropicRequest,
} from '../src/providers/anthropicChatAdapter.js';

describe('Anthropic chat adapter', () => {
  it('detects Anthropic credentials without exposing their value', () => {
    expect(isAnthropicApiKey('sk-ant-example')).toBe(true);
    expect(isAnthropicApiKey('sk-openai-example')).toBe(false);
    expect(isAnthropicApiKey()).toBe(false);
  });

  it('collects all system instructions and removes unsupported OpenAI fields', () => {
    const request = toAnthropicRequest({
      model: 'claude-haiku-4-5',
      temperature: 0.4,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '角色设定' },
        { role: 'user', content: '你好' },
        { role: 'system', content: '只输出 JSON' },
      ],
    });
    expect(request).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      temperature: 0.4,
      system: '角色设定\n\n只输出 JSON',
      messages: [{ role: 'user', content: '你好' }],
    });
  });

  it('adapts non-streaming text, usage and AbortSignal', async () => {
    const create = vi.fn(async () => ({
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: '在呢。' }],
      usage: { input_tokens: 12, output_tokens: 3 },
    }));
    const client = { messages: { create } };
    const adapter = createAnthropicChatAdapter(client);
    const controller = new AbortController();

    await expect(adapter.chat.completions.create({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: '在吗' }],
    }, { signal: controller.signal })).resolves.toMatchObject({
      choices: [{ message: { content: '在呢。' } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    expect(create.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });

  it('adapts Anthropic stream events to OpenAI-style deltas and final usage', async () => {
    async function* events() {
      yield { type: 'message_start', message: { usage: { input_tokens: 8 } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '在' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '呢' } };
      yield { type: 'message_delta', usage: { output_tokens: 2 } };
    }
    const adapter = createAnthropicChatAdapter({
      messages: { create: vi.fn(async () => events()) },
    });
    const stream = await adapter.chat.completions.create({
      model: 'claude-haiku-4-5',
      stream: true,
      messages: [{ role: 'user', content: '在吗' }],
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks.slice(0, 2).map((chunk) => chunk.choices[0].delta.content)).toEqual(['在', '呢']);
    expect(chunks.at(-1).usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 2,
    });
  });
});
