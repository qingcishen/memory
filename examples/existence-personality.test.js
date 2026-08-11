// Continuous Existence Engine M3/M4 纯逻辑验收。不连数据库、不调用模型。
import assert from 'node:assert/strict';
import {
  DEFAULT_BEHAVIORAL_PATTERNS,
  normalizeBehavioralPatterns,
  resolveBehaviorPattern,
} from '../src/existence/patterns.js';
import {
  applyEmotionalSignature,
  buildPersonalityPrompt,
  compileActivePersonality,
  computeRelationalModifier,
  normalizePersonalitySystem,
} from '../src/existence/personalityCompiler.js';
import {
  advancePersonalityDrift,
  applyDrift,
  planPersonalityDrift,
} from '../src/existence/personalityDrift.js';
import {
  checkCoherence,
  detectConflicts,
  normalizeSelfModel,
  recordSelfAction,
} from '../src/existence/selfModel.js';
import {
  computeDynamicProactiveThreshold,
  validateCrossModuleCoherence,
} from '../src/existence/coherenceValidator.js';

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  ✓', name);
  passed++;
};

console.log('M3 · 行为模式与五层人格');
{
  const patterns = normalizeBehavioralPatterns({
    when_user_sad: {
      advice_probability: 3,
      silence_tolerance: -2,
    },
    custom_reunion: {
      response_length: 'short',
      warmth: 0.7,
    },
  });
  ok('默认四种行为模式完整保留', Object.keys(DEFAULT_BEHAVIORAL_PATTERNS).every((key) => patterns[key]));
  ok('行为概率被约束在 0-1', patterns.when_user_sad.advice_probability === 1 && patterns.when_user_sad.silence_tolerance === 0);
  ok('局部覆盖不丢默认布尔策略', patterns.when_user_sad.acknowledge_before_fix === true);
  ok('自定义情境可扩展', resolveBehaviorPattern(patterns, 'custom-reunion').profile.warmth === 0.7);

  const normalized = normalizePersonalitySystem({
    core_values: { loyalty: 4, independence: -1 },
    emotional_signature: { expression: 0.38 },
  }, {
    relationship: { closeness: 0.8, trust: 0.9, phase: 'deep', days_together: 90 },
    currentEmotion: { label: 'worried', intensity: 0.9, valence: -0.4 },
  });
  ok('核心价值默认补齐并做边界规范化', normalized.core_values.loyalty === 1
    && normalized.core_values.independence === 0
    && Number.isFinite(normalized.core_values.authenticity));
  ok('Layer 4 关系适配由当前关系实时计算', normalized.relational_modifier.phase === 'deep'
    && normalized.relational_modifier.vulnerability_unlock === 0.4
    && normalized.relational_modifier.formality_reduction === 0.2);
  ok('Layer 5 从本轮情绪读取而非持久化散文', normalized.runtime_state.current_emotion === 'worried'
    && normalized.runtime_state.emotion_intensity === 0.9);

  const persisted = normalizePersonalitySystem({
    drift_history: [{ id: 'd1', progress: 0.5 }],
    self_model: { identity_narrative: ['我很认真'], coherence_score: 0.86 },
    version: 7,
    updated_at: '2026-07-29T02:03:04.000Z',
  });
  ok('持久字段 round-trip 不丢 drift_history/self_model', persisted.drift_history[0].id === 'd1'
    && persisted.self_model.identity_narrative[0] === '我很认真');
  ok('持久字段 round-trip 保留 version/updated_at', persisted.version === 7
    && persisted.updated_at === '2026-07-29T02:03:04.000Z');

  const active = compileActivePersonality({
    behavioral_patterns: {
      when_user_sad: { advice_probability: 0.05, silence_tolerance: 0.95 },
    },
    emotional_signature: { expression: 0.38 },
  }, {
    situation: 'sad',
    relationship: { closeness: 0.82, trust: 0.88, phase: 'deep', days_together: 365 },
    currentEmotion: { label: 'worried', intensity: 0.9, valence: -0.35 },
  });
  ok('active personality 返回统一编译契约', active.current_tone === 'concerned'
    && active.core_values
    && active.behavior_profile
    && active.relational_modifier
    && active.emotional_signature);
  const prompt = buildPersonalityPrompt(active);
  ok('难过情境 prompt 先接感受且不急着建议', prompt.includes('先接住感受') && prompt.includes('不急着给建议'));
  ok('深关系 prompt 降低表演并允许真实脆弱', prompt.includes('关系信任很深') && prompt.includes('真实需要'));

  const guidance = applyEmotionalSignature(
    { expression: 0.38, reactivity: 0.6, persistence: 0.8 },
    { label: 'worried', intensity: 0.9, valence: -0.4 },
  );
  ok('情绪表达强度是感受×签名而非夸张直出', guidance.expressed_intensity === 0.342);
  ok('情绪模块返回生成前指导而非成稿字符串后处理', typeof guidance === 'object'
    && Array.isArray(guidance.instructions)
    && !('raw_response' in guidance));

  const early = computeRelationalModifier({ intimacy: 0.2, trust: 0.3, phase: 'early', days_together: 2 });
  const deep = computeRelationalModifier({ intimacy: 0.9, trust: 0.95, phase: 'deep', days_together: 365 });
  ok('关系深化会提升真实性/脆弱解锁并降低正式感', deep.authenticity_boost > early.authenticity_boost
    && deep.vulnerability_unlock > early.vulnerability_unlock
    && deep.formality_reduction > early.formality_reduction);
}

