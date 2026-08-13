const WEIGHTS = Object.freeze({
  relationshipBenefit: 0.2,
  needSatisfaction: 0.24,
  personaConsistency: 0.12,
  continuity: 0.2,
  informationGain: 0.08,
  interruptionCost: -0.12,
  safetyRisk: -0.5,
  repetitionPenalty: -0.12,
  hallucinationRisk: -0.18,
});

/**
 * 把目标栈投影为公开、可评测的行为候选。v1 只做 shadow decision，
 * 不直接改写 structured plan。
 */
export function decideActionUtility(input = {}) {
  const weights = normalizeUtilityWeights(input.weights);
  const candidates = buildActionCandidates(input).map((candidate) =>
    scoreActionCandidate(candidate, { weights }));
  const feasible = candidates.filter((candidate) => candidate.feasible);
  const selected = [...feasible].sort(compareCandidates)[0] ?? candidates[0] ?? null;
  const runnerUp = [...feasible].sort(compareCandidates)[1] ?? null;
  const margin = selected?.hardPriority
    ? 1
    : Math.max(0, Number(selected?.utility ?? 0) - Number(runnerUp?.utility ?? 0));
  return {
    selectedAction: selected?.intent ?? 'respond',
    selectedCandidateId: selected?.id ?? 'respond',
    candidates,
    rationaleCodes: selected
      ? [
          `action:${selected.intent}`,
          ...dominantComponents(selected.components, weights).map((name) => `utility:${name}`),
          ...selected.constraints.map((constraint) => `constraint:${constraint}`),
        ]
      : ['action:respond'],
    weights,
    shadow: input.shadow !== false,
    margin: round(margin),
    applied: false,
  };
}

/**
 * 把 shadow 决策升级为受控接管。guarded 只允许低风险意图；安全停止无条件接管。
 * 评测未达标的 share/flirt 即使得分最高，也继续只写 trace。
 */
export function activateActionDecision(decision = {}, options = {}) {
  const mode = ['shadow', 'guarded', 'active'].includes(options.mode)
    ? options.mode
    : 'shadow';
  const selected = (decision.candidates ?? []).find(
    (candidate) => candidate.id === decision.selectedCandidateId,
  );
  const allowed = new Set(
    options.allowedIntents ?? ['safety_stop', 'ask', 'reassure'],
  );
  const minMargin = Math.max(0, Number(options.minMargin) || 0);
  let reason = 'mode_shadow';
  let applied = false;

  if (!selected || selected.feasible === false) {
    reason = 'candidate_infeasible';
  } else if (selected.constraints?.includes('conflict_lock') && selected.intent === 'flirt') {
    reason = 'conflict_lock';
  } else if (selected.intent === 'safety_stop' && selected.constraints?.includes('safety_override')) {
    applied = mode !== 'shadow';
    reason = applied ? 'safety_override' : 'mode_shadow';
  } else if (mode === 'active' || (mode === 'guarded' && allowed.has(selected.intent))) {
    if (Number(decision.margin) >= minMargin) {
      applied = true;
      reason = 'margin_passed';
    } else {
      reason = 'margin_too_small';
    }
  } else if (mode === 'guarded') {
    reason = 'intent_not_guarded';
  }

  return {
    ...decision,
    mode,
    shadow: !applied,
    applied,
    takeoverReason: reason,
    rationaleCodes: [
      ...(decision.rationaleCodes ?? []),
      `takeover:${reason}`,
    ],
  };
}

