import { normalizeReplyResult } from './llm.js';

/** Compose 阶段：只负责调用回复模型并产生草稿。 */
export async function composeTurn(input = {}) {
  if (!input.llm || typeof input.llm.generateReply !== 'function') {
    const error = new Error('Compose stage requires llm.generateReply');
    error.code = 'COMPOSE_LLM_UNAVAILABLE';
    throw error;
  }
  const normalized = normalizeReplyResult(
    await input.llm.generateReply(input.messages ?? [], {
      ...(input.samplingHints ?? {}),
      signal: input.signal,
    }),
  );
  return {
    promptParts: input.promptParts ?? {},
    messages: input.messages ?? [],
    draftText: normalized.text,
    draftParts: normalized.parts,
    model: input.model ?? null,
    streamed: false,
  };
}

/** 流式传输结束后，将已收集草稿纳入同一个 Composition 契约。 */
export function compositionFromStream(input = {}) {
  return {
    promptParts: input.promptParts ?? {},
    messages: input.messages ?? [],
    draftText: String(input.text ?? ''),
    draftParts: Array.isArray(input.parts) ? input.parts : [],
    model: input.model ?? null,
    streamed: input.streamed !== false,
  };
}
