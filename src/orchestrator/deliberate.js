import { PARAMS } from '../params.js';
import { buildConversationGoals } from './goals.js';
import { bodyIntimacyGate } from '../companion/bodyState.js';
import { planTurn } from './turnPlan.js';
import {
  planStructuredHeuristic,
  enrichStructuredPlan,
  applyStructuredToTurn,
} from './structuredPlan.js';

/**
 * Deliberate 阶段：生成目标、候选约束和最终本轮计划。
 * 不写状态；到期 prospective 只输出待提交 ID，由 Commit 标记 fired。
 */
export async function deliberateTurn(input = {}) {
  const preliminary = input.retrievalPlan ?? planRetrievalTurn(input);
  let {
    goals,
    turnPlan: turn,
    behavior,
    constraints,
    prospectiveToDismiss,
  } = preliminary;
  const {
    userMessage = '',
    storyBeat = null,
    intimacyLive = null,
    unfinished = [],
    sceneLocks = [],
    bodySituation = null,
    planClient = null,
    signal,
  } = input;
  let structured = planStructuredHeuristic({
    userMessage,
    sceneLocks,
    goals,
    behavior,
    storyBeat,
    unfinished,
    intimacyPhase: intimacyLive?.scene_phase,
    bodySit: bodySituation,
  });
  if (PARAMS.orchestrator?.structuredPlanLlm !== false && planClient) {
    structured = await enrichStructuredPlan(
      structured,
      {
        userMessage,
        sceneLocks,
        goals,
        storyBeat,
        unfinished,
        intimacyPhase: intimacyLive?.scene_phase,
      },
      { client: planClient, signal },
    ).catch(() => structured);
  }
  turn = applyStructuredToTurn(turn, structured, behavior);
  if (turn._lengthHintOverride) {
    behavior = {
      ...behavior,
      lengthHint: turn._lengthHintOverride,
      partsBudget: turn.partsBudget,
    };
  }
  if (turn && typeof turn === 'object') {
    turn.intimacyPhase = intimacyLive?.scene_phase ?? null;
  }
  return {
    goals,
    candidates: goals.map((goal) => ({
      intent: goal.kind,
      utility: goal.priority,
      constraints: goal.canInitiate === false ? ['cannot_initiate'] : [],
    })),
    selectedAction: goals[0]?.kind ?? 'respond',
    constraints,
    turnPlan: turn,
    structuredPlan: structured,
    behavior,
    samplingHints: {},
    rationaleCodes: goals.slice(0, 3).map((goal) => `goal:${goal.kind}`),
    prospectiveToDismiss,
    evidenceSummary: input.evidence
      ? {
          hitCount: input.evidence.memoryHits?.length ?? 0,
          provenanceCount: input.evidence.provenance?.length ?? 0,
        }
      : { hitCount: 0, provenanceCount: 0 },
  };
}

/**
 * Retrieve 前的最小规划：只产生召回 query 所需的 goals/turn，不调用规划模型。
 */
export function planRetrievalTurn(input = {}) {
  const {
    userMessage = '',
    stateSnapshot = null,
    dueItems = [],
    storyBeat = null,
    intimacyLive = null,
    intimacyPolicy = null,
    unfinished = [],
    sceneLocks = [],
    bodySituation = null,
    gapHours = null,
    behavior: inputBehavior = {},
    ablation = {},
    options = {},
    historyTurnsDefault = 6,
    useMonologueDefault = false,
  } = input;
  let behavior = inputBehavior;
  const goals = buildConversationGoals({
    dueItems,
    desires: ablation.desire === false ? {} : stateSnapshot?.desires,
    storyBeat: ablation.story === false ? null : storyBeat,
    intimacy: intimacyLive ?? stateSnapshot?.intimacy,
    intimacyPolicy,
    unfinished,
    outfit: stateSnapshot?.outfit,
    userMessage,
    sceneLocks,
  });

  const bodyGate = bodyIntimacyGate(bodySituation ?? {});
  if (!bodyGate.allowIntimateInit) {
    for (const goal of goals) {
      if (goal.kind === 'intimacy' && goal.canInitiate) {
        goal.canInitiate = false;
        goal.text = '身体不适：可黏可要抱抱，别主动推高热；对方坚持也温柔设限。';
        goal.priority = Math.min(goal.priority, 0.35);
      }
    }
    goals.sort((a, b) => b.priority - a.priority);
  }

  if (options.stopIntimate || options.intimacyAllowed === false) {
    for (const goal of goals) {
      if (goal.kind === 'intimacy') {
        goal.canInitiate = false;
        goal.text = options.stopIntimate
          ? '对方已表示停止/冷静：立刻降热，先确认边界，不继续身体推进。'
          : '当前亲密内容策略关闭：保持情感陪伴，不进入高热描写。';
        goal.priority = 0.95;
      }
    }
    goals.unshift({
      kind: 'safety',
      priority: 1,
      text: options.stopIntimate
        ? '安全停止：承认并停下亲密推进，语气稳、给台阶，别质问。'
        : '亲密策略限制中：正常聊天即可。',
    });
    goals.sort((a, b) => b.priority - a.priority);
  }

  let turn = planTurn({
    userMessage,
    sceneLocks,
    behavior,
    goals,
    intimacyPhase: intimacyLive?.scene_phase,
    bodySit: bodySituation,
    gapHours,
    historyTurnsDefault,
    useMonologueDefault,
  });
  return {
    goals,
    constraints: {
      bodyGate,
      stopIntimate: Boolean(options.stopIntimate),
      intimacyAllowed: options.intimacyAllowed !== false,
    },
    turnPlan: turn,
    behavior,
    prospectiveToDismiss: dueItems.map((item) => item?.id).filter(Boolean),
  };
}
