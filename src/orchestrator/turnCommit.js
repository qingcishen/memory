/**
 * 七阶段迁移期的统一 Commit 适配器。
 * 非流式与流式回复都必须经过这里提交 history、afterReply 与媒体副作用。
 */
export function commitValidatedReply(orchestrator, input = {}) {
  const {
    eventId,
    historyUserMessage,
    reply,
    sceneLocks = [],
    nowMs = Date.now(),
    relationshipStage,
    stateSnapshot,
    photoRequested = false,
  } = input;

  if (!eventId) {
    const error = new Error('Commit requires a stable eventId');
    error.code = 'COMMIT_EVENT_ID_REQUIRED';
    throw error;
  }

  if (input.sessionEnabled !== false) {
    orchestrator._sessionThread = input.updateSession(orchestrator._sessionThread, {
      userMessage: historyUserMessage,
      reply,
      sceneLocks,
      now: nowMs,
    });
    orchestrator.persistSessionThread();
  }
  orchestrator.persistEmotionResidue();

  orchestrator.recordHistory(
    [
      { role: 'user', content: historyUserMessage },
      { role: 'assistant', content: reply },
    ],
    { eventId },
  );

  orchestrator._lastAfterReply = orchestrator.afterReply(historyUserMessage, reply, {
    eventId,
    history: orchestrator.history,
    sceneLocks,
    relationshipStage,
  });

  orchestrator
    .maybeDailyLookPhoto(stateSnapshot)
    .catch((error) => console.error('[maybeDailyLookPhoto]', error));

  if (photoRequested) {
    orchestrator._lastPhoto = orchestrator.maybePhoto(stateSnapshot, { requested: true });
  }

  return {
    eventId,
    status: 'committed',
    history: { appended: 2 },
    enqueued: Boolean(orchestrator._lastAfterReply),
    sessionThread: orchestrator._sessionThread,
  };
}

export function createTurnEventId({ eventId, userId, companionId, now = Date.now() } = {}) {
  if (eventId) return String(eventId);
  const scope = `${String(userId || 'unknown')}:${String(companionId || 'default')}`;
  return `turn:${scope}:${now}:${Math.random().toString(36).slice(2, 10)}`;
}
