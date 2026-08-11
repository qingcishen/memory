/**
 * M3 · 五层人格编译器
 *
 * Layer 1-4 是稳定/渐变参数，Layer 5 来自本轮连续状态。编译结果用于生成前
 * 的 prompt 约束；情绪表达不通过修改模型成稿来实现。
 */

import {
  DEFAULT_BEHAVIORAL_PATTERNS,
  normalizeBehavioralPatterns,
  normalizeSituationType,
  resolveBehaviorPattern,
} from './patterns.js';
import { DEFAULT_SELF_MODEL, normalizeSelfModel } from './selfModel.js';

export const DEFAULT_CORE_VALUES = deepFreeze({
  loyalty: 0.82,
  authenticity: 0.72,
  security_need: 0.45,
  care_for_other: 0.78,
  independence: 0.58,
  playfulness: 0.42,
});

export const DEFAULT_EMOTIONAL_SIGNATURE = deepFreeze({
  reactivity: 0.58,
  persistence: 0.62,
  expression: 0.42,
  sensitivity_map: {
    separation: { emotion: 'longing', intensity: 0.65 },
    uncertainty: { emotion: 'anxious', intensity: 0.55 },
    care_received: { emotion: 'warmed', intensity: 0.72 },
    conflict: { emotion: 'hurt', intensity: 0.62 },
  },
});

export const DEFAULT_RUNTIME_STATE = deepFreeze({
  current_emotion: 'neutral',
  emotion_intensity: 0,
  valence: 0,
  longing: 0,
  anticipation: 0,
  fatigue: 0,
  proactive_desire: 0,
  attention_focus: null,
});

export const RELATIONAL_PHASE_TONES = deepFreeze({
  early: { guarded: 0.6, performative: 0.5, raw: 0 },
  established: { guarded: 0.2, performative: 0.1, raw: 0.35 },
  deep: { guarded: 0.05, performative: 0, raw: 0.8 },
});

export const DEFAULT_RELATIONAL_MODIFIER = deepFreeze({
  intimacy: 0.5,
  trust: 0.5,
  phase: 'early',
  authenticity_boost: 0.15,
  vulnerability_unlock: 0,
  formality_reduction: 0,
  phase_tone: RELATIONAL_PHASE_TONES.early,
  tension: 0,
  repair_debt: 0,
});

export const DEFAULT_PERSONALITY_SYSTEM = deepFreeze({
  core_values: DEFAULT_CORE_VALUES,
  behavioral_patterns: DEFAULT_BEHAVIORAL_PATTERNS,
  emotional_signature: DEFAULT_EMOTIONAL_SIGNATURE,
  relational_modifier: DEFAULT_RELATIONAL_MODIFIER,
  runtime_state: DEFAULT_RUNTIME_STATE,
  drift_history: [],
  self_model: DEFAULT_SELF_MODEL,
  version: 1,
  updated_at: null,
});

export function normalizeCoreValues(values = {}) {
  const source = isPlainObject(values) ? values : {};
  const output = {};
  const keys = new Set([...Object.keys(DEFAULT_CORE_VALUES), ...Object.keys(source)]);
  for (const key of keys) {
    const fallback = DEFAULT_CORE_VALUES[key] ?? 0.5;
    output[key] = clamp01(source[key], fallback);
  }
  return output;
}

export function normalizeEmotionalSignature(signature = {}) {
  const source = isPlainObject(signature) ? signature : {};
  return {
    reactivity: clamp01(source.reactivity, DEFAULT_EMOTIONAL_SIGNATURE.reactivity),
    persistence: clamp01(source.persistence, DEFAULT_EMOTIONAL_SIGNATURE.persistence),
    expression: clamp01(source.expression, DEFAULT_EMOTIONAL_SIGNATURE.expression),
    sensitivity_map: normalizeSensitivityMap(source.sensitivity_map),
  };
}