/** 将已获准接管的行为意图落实到公开 structured plan。 */
export function applyActionDecisionToPlan(structured = {}, decision = {}) {
  if (!structured || decision.shadow !== false || !decision.applied) return structured;
  const selected = (decision.candidates ?? []).find(
    (candidate) => candidate.id === decision.selectedCandidateId,
  );
  const sourceGoal = selected?.sourceGoal ?? null;
  const next = {
    ...structured,
    actions: [...(structured.actions ?? [])],
    source: `${structured.source ?? 'heuristic'}+utility`,
    utilityAction: decision.selectedAction,
  };
  if (decision.selectedAction === 'safety_stop') {
    next.attitude = 'soft';
    next.lengthHint = 'terse';
    next.bubbleCount = 1;
    next.mentionStory = false;
    next.mentionUnfinished = false;
    next.wantPhoto = false;
    next.actions = [];
    next.note = '立即确认停止，先照顾边界，不继续推进。';
  } else if (decision.selectedAction === 'ask') {
    next.mentionUnfinished = ['prospective', 'unfinished'].includes(sourceGoal);
    next.note = next.mentionUnfinished
      ? '先回应当前话题，再自然追问之前约好的事情。'
      : '先回应，再问一个真正有信息增益的问题。';
  } else if (decision.selectedAction === 'reassure') {
    next.attitude = 'soft';
    next.note = '这轮优先给到具体、不过度承诺的安抚与确认。';
  } else if (decision.selectedAction === 'share') {
    next.mentionStory = sourceGoal === 'story';
    next.note = '先接住对方，再分享一小段相关生活，不抢话题。';
  } else if (decision.selectedAction === 'flirt') {
    next.attitude = next._lockIds?.includes('intimate') ? 'intimate' : 'playful';
    next.note = '只做与当前关系和场景一致的轻度靠近，随时服从边界。';
  }
  return next;
}

export function buildActionCandidates(input = {}) {
  const {
    goals = [],
    userMessage = '',
    sceneLocks = [],
    recentActionIntents = [],
  } = input;
  const lockIds = new Set((sceneLocks ?? []).map((lock) => lock?.id).filter(Boolean));
  const asksQuestion = /[?？]|怎么|为什么|是不是|要不要|能不能|记得吗|还记得/.test(userMessage);
  const candidates = [
    {
      id: 'respond',
      intent: 'respond',
      sourceGoal: null,
      components: {
        relationshipBenefit: 0.55,
        needSatisfaction: 0.5,
        personaConsistency: 0.75,
        continuity: 0.9,
        informationGain: asksQuestion ? 0.35 : 0.15,
        interruptionCost: 0.05,
        safetyRisk: 0,
        repetitionPenalty: repetition(recentActionIntents, 'respond'),
        hallucinationRisk: 0.05,
      },
      constraints: [],
    },
  ];

  for (const [index, goal] of goals.entries()) {
    const intent = actionIntent(goal.kind);
    const safety = goal.kind === 'safety';
    const cannotInitiate = goal.canInitiate === false && intent === 'flirt';
    const conflictRisk = lockIds.has('conflict') && intent === 'flirt' ? 0.85 : 0;
    candidates.push({
      id: `goal:${goal.kind}:${goal.sourceId ?? index}`,
      intent,
      sourceGoal: goal.kind,
      components: {
        relationshipBenefit: clamp01(goal.priority),
        needSatisfaction: clamp01(goal.priority * (goal.need ? 1 : 0.8)),
        personaConsistency: safety ? 0.9 : 0.7,
        continuity: continuityForGoal(goal.kind, userMessage),
        informationGain: intent === 'ask' ? 0.85 : asksQuestion ? 0.25 : 0.1,
        interruptionCost: interruptionForGoal(goal.kind),
        safetyRisk: safety ? 0 : Math.max(conflictRisk, cannotInitiate ? 1 : 0),
        repetitionPenalty: repetition(recentActionIntents, intent),
        hallucinationRisk: hallucinationRisk(goal),
      },
      constraints: [
        ...(cannotInitiate ? ['cannot_initiate'] : []),
        ...(conflictRisk ? ['conflict_lock'] : []),
        ...(safety ? ['safety_override'] : []),
      ],
      hardPriority: safety ? 1 : 0,
    });
  }
  return candidates;
}

export function scoreActionCandidate(candidate = {}, { weights = WEIGHTS } = {}) {
  weights = normalizeUtilityWeights(weights);
  const components = Object.fromEntries(
    Object.entries(candidate.components ?? {}).map(([key, value]) => [key, clamp01(value)]),
  );
  const feasible = !(candidate.constraints ?? []).includes('cannot_initiate');
  const rawUtility = Object.entries(weights).reduce(
    (sum, [name, weight]) => sum + (components[name] ?? 0) * weight,
    0,
  );
  const utility = candidate.hardPriority
    ? 1 + rawUtility
    : feasible
      ? rawUtility
      : Number.NEGATIVE_INFINITY;
  return {
    ...candidate,
    components,
    constraints: [...(candidate.constraints ?? [])],
    feasible,
    utility: Number.isFinite(utility) ? round(utility) : null,
  };
}

