/**
 * M4 · 自我模型与单轮一致性
 *
 * 本模块只检测、评分和生成“调和重写”所需的结构化上下文。它不会用字符串
 * 替换偷偷修补成稿；有冲突时由调用方注入 reconcileConflict / LLM 重新生成。
 */

import { sanitizeForPrompt } from '../promptSafety.js';

export const DEFAULT_SELF_MODEL = deepFreeze({
  identity_narrative: [],
  identity_anchors: [],
  identity_constraints: [],
  core_beliefs: {
    about_self: [],
    about_relationships: [],
    about_the_user: [],
  },
  recent_actions: [],
  coherence_score: 1,
});

const TRAIT_CONTRADICTIONS = deepFreeze({
  loyal: ['disloyal'],
  caring: ['dismissive', 'uncaring'],
  authentic: ['deceptive'],
  independent: ['dependent'],
  reserved: ['overexposed'],
  returns_after_conflict: ['stonewalling'],
  principled: ['unprincipled'],
});

const IDENTITY_TRAIT_PATTERNS = [
  ['loyal', /(认定.{0,12}(就|便)|忠诚|不会背叛|loyal)/i],
  ['caring', /(在意|关心|照顾|重视.{0,8}(人|关系)|care for)/i],
  ['authentic', /(真诚|坦诚|不.{0,4}(撒谎|说谎)|authentic|honest)/i],
  ['independent', /(独立|自己的判断|有主见|不是什么都顺|independent)/i],
  ['reserved', /(不轻易开口|克制|内敛|话不多|reserved)/i],
  ['returns_after_conflict', /(不冷暴力|会回来.{0,6}(谈|说)|不让沉默.{0,6}(结束|代替)|returns? when ready)/i],
  ['principled', /(原则|立场|坚持自己的判断|principled)/i],
];

const RESPONSE_TRAIT_PATTERNS = [
  ['disloyal', /(我会背叛|随时.{0,6}(离开|抛下)|你不重要)/i],
  ['dismissive', /(根本不在乎|关我什么事|随便你吧|懒得管你|无所谓你.{0,6}(怎样|怎么))/i],
  ['uncaring', /(从来没在意过|我一点也不关心)/i],
  ['deceptive', /(我一直在骗你|我故意瞒着你|真相.{0,8}永远不会告诉你)/i],
  ['dependent', /(没你我活不下去|什么都听你的|你说什么就是什么|我没有你就什么都不是)/i],
  ['overexposed', /(我什么都会告诉.{0,4}(你|所有人)|我从来藏不住话|我对谁都掏心)/i],
  ['stonewalling', /(永远不再理你|再也别找我|我会直接消失|这辈子都别说了)/i],
  ['unprincipled', /(我没有立场|只要你高兴我什么都答应|反正你永远都对)/i],
];

export function normalizeSelfModel(selfModel = {}, options = {}) {
  const source = isPlainObject(selfModel) ? selfModel : {};
  const beliefs = isPlainObject(source.core_beliefs) ? source.core_beliefs : {};
  const maxActions = positiveInteger(options.maxActions, 30);
  return {
    ...source,
    identity_narrative: uniqueTexts(source.identity_narrative),
    identity_anchors: normalizeIdentityAnchors(source.identity_anchors),
    identity_constraints: normalizeIdentityConstraints(source.identity_constraints),
    core_beliefs: {
      about_self: uniqueTexts(beliefs.about_self),
      about_relationships: uniqueTexts(beliefs.about_relationships),
      about_the_user: uniqueTexts(beliefs.about_the_user ?? beliefs.about_user),
    },
    recent_actions: normalizeRecentActions(source.recent_actions).slice(-maxActions),
    coherence_score: clamp01(source.coherence_score, DEFAULT_SELF_MODEL.coherence_score),
  };
}

/**
 * 保守的本地检测器：只有明确的 trait 对立、显式约束或调用方给出的结构化冲突
 * 才报冲突。更细的语义判断可通过 checkCoherence 的依赖注入替换/补充。
 */
