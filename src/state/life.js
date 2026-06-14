// Life · 生命/身体状态维度。
//
// L2 扩展为 energy/satiety/health + 作息。读取失败时降级到默认身体状态,
// 避免状态层影响主对话链路可用性。

import { supabase } from '../config.js';

const HOUR = 1000 * 60 * 60;
const FIELD_RANGE = {
  energy: [0, 1],
  satiety: [0, 1],
  health: [0, 1],
};

export function defaultLifeState() {
  return {
    energy: 0.6,
    satiety: 0.6,
    health: 1.0,
    current_activity: null,
    last_slept_at: null,
    sick_until: null,
  };
}

/** 裁剪到合法范围, 缺字段补中值。 */
export function clampLife(state = {}) {
  const d = defaultLifeState();
  return {
    energy: clampField('energy', state.energy ?? d.energy),
    satiety: clampField('satiety', state.satiety ?? d.satiety),
    health: clampField('health', state.health ?? d.health),
    current_activity: textOrNull(state.current_activity ?? d.current_activity),
    last_slept_at: textOrNull(state.last_slept_at ?? d.last_slept_at),
    sick_until: textOrNull(state.sick_until ?? d.sick_until),
    updated_at: textOrNull(state.updated_at),
  };
}

/** M1 状态 -> life 维度。L1 只把 mood.arousal 迁到这里。 */
export function moodToLife(state = {}) {
  return clampLife({ energy: state?.mood?.arousal });
}

export async function readLifeState(userId) {
  if (!userId) return { ...defaultLifeState(), updated_at: null };
  const { data, error } = await supabase
    .from('life_state')
    .select('energy, satiety, health, current_activity, last_slept_at, sick_until, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return { ...defaultLifeState(), updated_at: null };
  return clampLife(data);
}

export async function writeLifeState(userId, state) {
  if (!userId) throw new Error('writeLifeState 需要 userId');
  const s = clampLife(state);
  const row = {
    user_id: userId,
    energy: s.energy,
    satiety: s.satiety,
    health: s.health,
    current_activity: s.current_activity,
    last_slept_at: s.last_slept_at,
    sick_until: s.sick_until,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('life_state').upsert(row, { onConflict: 'user_id' }).select().single();
  if (error) throw error;
  return clampLife(data ?? row);
}

/** 把精力状态翻译成表现指引, 注入 system; 别让她直接报数值。 */
export function toLifePrompt(state) {
  if (!state) return '';
  const s = clampLife(state);
  const energy = s.energy > 0.7 ? '很有兴致' : s.energy < 0.3 ? '有些没精神' : '状态一般';
  return `你现在${energy}。让它自然影响语气和话量, 别明说自己的身体状态。`;
}

/** life.energy -> 采样参数。低 energy 时短、平、温度低; 高 energy 时长、活、温度高。 */
export function lifeSamplingHints(state) {
  const s = clampLife(state);
  const temperature = round(clamp(0.7 + s.energy * 0.4, 0.6, 1.15), 2);
  return {
    temperature,
    maxTokens: s.energy < 0.3 ? 220 : s.energy > 0.75 ? 650 : 500,
  };
}

/** 状态层内部维度门面。 */
export class LifeDimension {
  constructor({ userId, read = readLifeState, write = writeLifeState, now = () => Date.now() } = {}) {
    this.userId = userId;
    this.read = read;
    this.write = write;
    this.now = now;
  }

  async current() {
    return this.userId ? this.read(this.userId) : clampLife(defaultLifeState());
  }

  async evolve() {}

  toPrompt(state) {
    return toLifePrompt(state);
  }

  samplingHints(state) {
    return lifeSamplingHints(state);
  }
}

// ---- helpers (纯) ----
function clampField(field, value) {
  const [lo, hi] = FIELD_RANGE[field];
  return clamp(num(value, (lo + hi) / 2), lo, hi);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function textOrNull(value) {
  return value == null ? null : String(value);
}

function round(value, digits) {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}
