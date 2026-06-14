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

export function circadianEnergyBaseline(hourOfDay) {
  const h = ((Number(hourOfDay) % 24) + 24) % 24;
  if (h < 5) return 0.22;
  if (h < 8) return lerp(0.35, 0.62, (h - 5) / 3);
  if (h < 12) return lerp(0.65, 0.82, (h - 8) / 4);
  if (h < 18) return 0.78;
  if (h < 22) return lerp(0.72, 0.52, (h - 18) / 4);
  return 0.38;
}

export function decayLife(state = {}, hours = 0, now = Date.now()) {
  const s = clampLife(state);
  const elapsed = Math.max(0, Number(hours) || 0);
  const hour = new Date(now).getHours();
  const baseline = circadianEnergyBaseline(hour);
  const satiety = clamp(s.satiety - elapsed * 0.08, 0.08, 1);
  const energyTowardBaseline = decayToward(s.energy, baseline, elapsed, 3);
  const energy = clamp(energyTowardBaseline * (0.65 + s.health * 0.35), 0, 1);
  return clampLife({ ...s, energy, satiety, health: s.health });
}

/** 把精力状态翻译成表现指引, 注入 system; 别让她直接报数值。 */
export function toLifePrompt(state) {
  if (!state) return '';
  const s = clampLife(state);
  const energy = s.energy > 0.7 ? '很有兴致' : s.energy < 0.3 ? '有些没精神' : '状态一般';
  const satiety = s.satiety < 0.25 ? '有点饿了' : s.satiety > 0.85 ? '刚吃饱很满足' : '';
  const health = s.health < 0.55 ? '身体有点不舒服' : s.health < 0.8 ? '身体状态不算满格' : '';
  const parts = [`你现在${energy}`];
  if (satiety) parts.push(satiety);
  if (health) parts.push(health);
  return `${parts.join(', ')}。让它自然影响语气和话量, 别明说自己的身体状态。`;
}

/** life.energy -> 采样参数。低 energy 时短、平、温度低; 高 energy 时长、活、温度高。 */
export function lifeSamplingHints(state) {
  const s = clampLife(state);
  const healthDrag = s.health < 0.8 ? (0.8 - s.health) * 0.35 : 0;
  const temperature = round(clamp(0.7 + s.energy * 0.4 - healthDrag, 0.55, 1.15), 2);
  const baseMaxTokens = s.energy < 0.3 ? 220 : s.energy > 0.75 ? 650 : 500;
  const healthLimit = s.health < 0.55 ? 260 : s.health < 0.8 ? 380 : baseMaxTokens;
  return {
    temperature,
    maxTokens: Math.min(baseMaxTokens, healthLimit),
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
    const state = this.userId ? await this.read(this.userId) : clampLife(defaultLifeState());
    const hours = state.updated_at ? Math.max(0, (this.now() - new Date(state.updated_at).getTime()) / HOUR) : 0;
    return decayLife(state, hours, this.now());
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

function decayToward(value, baseline, hours, halfLife) {
  if (!(hours > 0)) return value;
  const factor = Math.pow(0.5, hours / halfLife);
  return baseline + (value - baseline) * factor;
}

function lerp(from, to, t) {
  return from + (to - from) * clamp(t, 0, 1);
}

function textOrNull(value) {
  return value == null ? null : String(value);
}

function round(value, digits) {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}
