/**
 * 七阶段迁移期的统一 Commit 适配器。
 * 非流式与流式回复都必须经过这里提交 history、afterReply 与媒体副作用。
 */
export async function commitValidatedReply(orchestrator, input = {}) {
  const {
    eventId,
    historyUserMessage,
    reply,
    sceneLocks = [],
    nowMs = Date.now(),
    relationshipStage,
    stateSnapshot,
    photoRequested = false,
    prospectiveToDismiss = [],
  } = input;

  if (!eventId) {
    const error = new Error('Commit requires a stable eventId');
    error.code = 'COMMIT_EVENT_ID_REQUIRED';
    throw error;
  }
  orchestrator._committedTurnEvents ??= new Set();
  if (orchestrator._committedTurnEvents.has(eventId)) {
    return {
      eventId,
      status: 'already_committed',
      history: { appended: 0 },
      enqueued: false,
      idempotentReplay: true,
      sessionThread: orchestrator._sessionThread,
    };
  }

  const eventScope = {
    userId: orchestrator.userId,
    companionId: orchestrator.companionId,
    eventId,
  };
  const eventStore = orchestrator.turnEventStore;
  let claimedScope = eventScope;
  let priorProjectionState = {};
  if (eventStore?.claim) {
    const claim = await eventStore.claim({
      ...eventScope,
      payload: {
        turnId: input.turnId ?? eventId,
        replyLength: String(reply ?? '').length,
      },
    });
    if (!claim.acquired) {
      const committed = claim.event?.status === 'committed';
      return {
        eventId,
        status: committed ? 'already_committed' : 'commit_in_progress',
        history: { appended: 0 },
        enqueued: false,
        idempotentReplay: committed,
        sessionThread: orchestrator._sessionThread,
      };
    }
    claimedScope = { ...eventScope, leaseToken: claim.leaseToken };
    priorProjectionState = claim.event?.projection_state ?? {};
  }

  try {
    const projections = createTurnProjectionRunner({
      eventStore,
      scope: claimedScope,
      priorState: priorProjectionState,
    });

    await projections.run('session', () => {
      orchestrator._sessionThread = input.updateSession(orchestrator._sessionThread, {
        userMessage: historyUserMessage,
        reply,
        sceneLocks,
        now: nowMs,
      });
      orchestrator.persistSessionThread();
    }, { skip: input.sessionEnabled === false });

    await projections.run('emotion', () => orchestrator.persistEmotionResidue(), {
      successStatus: 'dispatched',
    });

    const historyProjection = await projections.run('history', () =>
      orchestrator.recordHistory(
        [
          { role: 'user', content: historyUserMessage },
          { role: 'assistant', content: reply },
        ],
        { eventId },
      ));

    await projections.run('after_reply', () => {
      orchestrator._lastAfterReply = orchestrator.afterReply(historyUserMessage, reply, {
        eventId,
        history: orchestrator.history,
        sceneLocks,
        relationshipStage,
      });
      return orchestrator.afterReplyEnqueue ? orchestrator._lastAfterReply : undefined;
    }, { successStatus: orchestrator.afterReplyEnqueue ? 'enqueued' : 'dispatched' });

    await projections.run('prospective', () => {
      orchestrator._lastProspectiveDismiss = Promise.resolve(
        orchestrator.memory.dismissProspective(prospectiveToDismiss),
      ).catch((error) => {
        console.error('[commit.dismissProspective]', error);
        return null;
      });
    }, {
      successStatus: 'dispatched',
      skip:
        !prospectiveToDismiss.length ||
        typeof orchestrator.memory?.dismissProspective !== 'function',
    });

    await projections.run('daily_photo', () => {
      orchestrator
        .maybeDailyLookPhoto(stateSnapshot, { eventId, projection: 'daily_photo' })
        .catch((error) => console.error('[maybeDailyLookPhoto]', error));
    }, { successStatus: 'dispatched' });

    await projections.run('requested_photo', () => {
      orchestrator._lastPhoto = orchestrator.maybePhoto(stateSnapshot, {
        requested: true,
        eventId,
        projection: 'requested_photo',
      });
    }, { successStatus: 'dispatched', skip: !photoRequested });

    orchestrator._committedTurnEvents.add(eventId);

    const projectionState = projections.snapshot();
    const result = {
      eventId,
      status: 'committed',
      history: { appended: historyProjection.skipped ? 0 : 2 },
      enqueued:
        Boolean(orchestrator._lastAfterReply) ||
        Boolean(orchestrator._lastProspectiveDismiss),
      projections: {
        completed: completedProjectionNames(projectionState),
        state: projectionState,
      },
      sessionThread: orchestrator._sessionThread,
      idempotentReplay: false,
    };
    if (eventStore?.complete) {
      try {
        await eventStore.complete(claimedScope, {
          historyAppended: result.history.appended,
          enqueued: result.enqueued,
          projections: result.projections.completed,
        });
      } catch (error) {
        return { ...result, status: 'commit_pending', ledgerError: String(error?.message ?? error) };
      }
    }
    return result;
  } catch (error) {
    await eventStore?.fail?.(claimedScope, error).catch(() => {});
    throw error;
  }
}

export function createTurnEventId({ eventId, userId, companionId, now = Date.now() } = {}) {
  if (eventId) return String(eventId);
  const scope = `${String(userId || 'unknown')}:${String(companionId || 'default')}`;
  return `turn:${scope}:${now}:${Math.random().toString(36).slice(2, 10)}`;
}
import { completedProjectionNames, createTurnProjectionRunner } from './turnProjection.js';