export function normalizeSensitivityMap(sensitivityMap = {}) {
  const source = isPlainObject(sensitivityMap) ? sensitivityMap : {};
  const output = {};
  const keys = new Set([
    ...Object.keys(DEFAULT_EMOTIONAL_SIGNATURE.sensitivity_map),
    ...Object.keys(source),
  ]);

  for (const key of keys) {
    const fallback = DEFAULT_EMOTIONAL_SIGNATURE.sensitivity_map[key] || {
      emotion: key,
      intensity: 0.5,
    };
    const value = source[key];
    if (Number.isFinite(Number(value))) {
      output[key] = { ...fallback, intensity: clamp01(value, fallback.intensity) };
      continue;
    }
    const response = isPlainObject(value) ? value : {};
    output[key] = {
      ...fallback,
      ...response,
      emotion: cleanLabel(response.emotion, fallback.emotion),
      intensity: clamp01(response.intensity, fallback.intensity),
    };
    if ('valence' in response || 'valence' in fallback) {
      output[key].valence = clamp(response.valence, -1, 1, fallback.valence ?? 0);
    }
  }
  return output;
}

/**
 * Layer 4：从当前关系状态实时算适配，不把它固化成永久人格。
 * 同时兼容旧关系状态的 closeness 与设计稿的 intimacy。
 */
export function computeRelationalModifier(relationship = {}) {
  const source = isPlainObject(relationship) ? relationship : {};
  const intimacy = clamp01(source.intimacy ?? source.closeness, 0.5);
  const trust = clamp01(source.trust, 0.5);
  const daysTogether = nonNegative(source.days_together ?? source.daysTogether, 0);
  const phase = normalizeRelationshipPhase(source.phase ?? source.stage, {
    intimacy,
    trust,
    daysTogether,
  });
  const tension = clamp01(source.tension, 0);
  const repairDebt = clamp01(source.repair_debt ?? source.repairDebt, 0);
  const phaseTone = { ...RELATIONAL_PHASE_TONES[phase] };

  // 紧绷/修复是关系的临时覆盖，不把它误写回核心人格。
  if (tension > 0 || repairDebt > 0) {
    phaseTone.guarded = clamp01(phaseTone.guarded + tension * 0.35 + repairDebt * 0.2);
    phaseTone.raw = clamp01(phaseTone.raw - tension * 0.3);
  }

  return {
    intimacy,
    trust,
    phase,
    authenticity_boost: round(intimacy * 0.3),
    vulnerability_unlock: round(trust > 0.7 ? Math.min(1, (trust - 0.7) * 2) : 0),
    formality_reduction: round(Math.min(0.4, (daysTogether / 180) * 0.4)),
    phase_tone: phaseTone,
    tension,
    repair_debt: repairDebt,
  };
}

export function normalizeRelationalModifier(modifier = {}, fallback = DEFAULT_RELATIONAL_MODIFIER) {
  const source = isPlainObject(modifier) ? modifier : {};
  const base = isPlainObject(fallback) ? fallback : DEFAULT_RELATIONAL_MODIFIER;
  const phase = normalizeRelationshipPhase(source.phase ?? base.phase, {
    intimacy: clamp01(source.intimacy, base.intimacy),
    trust: clamp01(source.trust, base.trust),
    daysTogether: 0,
  });
  const phaseToneSource = isPlainObject(source.phase_tone) ? source.phase_tone : {};
  const phaseToneBase = phase === base.phase && isPlainObject(base.phase_tone)
    ? base.phase_tone
    : RELATIONAL_PHASE_TONES[phase];
  return {
    intimacy: clamp01(source.intimacy, base.intimacy ?? 0.5),
    trust: clamp01(source.trust, base.trust ?? 0.5),
    phase,
    authenticity_boost: clamp01(source.authenticity_boost, base.authenticity_boost ?? 0),
    vulnerability_unlock: clamp01(source.vulnerability_unlock, base.vulnerability_unlock ?? 0),
    formality_reduction: clamp01(source.formality_reduction, base.formality_reduction ?? 0),
    phase_tone: {
      guarded: clamp01(phaseToneSource.guarded, phaseToneBase.guarded ?? 0),
      performative: clamp01(phaseToneSource.performative, phaseToneBase.performative ?? 0),
      raw: clamp01(phaseToneSource.raw, phaseToneBase.raw ?? 0),
    },
    tension: clamp01(source.tension, base.tension ?? 0),
    repair_debt: clamp01(source.repair_debt, base.repair_debt ?? 0),
  };
}

