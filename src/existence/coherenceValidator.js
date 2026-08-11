/**
 * M4 · 时间 / 主动意志 / 人格的跨模块一致性
 *
 * 验证器不修改传入状态。动态阈值与建议后的 proactive state 一起返回，由编排
 * 层决定是否重新生成或取消主动联系。
 */

export const DEFAULT_PROACTIVE_THRESHOLD = 0.40;

/**
 * 返回动态主动阈值及计算依据。
 */
export function proactiveThresholdDetails(
  personalityActive = {},
  proactiveState = {},
  context = {},
) {
  const core = personalityActive?.core_values || {};
  const relational = personalityActive?.relational_modifier || {};
  const behavior = personalityActive?.behavior_profile || {};
  const base = clamp(
    proactiveState?.base_desire_threshold
      ?? proactiveState?.desire_threshold
      ?? context?.baseThreshold,
    0.1,
    0.95,
    DEFAULT_PROACTIVE_THRESHOLD,
  );
  const adjustments = [];
  let threshold = base;
  let hardFloor = 0;

  const independence = clamp01(core.independence, 0.5);
  if (independence > 0.7) {
    hardFloor = 0.75;
    adjustments.push({
      reason: 'high_independence',
      kind: 'floor',
      value: hardFloor,
    });
  } else if (independence > 0.6) {
    const delta = round((independence - 0.6) * 0.4);
    threshold += delta;
    adjustments.push({ reason: 'moderate_independence', kind: 'add', value: delta });
  }

  const situation = String(personalityActive?.situation || '');
  const reasonQuality = contactReasonQuality(proactiveState?.reason ?? proactiveState?.desire_reason);
  if (
    situation === 'when_user_distant'
    && behavior.pursue_directly === false
    && reasonQuality < 0.7
  ) {
    hardFloor = Math.max(hardFloor, 0.65);
    adjustments.push({
      reason: 'distant_non_pursuing_pattern',
      kind: 'floor',
      value: 0.65,
    });
  }

  const tension = clamp01(relational.tension, 0);
  const repairDebt = clamp01(relational.repair_debt, 0);
  if (tension >= 0.45 || repairDebt >= 0.25) {
    const delta = round(Math.min(0.15, tension * 0.1 + repairDebt * 0.08));
    threshold += delta;
    adjustments.push({ reason: 'relationship_tension', kind: 'add', value: delta });
  }

  const contactInhibit = clamp01(
    proactiveState?.contact_inhibit ?? context?.contactInhibit,
    0,
  );
  if (contactInhibit > 0.4) {
    const delta = round((contactInhibit - 0.4) * 0.2);
    threshold += delta;
    adjustments.push({ reason: 'contact_inhibit', kind: 'add', value: delta });
  }

  const receptivity = clamp01(
    proactiveState?.receptivity?.score
      ?? proactiveState?.receptivity_score
      ?? context?.receptivity,
    1,
  );
  if (receptivity < 0.3) {
    const delta = round((0.3 - receptivity) * 0.5);
    threshold += delta;
    adjustments.push({ reason: 'low_receptivity', kind: 'add', value: delta });
  }

  threshold = round(clamp(Math.max(threshold, hardFloor), 0.1, 0.95, DEFAULT_PROACTIVE_THRESHOLD));
  return {
    threshold,
    base_threshold: base,
    hard_floor: hardFloor,
    adjustments,
  };
}

export function computeDynamicProactiveThreshold(
  personalityActive = {},
  proactiveState = {},
  context = {},
) {
  return proactiveThresholdDetails(personalityActive, proactiveState, context).threshold;
}

export const deriveProactiveThreshold = computeDynamicProactiveThreshold;
export const computeProactiveThreshold = computeDynamicProactiveThreshold;

/**
 * 兼容文档的三个位置参数，也接受一个
 * { temporalContext, proactiveState, personalityActive, selfModel } 对象。
 */
