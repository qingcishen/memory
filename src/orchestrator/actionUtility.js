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
  const candidates = buildActionCandidates(input).map(scoreActionCandidate);
  const feasible = candidates.filter((candidate) => candidate.feasible);
  const selected = [...feasible].sort(compareCandidates)[0] ?? candidates[0] ?? null;
  return {
    selectedAction: selected?.intent ?? 'respond',
    selectedCandidateId: selected?.id ?? 'respond',
    candidates,
    rationaleCodes: selected
      ? [
          `action:${selected.intent}`,
          ...dominantComponents(selected.components).map((name) => `utility:${name}`),
          ...selected.constraints.map((constraint) => `constraint:${constraint}`),
        ]
      : ['action:respond'],
    weights: WEIGHTS,
    shadow: input.shadow !== false,
  };
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

export function scoreActionCandidate(candidate = {}) {
  const components = Object.fromEntries(
    Object.entries(candidate.components ?? {}).map(([key, value]) => [key, clamp01(value)]),
  );
  const feasible = !(candidate.constraints ?? []).includes('cannot_initiate');
  const rawUtility = Object.entries(WEIGHTS).reduce(
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

function dominantComponents(components) {
  return Object.entries(components)
    .filter(([name]) => WEIGHTS[name] > 0)
    .sort((a, b) => b[1] * WEIGHTS[b[0]] - a[1] * WEIGHTS[a[0]])
    .slice(0, 2)
    .map(([name]) => name);
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