console.log('M3 · 渐进人格漂移');
{
  const base = normalizePersonalitySystem({
    core_values: { security_need: 0.4, authenticity: 0.6 },
  });
  const plan = planPersonalityDrift(base, { type: 'trust_broken' }, {
    now: '2026-07-01T00:00:00.000Z',
  });
  ok('信任破坏只计划小幅安全需求漂移', plan.delta.security_need === 0.05
    && plan.status === 'scheduled'
    && base.core_values.security_need === 0.4);

  const halfway = advancePersonalityDrift(base, plan, {
    now: '2026-07-04T12:00:00.000Z',
  });
  ok('七天漂移在中点只应用一半', halfway.progress === 0.5
    && halfway.personality.core_values.security_need === 0.425);
  ok('推进漂移不修改原人格/计划', base.core_values.security_need === 0.4 && plan.progress === 0);

  const completed = advancePersonalityDrift(base, plan, {
    now: '2026-07-20T00:00:00.000Z',
  });
  ok('到期后完整应用且状态 completed', completed.personality.core_values.security_need === 0.45
    && completed.status === 'completed');

  const separation = planPersonalityDrift(base, { type: 'long_separation' }, {
    now: '2026-07-01T00:00:00.000Z',
  });
  ok('长期分离留下思念积累印记', separation.state_modifiers.longing_growth_multiplier === 0.08);

  const saves = [];
  const ioPlan = await applyDrift('u1', { type: 'deep_understanding_received' }, {
    now: '2026-07-01T00:00:00.000Z',
    loadPersonality: async () => base,
    savePersonality: async (userId, personality) => saves.push({ userId, personality }),
  });
  ok('applyDrift 的 IO 可注入且只保存计划', ioPlan.delta.authenticity === 0.03
    && saves[0].userId === 'u1'
    && saves[0].personality.core_values.authenticity === 0.6
    && saves[0].personality.active_drifts.length === 1
    && saves[0].personality.drift_history.length === 1);
}

