import { normalizeReplyResult } from './llm.js';
import { nonSequiturRepairHint } from '../companion/sceneCoherence.js';
import { isRepetitiveReply } from './humanizeReply.js';
import { PARAMS } from '../params.js';

/**
 * Validate 阶段：场景/时间一致性、复读检查、有限重写和最终后处理。
 * 不写 history 或长期状态。
 */
export async function validateTurn(input = {}) {
  let reply = String(input.composition?.draftText ?? '');
  let parts = Array.isArray(input.composition?.draftParts)
    ? input.composition.draftParts
    : [];
  const messages = input.messages ?? input.composition?.messages ?? [];
  const sceneLocks = input.sceneLocks ?? [];
  const allowRetry =
    input.skipCoherenceRetry !== true &&
    PARAMS.orchestrator?.coherenceRetry !== false;
  const temporalCoherence = {
    gapHours: input.gapHours,
    userMessage: input.userMessage,
    currentActivity: input.currentActivity,
  };
  let repair = nonSequiturRepairHint(reply, sceneLocks, temporalCoherence);
  const checks = [
    {
      id: 'scene_temporal_coherence',
      passed: !repair.needsRetry,
      reasons: repair.reasons ?? [],
    },
  ];

  if (repair.needsRetry && allowRetry) {
    try {
      const retried = normalizeReplyResult(
        await input.llm.generateReply(
          [
            ...messages,
            { role: 'assistant', content: reply },
            { role: 'user', content: repair.hint },
          ],
          { ...(input.samplingHints ?? {}), signal: input.signal },
        ),
      );
      const retryCheck = nonSequiturRepairHint(
        retried.text,
        sceneLocks,
        temporalCoherence,
      );
      if (retried.text && !retryCheck.needsRetry) {
        reply = retried.text;
        parts = retried.parts;
        repair = retryCheck;
        checks[0] = { id: 'scene_temporal_coherence', passed: true, reasons: [] };
      }
    } catch {
      checks.push({ id: 'coherence_retry', passed: false, reasons: ['retry_failed'] });
    }
  }

  const repetitive = isRepetitiveReply(reply, input.history ?? []);
  checks.push({ id: 'anti_repetition', passed: !repetitive, reasons: [] });
  if (allowRetry && repetitive) {
    try {
      const retried = normalizeReplyResult(
        await input.llm.generateReply(
          [
            ...messages,
            { role: 'assistant', content: reply },
            {
              role: 'user',
              content:
                '（系统）你刚才在复读上一轮：同一套动作或只回「嗯…」。请完全换新的身体细节和台词，禁止拽衣襟/膝盖贴腿/半跪/腿软模板，禁止空省略号。像真人接住对方刚说的话。',
            },
          ],
          { ...(input.samplingHints ?? {}), signal: input.signal },
        ),
      );
      if (retried.text && !isRepetitiveReply(retried.text, input.history ?? [])) {
        reply = retried.text;
        parts = retried.parts;
        checks[checks.length - 1] = { id: 'anti_repetition', passed: true, reasons: [] };
      }
    } catch {
      checks.push({ id: 'repetition_retry', passed: false, reasons: ['retry_failed'] });
    }
  }

  if (typeof input.postProcess === 'function') {
    const processed = input.postProcess(reply, parts);
    reply = processed.reply;
    parts = processed.parts;
  }
  return {
    accepted: Boolean(reply || parts.length === 0),
    finalText: reply,
    finalParts: parts,
    checks,
    repair,
    safety: { passed: true },
  };
}