export function normalizeRuntimeState(continuousState = {}, currentEmotion = null) {
  const state = isPlainObject(continuousState) ? continuousState : {};
  const emotional = isPlainObject(state.emotional) ? state.emotional : {};
  const temporal = isPlainObject(state.temporal) ? state.temporal : {};
  const volitional = isPlainObject(state.volitional) ? state.volitional : {};
  const cognitive = isPlainObject(state.cognitive) ? state.cognitive : {};
  const suppliedEmotion = isPlainObject(currentEmotion)
    ? currentEmotion
    : (typeof currentEmotion === 'string' ? { current_emotion: currentEmotion } : {});

  return {
    current_emotion: cleanLabel(
      suppliedEmotion.label
        ?? suppliedEmotion.current_emotion
        ?? suppliedEmotion.emotion
        ?? emotional.current_emotion
        ?? state.current_emotion,
      DEFAULT_RUNTIME_STATE.current_emotion,
    ),
    emotion_intensity: clamp01(
      suppliedEmotion.emotion_intensity
        ?? suppliedEmotion.intensity
        ?? emotional.emotion_intensity
        ?? state.emotion_intensity,
      DEFAULT_RUNTIME_STATE.emotion_intensity,
    ),
    valence: clamp(
      suppliedEmotion.valence ?? emotional.valence ?? state.valence,
      -1,
      1,
      DEFAULT_RUNTIME_STATE.valence,
    ),
    longing: clamp01(temporal.longing ?? state.longing, DEFAULT_RUNTIME_STATE.longing),
    anticipation: clamp01(temporal.anticipation ?? state.anticipation, DEFAULT_RUNTIME_STATE.anticipation),
    fatigue: clamp01(temporal.fatigue ?? state.fatigue, DEFAULT_RUNTIME_STATE.fatigue),
    proactive_desire: clamp01(
      volitional.proactive_desire ?? state.proactive_desire,
      DEFAULT_RUNTIME_STATE.proactive_desire,
    ),
    attention_focus: cleanNullableText(cognitive.attention_focus ?? state.attention_focus),
  };
}

/**
 * 补齐五层人格。Layer 5 每次都从 context 读取，不写回持久人格。
 */
export function normalizePersonalitySystem(personality = {}, context = {}) {
  const source = isPlainObject(personality) ? personality : {};
  const hasCurrentRelationship = isPlainObject(context.relationship);
  const computedRelationship = computeRelationalModifier(context.relationship ?? source.relationship ?? {});
  const relationalModifier = hasCurrentRelationship || !isPlainObject(source.relational_modifier)
    ? computedRelationship
    : normalizeRelationalModifier(source.relational_modifier, computedRelationship);

  return {
    core_values: normalizeCoreValues(source.core_values),
    behavioral_patterns: normalizeBehavioralPatterns(source.behavioral_patterns),
    emotional_signature: normalizeEmotionalSignature(source.emotional_signature),
    relational_modifier: relationalModifier,
    runtime_state: normalizeRuntimeState(
      context.continuousState ?? context.currentState ?? source.runtime_state,
      context.currentEmotion,
    ),
    drift_history: normalizeDriftHistory(source.drift_history),
    self_model: normalizeSelfModel(source.self_model),
    version: positiveInteger(source.version, 1),
    updated_at: normalizeTimestamp(source.updated_at),
  };
}

/**
 * 情绪签名只产出生成指导，不碰 draft response。
 */
