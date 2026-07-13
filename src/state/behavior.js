// B2 · 离散情绪 → 可观察行为策略。纯逻辑，不执行 sleep/投递。
import { PARAMS } from '../params.js';
import { supabase } from '../config.js';

const NEGATIVE_LABELS = new Set(['委屈', '吃醋', '生气', '失落']);

export function behaviorPolicy(label = '平静', state = {}, params = PARAMS.behavior) {
  const configured = params?.policies?.[label] ?? params?.policies?.平静 ?? {};
  const relationship = state?.relationship ?? {};
  const tension = clamp01(relationship.tension);
  const repairDebt = clamp01(relationship.repair_debt);
  const maxDelay = Math.max(0, Number(params?.maxReplyDelayMs) || 10 * 60 * 1000);
  let [min, max] = normalizeDelay(configured.replyDelayMs, maxDelay);

  // 真正和好后，惩罚性观感必须立即消失；情绪标签可短暂保留，但不再拖很久。
  const repaired = repairDebt <= (params?.repairedDebtThreshold ?? 0.05) && tension <= (params?.repairedTensionThreshold ?? 0.1);
  if (repaired && NEGATIVE_LABELS.has(label)) {
    const repairedCap = Math.min(maxDelay, Number(params?.repairedMaxDelayMs) || 1500);
    min = Math.min(min, repairedCap);
    max = Math.min(max, repairedCap);
  }

  const stonewallLimit = Math.max(0, Math.floor(Number(params?.stonewallPerDay) || 0));
  const usedToday = Math.max(0, Math.floor(Number(state?.stonewallUsedToday) || 0));
  const stonewall = label === '生气'
    && tension >= (params?.stonewallTensionThreshold ?? 0.85)
    && repairDebt >= (params?.stonewallRepairDebtThreshold ?? 0.65)
    && usedToday < stonewallLimit
    && !state?.mustGiveRepairStep;

  return {
    replyDelayMs: [min, max],
    partsBudget: clampInt(configured.partsBudget, 1, 8, 2),
    lengthHint: ['terse', 'normal', 'chatty'].includes(configured.lengthHint) ? configured.lengthHint : 'normal',
    proactiveBias: clamp(Number(configured.proactiveBias) || 0, -1, 1),
    stonewall,
    repairStep: Boolean(state?.mustGiveRepairStep),
  };
}

export function behaviorToPrompt(policy) {
  if (!policy) return '';
  if (policy.repairStep) return '【本轮行为】上一轮你看到了但没有回复；这一轮给对方一个温和台阶并正常回应，别再冷处理，也别解释「刚才为什么不回」。';
  if (policy.lengthHint === 'terse') return '【本轮话量】话少一点、收着点，像心情一般时随口回；可以短，但要像一句完整的人话，不要电报体三连，也别解释自己为什么话少。';
  if (policy.lengthHint === 'chatty') return '【本轮话量】兴致比较高，可以自然多说几句或偶尔拆成两条，仍要像即时聊天，别写成小作文。';
  return '【本轮话量】日常聊天长度就好，别刻意挤牙膏，也别突然长篇。';
}

export function normalizeBehaviorState(state = {}, now = Date.now()) {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  return {
    stonewallAt: (state?.stonewallAt ?? []).map((v) => new Date(v)).filter((d) => !Number.isNaN(d.getTime()) && d.getTime() >= dayAgo).map((d) => d.toISOString()),
    mustGiveRepairStep: Boolean(state?.mustGiveRepairStep),
  };
}

export class BehaviorStateStore {
  constructor({ client = supabase, table = 'behavior_state' } = {}) { this.client = client; this.table = table; }
  async load({ userId, companionId = 'default', now = Date.now() } = {}) {
    if (!userId) return normalizeBehaviorState({}, now);
    const { data, error } = await this.client.from(this.table).select('state').eq('user_id', userId).eq('companion_id', companionId).maybeSingle();
    if (error || !data) return normalizeBehaviorState({}, now);
    return normalizeBehaviorState(data.state, now);
  }
  async save(state, { userId, companionId = 'default', now = Date.now() } = {}) {
    const normalized = normalizeBehaviorState(state, now);
    const { error } = await this.client.from(this.table).upsert({ user_id: userId, companion_id: companionId, state: normalized, updated_at: new Date(now).toISOString() }, { onConflict: 'user_id,companion_id' });
    if (error) throw error;
    return normalized;
  }
}

function normalizeDelay(value, cap) {
  const pair = Array.isArray(value) ? value : [0, 0];
  const min = clamp(Math.round(Number(pair[0]) || 0), 0, cap);
  const max = clamp(Math.round(Number(pair[1]) || 0), min, cap);
  return [min, max];
}
function clampInt(value, min, max, fallback) { return Math.round(clamp(Number.isFinite(Number(value)) ? Number(value) : fallback, min, max)); }
function clamp01(value) { return clamp(Number(value) || 0, 0, 1); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
