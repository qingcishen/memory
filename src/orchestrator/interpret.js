import { PARAMS } from '../params.js';
import { inferEmotionLabel } from '../state/emotionLabel.js';
import { behaviorPolicy } from '../state/behavior.js';
import {
  prepareIntimacyForTurn,
  defaultIntimacy,
} from '../state/intimacy.js';
import {
  inferRelationshipStage,
  applyStageToBehavior,
} from '../companion/relationshipStage.js';
import {
  inferBodySituation,
  applyBodyToBehavior,
} from '../companion/bodyState.js';
import {
  detectSceneLocks,
  extractUnfinishedHooks,
} from '../companion/sceneCoherence.js';
import {
  updateSessionThread,
  sessionHooksToUnfinished,
} from '../companion/sessionThread.js';

/**
 * Interpret 阶段：把状态快照和本轮输入解释为情绪、关系阶段、身体情境与场景约束。
 * 纯计算，不写数据库；emotionInferred.residual 由 Commit 前的调用方暂存。
 */
export function interpretTurn(input = {}) {
  const {
    userMessage = '',
    history = [],
    stateSnapshot = null,
    relState = null,
    sceneType = 'daily',
    now = Date.now(),
    config = null,
    ablation = {},
    behaviorState = {},
    previousEmotionResidual = null,
    sessionThread = null,
    sessionThreadEnabled = true,
    intimacyConfig = PARAMS.intimacy,
    recoverBias,
  } = input;
  const rel = relState?.relationship ?? relState ?? {};
  const emotionInferred = inferEmotionLabel(
    { ...(stateSnapshot ?? {}), relationship: rel },
    ablation.desire === false ? {} : stateSnapshot?.desires,
    [...history.slice(-4), { role: 'user', content: userMessage }],
    {
      previousResidual: previousEmotionResidual,
      userMessage,
      recoverBias,
      withResidual: true,
      now,
    },
  );
  const emotionLabel =
    typeof emotionInferred === 'string' ? emotionInferred : emotionInferred.label;

  const intimacyLive =
    PARAMS.intimacy?.enabled !== false
      ? prepareIntimacyForTurn(
          stateSnapshot?.intimacy ?? defaultIntimacy(),
          {
            userMessage,
            sceneType,
            relationship: relState?.relationship ?? relState ?? stateSnapshot?.relationship,
            life: stateSnapshot?.life,
            desires: stateSnapshot?.desires,
          },
          intimacyConfig ?? PARAMS.intimacy,
        )
      : stateSnapshot?.intimacy ?? null;
  const stateForPrompt = stateSnapshot
    ? {
        ...stateSnapshot,
        ...(ablation.desire === false ? { desires: null } : {}),
        intimacy: intimacyLive ?? stateSnapshot.intimacy,
      }
    : stateSnapshot;
  const relStage = inferRelationshipStage(rel);
  const bodySituation = inferBodySituation(stateSnapshot?.life, config?.profile?.menstrual, now);
  let behavior = behaviorPolicy(
    ablation.behaviorPolicy === false ? '平静' : emotionLabel,
    {
      relationship: ablation.behaviorPolicy === false ? {} : rel,
      ...behaviorState,
    },
  );
  if (ablation.behaviorPolicy !== false) {
    behavior = applyStageToBehavior(behavior, relStage);
    behavior = applyBodyToBehavior(behavior, bodySituation);
  }

  const sceneLocks = detectSceneLocks(
    userMessage,
    history,
    intimacyLive?.scene_phase,
  );
  const sessionPeek =
    sessionThreadEnabled === false || !sessionThread
      ? null
      : updateSessionThread(sessionThread, {
          userMessage,
          sceneLocks,
          now,
        });
  const unfinished = [
    ...extractUnfinishedHooks(history),
    ...(sessionPeek ? sessionHooksToUnfinished(sessionPeek) : []),
  ].slice(0, 4);

  return {
    stateSnapshot,
    stateForPrompt,
    relationshipState: relState,
    relationship: rel,
    relationshipStage: relStage,
    bodySituation,
    emotion: {
      label: emotionLabel,
      confidence:
        typeof emotionInferred === 'object' &&
        emotionInferred.confidence != null &&
        Number.isFinite(Number(emotionInferred.confidence))
          ? Number(emotionInferred.confidence)
          : null,
      residual: typeof emotionInferred === 'object' ? emotionInferred.residual ?? null : null,
    },
    emotionInferred,
    intimacyLive,
    behavior,
    sceneType,
    sceneLocks,
    sessionPeek,
    unfinished,
  };
}