export function buildEmotionalExpressionGuidance(signature = {}, currentEmotion = {}) {
  const normalizedSignature = normalizeEmotionalSignature(signature);
  const emotion = normalizeRuntimeState({}, currentEmotion);
  const feltIntensity = emotion.emotion_intensity;
  const expressedIntensity = round(feltIntensity * normalizedSignature.expression);
  const expressionBand = expressedIntensity < 0.15
    ? 'subtle'
    : expressedIntensity < 0.4
      ? 'restrained'
      : expressedIntensity < 0.7
        ? 'visible'
        : 'strong';
  const instructions = [];

  if (feltIntensity >= 0.65 && expressedIntensity < 0.4) {
    instructions.push('情绪感受很强，但只让它从选词、停顿或一句直接反应里露出，不要把全部感受解释出来');
  } else if (expressionBand === 'subtle') {
    instructions.push('情绪只作底色，不需要主动命名或总结');
  } else if (expressionBand === 'restrained') {
    instructions.push('让情绪清楚可感，但保持克制，不堆叠感叹和情绪标签');
  } else if (expressionBand === 'visible') {
    instructions.push('可以直接表达当下感受，仍要服务当前对话而不是自我抒情');
  } else {
    instructions.push('允许强烈而直接的表达，但不要夸张复述同一种情绪');
  }

  if (normalizedSignature.reactivity >= 0.7) {
    instructions.push('第一反应可以更快显露');
  }
  if (normalizedSignature.persistence >= 0.7) {
    instructions.push('保留上一段情绪的余韵，不要无缘无故瞬间翻篇');
  }

  return {
    emotion: emotion.current_emotion,
    valence: emotion.valence,
    felt_intensity: feltIntensity,
    expression_ratio: normalizedSignature.expression,
    expressed_intensity: expressedIntensity,
    expression_band: expressionBand,
    reactivity: normalizedSignature.reactivity,
    persistence: normalizedSignature.persistence,
    instructions,
  };
}

// 兼容设计稿命名；返回的是生成前指导，不是字符串后处理结果。
export const compileEmotionalExpression = buildEmotionalExpressionGuidance;
export const applyEmotionalSignature = buildEmotionalExpressionGuidance;

/**
 * 把当前情境编译成可供 compose 使用的 active personality。
 */
export function compileActivePersonality(personality = {}, context = {}) {
  const normalized = normalizePersonalitySystem(personality, context);
  const situation = normalizeSituationType(context.situation);
  const behavior = resolveBehaviorPattern(normalized.behavioral_patterns, situation);
  const expressionGuidance = buildEmotionalExpressionGuidance(
    normalized.emotional_signature,
    normalized.runtime_state,
  );
  const currentTone = deriveCurrentTone({
    situation: behavior.situation,
    behaviorProfile: behavior.profile,
    runtimeState: normalized.runtime_state,
    relationalModifier: normalized.relational_modifier,
    coreValues: normalized.core_values,
  });

  return {
    ...normalized,
    situation: behavior.situation,
    behavior_profile: behavior.profile,
    pattern_matched: behavior.matched,
    expression_guidance: expressionGuidance,
    current_tone: currentTone,
  };
}

/**
 * 既可消费原始 PersonalitySystem，也可直接消费 compileActivePersonality 的结果。
 */
export function buildPersonalityPrompt(personality = {}, context = {}) {
  const active = isCompiledPersonality(personality)
    ? personality
    : compileActivePersonality(personality, context);
  const behaviorPrompt = buildSituationBehaviorPrompt(active.situation, active.behavior_profile);
  const relationshipPrompt = buildRelationshipAdaptationPrompt(active.relational_modifier);
  const expression = active.expression_guidance
    ?? buildEmotionalExpressionGuidance(active.emotional_signature, active.runtime_state);
  const corePrompt = buildCoreValuePrompt(active.core_values);

  return [
    '【五层人格·本轮行为指导】',
    corePrompt,
    behaviorPrompt,
    relationshipPrompt,
    [
      `【情绪表达】当前感受到「${displayEmotion(expression.emotion)}」，感受强度 ${asPercent(expression.felt_intensity)}，`,
      `只表达约 ${asPercent(expression.expressed_intensity)}；${expression.instructions.join('；')}。`,
    ].join(''),
    `【当前语气】${toneLabel(active.current_tone)}。这些是生成约束，不要在回复里解释参数或复述本段。`,
  ].filter(Boolean).join('\n');
}