console.log('M4 · 自我模型冲突与调和');
{
  const selfModel = normalizeSelfModel({
    identity_narrative: [
      '我是那种不轻易开口但一开口就认真的人',
      '我在意的人不多，但在意了就是真的在意',
    ],
    identity_anchors: [{
      id: 'independent',
      statement: '我有自己的判断',
      traits: ['independent'],
    }],
    core_beliefs: {
      about_self: ['我不靠冷暴力结束关系'],
      about_relationships: ['冲突后要回来谈'],
      about_the_user: ['他对我很重要'],
    },
    coherence_score: 0.92,
  });
  ok('自我模型补齐三类信念与行为记录', selfModel.core_beliefs.about_relationships.length === 1
    && selfModel.core_beliefs.about_the_user.length === 1
    && Array.isArray(selfModel.recent_actions));

  const conflicts = detectConflicts('随便你吧，我根本不在乎。没你我活不下去，什么都听你的。', selfModel);
  ok('检测关心锚点与冷漠表达冲突', conflicts.some((item) => item.identity_trait === 'caring'));
  ok('检测独立锚点与完全依赖表达冲突', conflicts.some((item) => item.identity_trait === 'independent'));

  const pending = await checkCoherence('我根本不在乎。', selfModel);
  ok('没有调和生成器时保留原稿并明确要求再生成', pending.coherent === false
    && pending.response === '我根本不在乎。'
    && pending.reconciled_response === null
    && pending.requires_reconciliation);

  let reconciliationPayload;
  const reconciled = await checkCoherence('我根本不在乎。', selfModel, { userMessage: '你在乎吗' }, {
    reconcileConflict: async (found, model, context) => {
      reconciliationPayload = { found, model, context };
      return { response: '我之前嘴硬说不在意，但……还是在意了。' };
    },
  });
  ok('冲突通过注入的生成器做自我调和', reconciled.coherent === false
    && reconciled.reconciled_response.includes('还是在意了')
    && reconciliationPayload.found.length > 0);
  ok('冲突会下调自我一致性分数', reconciled.coherence_score < selfModel.coherence_score);

  const afterAction = recordSelfAction(selfModel, {
    id: 'a1',
    type: 'proactive_contact',
    description: '主动发消息问他到家没有',
  }, { coherenceScore: reconciled.coherence_score });
  ok('提交后可记录行为与新一致性分数', afterAction.recent_actions.at(-1).tags.includes('proactive_contact')
    && afterAction.coherence_score === reconciled.coherence_score);
  const actionConflict = detectConflicts('我从来没主动联系过你。', afterAction);
  ok('绝对自述与近期真实行为冲突会被发现', actionConflict.some((item) => item.type === 'recent_action_conflict'));
}

console.log('M4 · 跨模块一致性与动态主动阈值');
{
  const personality = {
    core_values: { independence: 0.82 },
    current_tone: 'playful',
    behavior_profile: {},
    relational_modifier: { tension: 0, repair_debt: 0 },
    runtime_state: { current_emotion: 'worried', longing: 0.4, fatigue: 0.2 },
  };
  const proactive = {
    desire: 0.7,
    contact: true,
    reason: { type: 'concern', weight: 0.8 },
  };
  const threshold = computeDynamicProactiveThreshold(personality, proactive);
  ok('高独立性把主动阈值动态调到 0.75', threshold === 0.75);

  const validation = validateCrossModuleCoherence(
    { anomaly: { type: 'too_slow' } },
    proactive,
    personality,
  );
  ok('担心状态与 playful 语气冲突被检出', validation.issues.includes('emotion_mismatch: worried_state + playful_tone'));
  ok('未跨动态阈值的主动联系被阻止', validation.issues.some((issue) => issue.startsWith('proactive_threshold_not_met'))
    && validation.valid === false);
  ok('验证器返回调高阈值的新状态且不修改输入', validation.proactive_state.desire_threshold === 0.75
    && !('desire_threshold' in proactive));
  ok('跨模块冲突生成的是再生成指导而非改写消息', validation.guidance.includes('时间感受与语气')
    && validation.guidance.includes('不要在回复中解释'));

  const consistent = validateCrossModuleCoherence({
    temporalContext: { anomaly: { type: 'normal' }, longing: 0.4 },
    proactiveState: {
      desire: 0.86,
      contact: true,
      reason: { type: 'unfinished_topic', weight: 0.8 },
    },
    personalityActive: {
      core_values: { independence: 0.82 },
      current_tone: 'natural',
      behavior_profile: {},
      relational_modifier: { tension: 0, repair_debt: 0 },
      runtime_state: { current_emotion: 'neutral', fatigue: 0.2 },
    },
  });
  ok('理由与强度足够时跨模块验证通过', consistent.valid === true && consistent.issues.length === 0);
}

console.log(`\nexistence-personality 全部 ${passed} 条断言通过 ✅`);