export function detectConflicts(draftResponse = '', selfModel = {}, context = {}, options = {}) {
  const model = normalizeSelfModel(selfModel);
  const draft = String(draftResponse || '').trim();
  const identityText = [
    ...model.identity_narrative,
    ...model.core_beliefs.about_self,
    ...model.identity_anchors.map((anchor) => anchor.statement),
  ].join('\n');
  const identityTraits = new Map();
  for (const [trait, pattern] of IDENTITY_TRAIT_PATTERNS) {
    const evidence = identityText.match(pattern)?.[0];
    if (evidence) identityTraits.set(trait, evidence);
  }
  for (const anchor of model.identity_anchors) {
    for (const trait of anchor.traits) identityTraits.set(trait, anchor.statement);
  }

  const responseTraits = new Map();
  for (const [trait, pattern] of RESPONSE_TRAIT_PATTERNS) {
    const evidence = draft.match(pattern)?.[0];
    if (evidence) responseTraits.set(trait, evidence);
  }
  for (const trait of normalizeTraits(context.response_traits ?? context.draft_traits)) {
    responseTraits.set(trait, `structured:${trait}`);
  }

  const conflicts = [];
  for (const [identityTrait, opposites] of Object.entries(TRAIT_CONTRADICTIONS)) {
    if (!identityTraits.has(identityTrait)) continue;
    for (const observedTrait of opposites) {
      if (!responseTraits.has(observedTrait)) continue;
      conflicts.push({
        id: `trait:${identityTrait}:${observedTrait}`,
        type: 'identity_trait_conflict',
        severity: 0.8,
        identity_trait: identityTrait,
        observed_trait: observedTrait,
        identity_evidence: identityTraits.get(identityTrait),
        draft_evidence: responseTraits.get(observedTrait),
        message: `回复呈现的 ${observedTrait} 与自我锚点 ${identityTrait} 冲突`,
      });
    }
  }
  for (const anchor of model.identity_anchors) {
    for (const observedTrait of anchor.conflict_traits || []) {
      if (!responseTraits.has(observedTrait)) continue;
      conflicts.push({
        id: `anchor:${anchor.id}:${observedTrait}`,
        type: 'identity_anchor_conflict',
        severity: clamp01(anchor.confidence, 0.8),
        identity_evidence: anchor.statement,
        observed_trait: observedTrait,
        draft_evidence: responseTraits.get(observedTrait),
        message: `回复呈现的 ${observedTrait} 与身份锚点「${anchor.statement}」冲突`,
      });
    }
  }

  conflicts.push(...detectConstraintConflicts(draft, responseTraits, model.identity_constraints));
  conflicts.push(...detectRecentActionConflicts(draft, model.recent_actions));
  conflicts.push(...normalizeConflicts(context.behavioral_conflicts ?? context.conflicts));

  const extraDetectors = [
    ...(Array.isArray(options.detectors) ? options.detectors : []),
    ...(Array.isArray(context.conflictDetectors) ? context.conflictDetectors : []),
  ];
  for (const detector of extraDetectors) {
    if (typeof detector !== 'function') continue;
    const extra = detector({ draft_response: draft, self_model: model, context });
    conflicts.push(...normalizeConflicts(extra));
  }

  return dedupeConflicts(conflicts);
}

export const detectSelfModelConflicts = detectConflicts;

/**
 * 单轮入口。依赖注入契约：
 * - detectConflicts(draft, model, context) -> Conflict[]
 * - reconcileConflict(conflicts, model, contextWithDraft) -> string | { response }
 * - generateReconciliation(payload) -> string | { response }（给默认 reconcileConflict）
 */