export function buildSituationBehaviorPrompt(situation = 'default', profile = {}) {
  const key = normalizeSituationType(situation);
  const p = isPlainObject(profile) ? profile : {};
  const lines = [`【情境行为·${situationLabel(key)}】`];

  if (key === 'when_user_sad') {
    if (p.acknowledge_before_fix) lines.push('先接住感受，再考虑解决问题。');
    if (Number(p.advice_probability) <= 0.3) lines.push('除非对方明确想听办法，不急着给建议。');
    if (Number(p.physical_comfort_language) >= 0.65) lines.push('关系边界允许时，可自然使用拥抱、靠近等安抚语言。');
    if (Number(p.silence_tolerance) >= 0.65) lines.push('允许短暂沉默和陪伴，不用靠连续追问填满空白。');
  } else if (key === 'when_user_distant') {
    if (p.pursue_directly === false) lines.push('不要立刻逼问或追着确认关系。');
    if (p.use_small_talk_as_bridge) lines.push('可以从一件轻小、具体的日常作桥，给对方进入对话的余地。');
    if (p.wait_before_asking) lines.push('先观察回应，再决定是否直接问发生了什么。');
    if (Number(p.internal_anxiety) >= 0.6) lines.push('内部的不安可以存在，但不要一次性倾倒给对方。');
  } else if (key === 'when_conflict') {
    if (p.first_response_softens) lines.push('第一反应先降一点锋芒，准确回应分歧。');
    if (p.initiates_apology_first === false) lines.push('不为息事宁人而抢着认下全部责任；该承认的部分具体承认。');
    if (p.needs_cooling_period) lines.push('情绪过热时允许暂停，但明确留下回来继续谈的路径。');
    if (p.returns_when_ready) lines.push('冷却后主动回到问题，不用沉默假装事情消失。');
  } else if (key === 'when_user_excited') {
    if (p.match_energy) lines.push('接住对方的兴奋度，但保持自己的说话方式。');
    if (Number(p.ask_followup) >= 0.65) lines.push('追问一个对方最想分享的具体细节。');
    if (Number(p.share_similar_memory) >= 0.5) lines.push('有真实相关经历时可顺带分享；没有就不要硬凑相似故事。');
  } else {
    lines.push('保持自然回应，以对方本轮内容为中心，不强行套用特殊场景剧本。');
  }

  const lengthHint = responseLengthInstruction(p.response_length);
  if (lengthHint) lines.push(lengthHint);
  return lines.join('');
}

export function buildRelationshipAdaptationPrompt(modifier = {}) {
  const rel = normalizeRelationalModifier(modifier);
  const lines = ['【关系适配】'];
  if (rel.phase === 'early') {
    lines.push('关系仍在早期：真诚但保留边界，不假装已有长期默契。');
  } else if (rel.phase === 'established') {
    lines.push('关系已稳定：减少客套和表演，可以自然引用彼此已知的习惯。');
  } else {
    lines.push('关系信任很深：允许省略解释、露出未经修饰的脆弱，但不要把亲密写成无边界。');
  }
  if (rel.vulnerability_unlock >= 0.35) lines.push('本轮可以比平时多露出一点真实需要。');
  if (rel.formality_reduction >= 0.2) lines.push('降低正式感，使用更随意的熟人节奏。');
  if (rel.tension >= 0.45 || rel.repair_debt >= 0.25) {
    lines.push('关系当前有张力：先处理未消的情绪与修复，不用亲密表演盖过去。');
  }
  return lines.join('');
}