export function validateCrossModuleCoherence(
  temporalContext = {},
  proactiveState = {},
  personalityActive = {},
  options = {},
) {
  if (arguments.length === 1 && looksLikeValidationBundle(temporalContext)) {
    const bundle = temporalContext;
    temporalContext = bundle.temporalContext ?? bundle.temporal_context ?? {};
    proactiveState = bundle.proactiveState ?? bundle.proactive_state ?? {};
    personalityActive = bundle.personalityActive ?? bundle.personality_active ?? bundle.personality ?? {};
    options = bundle;
  }

  const issues = [];
  const warnings = [];
  const details = [];
  const thresholdInfo = proactiveThresholdDetails(personalityActive, proactiveState, options);
  const adjustedProactiveState = {
    ...(proactiveState || {}),
    desire_threshold: thresholdInfo.threshold,
  };

  const anomalyType = String(
    temporalContext?.anomaly?.type
      ?? temporalContext?.anomaly_type
      ?? '',
  );
  const temporalEmotion = String(
    temporalContext?.current_emotion
      ?? temporalContext?.emotion
      ?? temporalContext?.emotional_effect?.emotion
      ?? '',
  ).toLowerCase();
  const activeEmotion = String(
    personalityActive?.runtime_state?.current_emotion
      ?? personalityActive?.expression_guidance?.emotion
      ?? '',
  ).toLowerCase();
  const tone = String(personalityActive?.current_tone || '').toLowerCase();
  const worried = anomalyType === 'too_slow'
    || /(worried|worry|anxious|concern|担心|焦虑)/i.test(`${temporalEmotion} ${activeEmotion}`);
  const playfulTone = /(playful|bright|light|joking|轻松|俏皮|兴奋)/i.test(tone);

  if (worried && playfulTone) {
    addIssue(
      issues,
      details,
      'emotion_mismatch: worried_state + playful_tone',
      'error',
      '时间层表达担心，但人格层选择了轻快/玩笑语气',
      { recommended_tone: 'concerned' },
    );
  }

  if (
    anomalyType === 'too_fast'
    && /(cold|hostile|dismissive|冷漠|敌意)/i.test(tone)
  ) {
    addIssue(
      issues,
      details,
      'emotion_mismatch: pleasant_surprise + hostile_tone',
      'error',
      '比预期更早出现通常带来惊喜，当前敌意语气没有其它状态依据',
      { recommended_tone: 'natural_or_pleasantly_surprised' },
    );
  }

  const longing = clamp01(
    temporalContext?.longing
      ?? temporalContext?.temporal?.longing
      ?? personalityActive?.runtime_state?.longing,
    0,
  );
  if (longing >= 0.8 && /(indifferent|dismissive|cold|无所谓|冷漠)/i.test(tone)) {
    addIssue(
      issues,
      details,
      'emotion_mismatch: high_longing + indifferent_tone',
      'error',
      '高思念状态与无所谓语气冲突',
      { recommended_tone: 'restrained_longing' },
    );
  }

  const fatigue = clamp01(
    temporalContext?.fatigue
      ?? temporalContext?.temporal?.fatigue
      ?? personalityActive?.runtime_state?.fatigue,
    0,
  );
  if (fatigue >= 0.85 && /(bright|high_energy|excited)/i.test(tone)) {
    addIssue(
      issues,
      details,
      'energy_mismatch: high_fatigue + high_energy_tone',
      'warning',
      '高疲惫时可以开心，但表达节奏不应像精力满格',
      { recommended_tone: 'warm_but_low_energy' },
    );
  }

  const desire = clamp01(
    proactiveState?.desire ?? proactiveState?.proactive_desire,
    0,
  );
  const intendsContact = Boolean(
    proactiveState?.contact
      ?? proactiveState?.should_contact
      ?? proactiveState?.decision?.contact,
  );
  if (intendsContact && desire < thresholdInfo.threshold) {
    addIssue(
      issues,
      details,
      `proactive_threshold_not_met: ${desire.toFixed(2)} < ${thresholdInfo.threshold.toFixed(2)}`,
      'error',
      '主动联系决定没有达到当前人格的动态阈值',
      { desire, threshold: thresholdInfo.threshold },
    );
  }

  const reason = proactiveState?.reason ?? proactiveState?.desire_reason;
  const reasonType = String(reason?.type ?? reason?.kind ?? reason ?? '').toLowerCase();
  const reasonQuality = contactReasonQuality(reason);
  if (intendsContact && reasonQuality < 0.35 && desire < 0.85) {
    addIssue(
      issues,
      details,
      'proactive_reason_mismatch: weak_trigger',
      'error',
      '主动联系理由太弱，且冲动尚未高到足以支持“只是想找你”',
      { reason_quality: reasonQuality },
    );
  }
  if (worried && /(joke|meme|playful|逗|段子)/i.test(reasonType)) {
    addIssue(
      issues,
      details,
      'proactive_reason_mismatch: concern_state + playful_trigger',
      'error',
      '担心来自异常沉默，但主动联系理由却被写成玩笑触发',
      { recommended_reason: 'concern' },
    );
  }

  const independence = clamp01(personalityActive?.core_values?.independence, 0.5);
  if (
    independence > 0.7
    && intendsContact
    && desire < 0.75
  ) {
    addIssue(
      issues,
      details,
      'personality_mismatch: high_independence + low_desire_contact',
      'error',
      '高独立性人格不应在冲动不足时轻易主动联系',
      { threshold: thresholdInfo.threshold },
    );
  }

  const selfCoherence = clamp01(
    options?.selfModel?.coherence_score
      ?? options?.self_model?.coherence_score
      ?? personalityActive?.self_model?.coherence_score,
    1,
  );
  if (selfCoherence < 0.6) {
    addIssue(
      issues,
      details,
      `self_coherence_low: ${selfCoherence.toFixed(2)}`,
      'warning',
      '近期行为与身份叙事已有明显偏离，本轮应优先做自我调和',
      { self_coherence_score: selfCoherence },
    );
  }

  for (const detail of details) {
    if (detail.severity === 'warning') warnings.push(detail.code);
  }
  const errorCount = details.filter((detail) => detail.severity === 'error').length;
  const warningCount = details.filter((detail) => detail.severity === 'warning').length;
  const coherenceScore = round(clamp01(1 - errorCount * 0.18 - warningCount * 0.06));
  const valid = issues.length === 0;
  const result = {
    valid,
    issues,
    warnings,
    details,
    coherence_score: coherenceScore,
    desire_threshold: thresholdInfo.threshold,
    threshold_explanation: thresholdInfo,
    proactive_state: adjustedProactiveState,
    proactiveState: adjustedProactiveState,
  };
  result.guidance = buildCrossModuleCoherencePrompt(result);
  return result;
}