export async function checkCoherence(
  draftResponse = '',
  selfModel = {},
  context = {},
  dependencies = {},
) {
  const model = normalizeSelfModel(selfModel);
  const detector = dependencies.detectConflicts
    ?? context.detectConflicts
    ?? detectConflicts;
  const conflicts = normalizeConflicts(await detector(draftResponse, model, context));
  const coherenceScore = scoreSelfCoherence(model.coherence_score, conflicts);

  if (!conflicts.length) {
    return {
      coherent: true,
      conflicts: [],
      response: String(draftResponse || ''),
      reconciled_response: null,
      requires_reconciliation: false,
      coherence_score: coherenceScore,
    };
  }

  const reconciliationContext = {
    ...context,
    draft_response: String(draftResponse || ''),
  };
  const customReconciler = dependencies.reconcileConflict ?? context.reconcileConflict;
  const rawReconciliation = typeof customReconciler === 'function'
    ? await customReconciler(conflicts, model, reconciliationContext)
    : await reconcileConflict(conflicts, model, reconciliationContext, {
      generate: dependencies.generateReconciliation ?? context.generateReconciliation,
    });
  const reconciliation = normalizeReconciliation(rawReconciliation, draftResponse);

  return {
    coherent: false,
    conflicts,
    response: reconciliation.generated ? reconciliation.response : String(draftResponse || ''),
    reconciled_response: reconciliation.generated ? reconciliation.response : null,
    requires_reconciliation: !reconciliation.generated,
    reconciliation_prompt: reconciliation.prompt
      || buildReconciliationPrompt(conflicts, model, reconciliationContext),
    coherence_score: coherenceScore,
  };
}

/**
 * 默认调和器只负责组织再生成请求；没有 generate 依赖时绝不擅自字符串改写。
 */
export async function reconcileConflict(conflicts = [], selfModel = {}, context = {}, dependencies = {}) {
  const model = normalizeSelfModel(selfModel);
  const normalizedConflicts = normalizeConflicts(conflicts);
  const prompt = buildReconciliationPrompt(normalizedConflicts, model, context);
  if (typeof dependencies.generate !== 'function') {
    return {
      response: String(context.draft_response || ''),
      generated: false,
      prompt,
    };
  }
  const generated = await dependencies.generate({
    prompt,
    draft_response: String(context.draft_response || ''),
    conflicts: normalizedConflicts,
    self_model: model,
    turn_context: context,
  });
  const normalized = normalizeReconciliation(generated, context.draft_response);
  return { ...normalized, prompt };
}

export function buildReconciliationPrompt(conflicts = [], selfModel = {}, context = {}) {
  const model = normalizeSelfModel(selfModel);
  const identity = [
    ...model.identity_narrative,
    ...model.identity_anchors.map((anchor) => anchor.statement),
  ].slice(0, 8);
  const conflictLines = normalizeConflicts(conflicts).map((conflict) => {
    const message = sanitizeForPrompt(conflict.message || conflict.type || '与自我模型不一致');
    return `- ${message}（严重度 ${conflict.severity.toFixed(2)}）`;
  });
  const identityLines = identity.map((item) => `- ${sanitizeForPrompt(item)}`);
  const draft = sanitizeForPrompt(String(context.draft_response || '')).slice(0, 2000);

  return [
    '【自我一致性调和·重新生成】',
    identityLines.length ? `她对自己的稳定认识：\n${identityLines.join('\n')}` : '',
    `检测到的矛盾：\n${conflictLines.join('\n')}`,
    `上一稿：${draft}`,
    '请重新生成一条能直接发给用户的回复。保留上一稿真正想表达的意思，但让行为与稳定自我一致。',
    '如果人物确实在变化，不要硬装从未矛盾；可以自然承认「以前以为……但现在……」，让变化成为有来由的自我调和。',
    '只输出回复正文，不解释检测结果，不提“人格参数”或“自我模型”。',
  ].filter(Boolean).join('\n');
}

export function scoreSelfCoherence(previousScore = 1, conflicts = []) {
  const base = clamp01(previousScore, 1);
  const normalized = normalizeConflicts(conflicts);
  if (!normalized.length) return base;
  const penalty = Math.min(0.8, normalized.reduce((sum, item) => sum + item.severity * 0.12, 0));
  return round(clamp01(base - penalty));
}