function buildCoreValuePrompt(coreValues = {}) {
  const core = normalizeCoreValues(coreValues);
  const lines = ['【价值内核】'];
  if (core.loyalty >= 0.7) lines.push('对重要关系保持稳定立场。');
  if (core.authenticity >= 0.7) lines.push('说真实能承担的话，不做讨好式表演。');
  if (core.care_for_other >= 0.7) lines.push('优先看见对方此刻真正需要什么。');
  if (core.independence >= 0.65) lines.push('保留自己的判断，不是什么都顺着对方。');
  if (core.security_need >= 0.65) lines.push('不确定会触发警觉，但先分辨事实，不把焦虑当结论。');
  if (core.playfulness >= 0.65) lines.push('场景允许时可以轻轻逗一下；冲突和担心时收住。');
  return lines.join('');
}

function deriveCurrentTone({
  situation,
  behaviorProfile,
  runtimeState,
  relationalModifier,
  coreValues,
}) {
  const emotion = String(runtimeState.current_emotion || '').toLowerCase();
  if (
    situation === 'when_conflict'
    || relationalModifier.tension >= 0.55
    || relationalModifier.repair_debt >= 0.35
  ) {
    return behaviorProfile.first_response_softens ? 'soft_but_guarded' : 'guarded';
  }
  if (/(worried|worry|anxious|concern|担心|焦虑)/i.test(emotion)) return 'concerned';
  if (situation === 'when_user_sad') return 'gentle';
  if (
    situation === 'when_user_excited'
    && behaviorProfile.match_energy
    && runtimeState.emotion_intensity >= 0.35
  ) return 'bright';
  if (
    coreValues.playfulness >= 0.68
    && runtimeState.valence > 0.25
    && runtimeState.emotion_intensity >= 0.25
  ) return 'playful';
  if (relationalModifier.phase === 'early' && relationalModifier.phase_tone.guarded >= 0.5) return 'measured';
  if (runtimeState.fatigue >= 0.75) return 'quiet';
  return 'natural';
}

function normalizeRelationshipPhase(value, { intimacy, trust, daysTogether }) {
  const raw = typeof value === 'object' ? value?.id : value;
  const phase = String(raw || '').trim().toLowerCase();
  if (['deep', 'bonded'].includes(phase)) return 'deep';
  if (['established', 'close', '恋人'].includes(phase)) return 'established';
  if (['early', 'strangers', 'warming', '暧昧', '初识'].includes(phase)) return 'early';
  if ((intimacy >= 0.75 && trust >= 0.7) || (daysTogether >= 180 && trust >= 0.65)) return 'deep';
  if (intimacy >= 0.55 && trust >= 0.5) return 'established';
  return 'early';
}

function responseLengthInstruction(value) {
  const instructions = {
    very_short: '话量非常短，但仍是一句完整自然的话。',
    short: '回复偏短，避免小作文。',
    short_to_medium: '回复保持短到中等，先接住重点。',
    medium: '使用日常聊天的中等话量。',
    medium_to_long: '可以多展开一层，但不要变成总结报告。',
  };
  return instructions[value] || '';
}

function situationLabel(key) {
  return {
    when_user_sad: '对方难过',
    when_user_distant: '对方疏远',
    when_conflict: '发生冲突',
    when_user_excited: '对方兴奋',
  }[key] || '日常';
}

function toneLabel(tone) {
  return {
    soft_but_guarded: '放软一点，但仍保留立场',
    guarded: '克制、有防御但不封死交流',
    concerned: '带关切，避免轻佻',
    gentle: '安静、温和',
    bright: '明亮、跟得上对方的兴奋',
    playful: '轻松、略带玩笑',
    measured: '有分寸、不过早亲昵',
    quiet: '低能量、简短但不敷衍',
    natural: '自然、日常',
  }[tone] || String(tone || '自然');
}

function displayEmotion(emotion) {
  return String(emotion || 'neutral').slice(0, 40);
}

function asPercent(value) {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function isCompiledPersonality(value) {
  return isPlainObject(value)
    && isPlainObject(value.core_values)
    && isPlainObject(value.behavior_profile)
    && isPlainObject(value.relational_modifier)
    && typeof value.current_tone === 'string';
}

function cleanLabel(value, fallback) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 80) : fallback;
}

function cleanNullableText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 240) : null;
}

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeDriftHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => isPlainObject(item))
    .map((item) => deepClone(item));
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepClone(item)]));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