export function buildCrossModuleCoherencePrompt(validation = {}) {
  if (validation.valid && !(validation.warnings || []).length) return '';
  const details = Array.isArray(validation.details) ? validation.details : [];
  const lines = ['【跨模块一致性·生成前修正】'];
  for (const detail of details) {
    if (detail.code.startsWith('emotion_mismatch')) {
      lines.push('时间感受与语气要来自同一种情绪：担心时收起玩笑，惊喜时不要无依据地敌对。');
    } else if (detail.code.startsWith('proactive_threshold_not_met')) {
      lines.push('当前主动冲动没越过人格阈值，本轮不要发起主动联系。');
    } else if (detail.code.startsWith('proactive_reason_mismatch')) {
      lines.push('主动联系必须沿用真实内在原因；没有足够理由就继续等待。');
    } else if (detail.code.startsWith('self_coherence_low')) {
      lines.push('若回复与过去的自我认识冲突，承认变化或恢复原有立场，不要装作矛盾不存在。');
    } else if (detail.code.startsWith('energy_mismatch')) {
      lines.push('保留情绪方向，但让表达节奏符合当前疲惫程度。');
    }
  }
  lines.push('不要在回复中解释这些模块或参数。');
  return [...new Set(lines)].join('\n');
}

function contactReasonQuality(reason) {
  if (reason == null || reason === '') return 0;
  if (typeof reason === 'string') return reason.trim() ? 0.45 : 0;
  const explicit = Number(reason.weight ?? reason.quality ?? reason.score);
  if (Number.isFinite(explicit)) return clamp01(explicit);
  const type = String(reason.type ?? reason.kind ?? '').toLowerCase();
  if (['recurring_thought', 'memory_surfaced', 'concern', 'unfinished_topic', 'pure_longing'].includes(type)) {
    return type === 'pure_longing' ? 0.75 : 0.65;
  }
  return reason.content ? 0.45 : 0.2;
}

function addIssue(issues, details, code, severity, message, metadata = {}) {
  if (severity === 'error') issues.push(code);
  details.push({ code, severity, message, ...metadata });
}

function looksLikeValidationBundle(value) {
  return Boolean(value) && typeof value === 'object' && (
    'temporalContext' in value
    || 'temporal_context' in value
    || 'proactiveState' in value
    || 'proactive_state' in value
    || 'personalityActive' in value
    || 'personality_active' in value
  );
}

function clamp01(value, fallback = 0) {
  return clamp(value, 0, 1, fallback);
}

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