/**
 * 对持久 trace 中的公开候选重新打分，不需要重新 Retrieve、Compose 或调用 LLM。
 */
export function replayActionDecision(snapshot = {}, options = {}) {
  const weights = normalizeUtilityWeights(options.weights);
  const candidates = (snapshot.candidates ?? []).map((candidate) =>
    scoreActionCandidate(
      {
        ...candidate,
        hardPriority:
          candidate.hardPriority ??
          Number((candidate.constraints ?? []).includes('safety_override')),
      },
      { weights },
    ));
  const selected =
    [...candidates].filter((candidate) => candidate.feasible).sort(compareCandidates)[0] ??
    candidates[0] ??
    null;
  return {
    selectedAction: selected?.intent ?? 'respond',
    selectedCandidateId: selected?.id ?? 'respond',
    previousSelectedAction: snapshot.selectedAction ?? null,
    changed: Boolean(
      snapshot.selectedAction && snapshot.selectedAction !== (selected?.intent ?? 'respond'),
    ),
    candidates,
    weights,
    replay: true,
    margin: round(
      Math.max(
        0,
        Number(selected?.utility ?? 0) -
          Number([...candidates].filter((candidate) => candidate.feasible)
            .sort(compareCandidates)[1]?.utility ?? 0),
      ),
    ),
  };
}

export function compareActionWeightSets(snapshots = [], weightSets = {}) {
  return Object.fromEntries(
    Object.entries(weightSets).map(([name, weights]) => {
      const replays = snapshots.map((snapshot) =>
        replayActionDecision(snapshot, { weights }));
      return [
        name,
        {
          total: replays.length,
          changed: replays.filter((replay) => replay.changed).length,
          selectedCounts: countBy(replays.map((replay) => replay.selectedAction)),
          replays,
        },
      ];
    }),
  );
}

export function normalizeUtilityWeights(overrides = {}) {
  return Object.fromEntries(
    Object.entries(WEIGHTS).map(([name, fallback]) => {
      const value = Number(overrides?.[name]);
      return [name, Number.isFinite(value) ? Math.max(-2, Math.min(2, value)) : fallback];
    }),
  );
}

function compareCandidates(a, b) {
  return (b.hardPriority ?? 0) - (a.hardPriority ?? 0) ||
    (b.utility ?? -Infinity) - (a.utility ?? -Infinity) ||
    String(a.id).localeCompare(String(b.id));
}

function actionIntent(kind) {
  return {
    prospective: 'ask',
    desire: 'reassure',
    story: 'share',
    intimacy: 'flirt',
    unfinished: 'ask',
    outfit: 'share',
    safety: 'safety_stop',
  }[kind] ?? kind ?? 'respond';
}

function continuityForGoal(kind, message) {
  if (kind === 'safety') return 1;
  if (kind === 'outfit' && /(穿|衣服|裙子|妆|鞋|自拍|照片)/.test(message)) return 0.95;
  if (kind === 'story' && /(今天|最近|怎么样|忙什么)/.test(message)) return 0.9;
  if (kind === 'prospective' || kind === 'unfinished') return 0.55;
  return 0.65;
}

function interruptionForGoal(kind) {
  return {
    safety: 0,
    prospective: 0.3,
    unfinished: 0.35,
    story: 0.25,
    desire: 0.4,
    intimacy: 0.35,
    outfit: 0.2,
  }[kind] ?? 0.15;
}

function hallucinationRisk(goal) {
  if (goal.kind === 'story' && !goal.sourceId) return 0.2;
  if (goal.kind === 'unfinished' && !goal.sourceId) return 0.25;
  return 0.05;
}

function repetition(recent, intent) {
  const normalized = (recent ?? []).map(String);
  if (!normalized.length) return 0;
  const count = normalized.slice(-3).filter((value) => value === intent).length;
  return clamp01(count / 2);
}

function dominantComponents(components, weights = WEIGHTS) {
  return Object.entries(components)
    .filter(([name]) => weights[name] > 0)
    .sort((a, b) => b[1] * weights[b[0]] - a[1] * weights[a[0]])
    .slice(0, 2)
    .map(([name]) => name);
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