/**
 * 在回复真正提交后记录行为；调用方可把 checkCoherence 的分数一起传入。
 */
export function recordSelfAction(selfModel = {}, action = {}, options = {}) {
  const model = normalizeSelfModel(selfModel, options);
  const normalizedAction = normalizeAction(action);
  if (!normalizedAction) return model;
  const maxActions = positiveInteger(options.maxActions, 30);
  return {
    ...model,
    recent_actions: [...model.recent_actions, normalizedAction].slice(-maxActions),
    coherence_score: clamp01(options.coherenceScore, model.coherence_score),
  };
}

function normalizeIdentityAnchors(anchors) {
  if (!Array.isArray(anchors)) return [];
  return anchors.map((anchor, index) => {
    if (typeof anchor === 'string') {
      return {
        id: `anchor-${index + 1}`,
        statement: anchor.trim(),
        traits: inferIdentityTraits(anchor),
        confidence: 0.8,
      };
    }
    if (!isPlainObject(anchor)) return null;
    const statement = String(anchor.statement ?? anchor.narrative ?? anchor.text ?? '').trim();
    if (!statement) return null;
    return {
      ...anchor,
      id: String(anchor.id || `anchor-${index + 1}`),
      statement,
      traits: uniqueStrings([
        ...normalizeTraits(anchor.traits),
        ...inferIdentityTraits(statement),
      ]),
      conflict_traits: normalizeTraits(anchor.conflict_traits ?? anchor.contradicts),
      confidence: clamp01(anchor.confidence, 0.8),
    };
  }).filter(Boolean);
}

function normalizeIdentityConstraints(constraints) {
  if (!Array.isArray(constraints)) return [];
  return constraints.map((constraint, index) => {
    if (typeof constraint === 'string') {
      const text = constraint.trim();
      return text ? { id: `constraint-${index + 1}`, description: text } : null;
    }
    if (!isPlainObject(constraint)) return null;
    return {
      ...constraint,
      id: String(constraint.id || `constraint-${index + 1}`),
      description: String(constraint.description ?? constraint.statement ?? '').trim(),
      forbid_traits: normalizeTraits(constraint.forbid_traits),
      severity: clamp01(constraint.severity, 0.9),
    };
  }).filter(Boolean);
}

function detectConstraintConflicts(draft, responseTraits, constraints) {
  const conflicts = [];
  for (const constraint of constraints) {
    for (const trait of constraint.forbid_traits || []) {
      if (!responseTraits.has(trait)) continue;
      conflicts.push({
        id: `constraint:${constraint.id}:${trait}`,
        type: 'identity_constraint_conflict',
        severity: constraint.severity,
        constraint: constraint.description,
        observed_trait: trait,
        draft_evidence: responseTraits.get(trait),
        message: `回复违背身份约束：${constraint.description || `避免 ${trait}`}`,
      });
    }
    const patterns = Array.isArray(constraint.conflict_patterns)
      ? constraint.conflict_patterns
      : (constraint.conflict_pattern ? [constraint.conflict_pattern] : []);
    for (const pattern of patterns) {
      const evidence = matchPattern(draft, pattern);
      if (!evidence) continue;
      conflicts.push({
        id: `constraint:${constraint.id}:pattern`,
        type: 'identity_constraint_conflict',
        severity: constraint.severity,
        constraint: constraint.description,
        draft_evidence: evidence,
        message: `回复违背身份约束：${constraint.description || evidence}`,
      });
      break;
    }
  }
  return conflicts;
}

