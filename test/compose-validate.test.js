import { describe, expect, it } from 'vitest';
import { composeTurn, compositionFromStream } from '../src/orchestrator/composeStage.js';
import { validateTurn } from '../src/orchestrator/validateStage.js';

describe('Compose and Validate stages', () => {
  it('normalizes a non-streaming model draft', async () => {
    const composition = await composeTurn({
      llm: { async generateReply() { return '你好呀'; } },
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(composition.draftText).toBe('你好呀');
    expect(composition.streamed).toBe(false);
  });

  it('uses the same composition contract for streaming', () => {
    expect(
      compositionFromStream({ text: '流式完成', parts: [], streamed: true }),
    ).toMatchObject({ draftText: '流式完成', streamed: true });
  });

  it('validates and post-processes a draft without committing state', async () => {
    const validation = await validateTurn({
      composition: { draftText: '好的', draftParts: [{ type: 'dialogue', text: '好的' }] },
      llm: { async generateReply() { return '换一句'; } },
      userMessage: '你好',
      history: [],
      postProcess: (reply, parts) => ({ reply: `${reply}！`, parts }),
    });
    expect(validation.finalText).toBe('好的！');
    expect(validation.checks.map((check) => check.id)).toContain('anti_repetition');
  });
});