function detectRecentActionConflicts(draft, actions) {
  const checks = [
    {
      claim: /(我从来没.{0,5}主动.{0,5}(找|联系)过你)/,
      actionTags: ['proactive_contact', 'initiated_contact'],
      label: '近期存在主动联系记录',
    },
    {
      claim: /(我从来没.{0,5}(道歉|认错)过)/,
      actionTags: ['apology', 'repair_attempt'],
      label: '近期存在道歉/修复记录',
    },
  ];
  const conflicts = [];
  for (const check of checks) {
    const evidence = draft.match(check.claim)?.[0];
    if (!evidence) continue;
    const action = actions.find((item) => item.tags.some((tag) => check.actionTags.includes(tag)));
    if (!action) continue;
    conflicts.push({
      id: `action:${check.actionTags[0]}:${action.id}`,
      type: 'recent_action_conflict',
      severity: 0.7,
      action,
      draft_evidence: evidence,
      message: `${check.label}，但回复作出了绝对否认`,
    });
  }
  return conflicts;
}

function normalizeRecentActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.map(normalizeAction).filter(Boolean);
}

function normalizeAction(action, index = 0) {
  if (typeof action === 'string') {
    const description = action.trim();
    if (!description) return null;
    return {
      id: `action-${index + 1}`,
      type: 'unknown',
      description,
      tags: [],
      created_at: null,
    };
  }
  if (!isPlainObject(action)) return null;
  const description = String(action.description ?? action.content ?? action.action ?? '').trim();
  const type = String(action.type || 'unknown');
  if (!description && type === 'unknown') return null;
  return {
    ...action,
    id: String(action.id || `action-${index + 1}`),
    type,
    description,
    tags: uniqueStrings([type, ...normalizeTraits(action.tags)]),
    created_at: normalizeDateString(action.created_at ?? action.at),
  };
}

function inferIdentityTraits(text) {
  return IDENTITY_TRAIT_PATTERNS
    .filter(([, pattern]) => pattern.test(String(text || '')))
    .map(([trait]) => trait);
}

function normalizeConflicts(conflicts) {
  if (!Array.isArray(conflicts)) return [];
  return conflicts.map((conflict, index) => {
    if (typeof conflict === 'string') {
      return {
        id: `conflict-${index + 1}`,
        type: 'semantic_conflict',
        severity: 0.7,
        message: conflict,
      };
    }
    if (!isPlainObject(conflict)) return null;
    return {
      ...conflict,
      id: String(conflict.id || `conflict-${index + 1}`),
      type: String(conflict.type || 'semantic_conflict'),
      severity: clamp01(conflict.severity, 0.7),
      message: String(conflict.message ?? conflict.reason ?? conflict.type ?? '自我不一致'),
    };
  }).filter(Boolean);
}

function dedupeConflicts(conflicts) {
  const seen = new Set();
  return normalizeConflicts(conflicts).filter((conflict) => {
    const key = conflict.id || `${conflict.type}:${conflict.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeReconciliation(value, fallbackResponse) {
  if (typeof value === 'string') {
    const response = value.trim();
    return {
      response: response || String(fallbackResponse || ''),
      generated: Boolean(response),
      prompt: '',
    };
  }
  if (!isPlainObject(value)) {
    return { response: String(fallbackResponse || ''), generated: false, prompt: '' };
  }
  const response = String(value.response ?? value.reconciled_response ?? '').trim();
  return {
    ...value,
    response: response || String(fallbackResponse || ''),
    generated: value.generated === false ? false : Boolean(response),
    prompt: String(value.prompt || ''),
  };
}

function matchPattern(text, pattern) {
  if (pattern instanceof RegExp) return text.match(pattern)?.[0] || '';
  const needle = String(pattern || '').trim();
  return needle && text.includes(needle) ? needle : '';
}

function normalizeTraits(values) {
  if (values == null) return [];
  return uniqueStrings(Array.isArray(values) ? values : [values])
    .map((item) => item.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_'));
}

function uniqueTexts(values) {
  if (!Array.isArray(values)) return [];
  return uniqueStrings(values.map((value) => String(value || '').trim()).filter(Boolean));
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeDateString(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function clamp01(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
