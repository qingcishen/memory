// Life · 生命/身体状态维度。
//
// L2 扩展为 energy/satiety/health + 作息。读取失败时降级到默认身体状态,
// 避免状态层影响主对话链路可用性。

import { supabase } from '../config.js';
import { currentActivity, parseSleepWindow, shanghaiWallClock } from './activity.js';
import { maybeFallSick, detectCare, applyCare, isSick, isLateNight, updateLateNightStreak } from './health.js';

const HOUR = 1000 * 60 * 60;
const FIELD_RANGE = {
  energy: [0, 1],
  satiety: [0, 1],
  health: [0, 1],
};
const MAX_LATE_NIGHT_STREAK = 30;

export function defaultLifeState() {
  return {
    energy: 0.6,
    satiety: 0.6,
    health: 1.0,
    current_activity: null,
    last_slept_at: null,
    sick_until: null,
    // P2: 连续熬夜天数 + 最近一次熬夜的日期(见 src/state/health.js updateLateNightStreak)
    late_night_streak: 0,
    last_late_night_day: null,
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
    late_night_streak: clamp(Math.round(num(state.late_night_streak, d.late_night_streak)), 0, MAX_LATE_NIGHT_STREAK),
    last_late_night_day: textOrNull(state.last_late_night_day ?? d.last_late_night_day),
    updated_at: textOrNull(state.updated_at),
  };
}

/** M1 状态 -> life 维度。L1 只把 mood.arousal 迁到这里。 */
export function moodToLife(state = {}) {
  return clampLife({ energy: state?.mood?.arousal });
}

export async function readLifeState(userId, companionId = 'default') {
  if (!userId) return { ...defaultLifeState(), updated_at: null };
  const { data, error } = await supabase
    .from('life_state')
    .select('energy, satiety, health, current_activity, last_slept_at, sick_until, late_night_streak, last_late_night_day, updated_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .maybeSingle();
  if (error || !data) return { ...defaultLifeState(), updated_at: null };
  return clampLife(data);
}

export async function writeLifeState(userId, companionId = 'default', state) {
  if (!userId) throw new Error('writeLifeState 需要 userId');
  const s = clampLife(state);
  const row = {
    user_id: userId,
    companion_id: companionId,
    energy: s.energy,
    satiety: s.satiety,
    health: s.health,
    current_activity: s.current_activity,
    last_slept_at: s.last_slept_at,
    sick_until: s.sick_until,
    late_night_streak: s.late_night_streak,
    last_late_night_day: s.last_late_night_day,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('life_state').upsert(row, { onConflict: 'user_id,companion_id' }).select().single();
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
  const hour = shanghaiWallClock(now).getUTCHours();
  const baseline = circadianEnergyBaseline(hour);
  const satiety = clamp(s.satiety - elapsed * 0.08, 0.08, 1);
  const energyTowardBaseline = decayToward(s.energy, baseline, elapsed, 3);
  const energy = clamp(energyTowardBaseline * (0.65 + s.health * 0.35), 0, 1);
  return clampLife({ ...s, energy, satiety, health: s.health });
}

/** 把精力状态翻译成表现指引, 注入 system; 别让她直接报数值。 */
export function toLifePrompt(state, now = Date.now()) {
  if (!state) return '';
  const s = clampLife(state);
  const energy = s.energy > 0.7 ? '很有兴致' : s.energy < 0.3 ? '有些没精神' : '状态一般';
  const satiety = s.satiety < 0.25 ? '有点饿了' : s.satiety > 0.85 ? '刚吃饱很满足' : '';
  const health = s.health < 0.55 ? '身体有点不舒服' : s.health < 0.8 ? '身体状态不算满格' : '';
  const parts = [`你现在${energy}`];
  if (satiety) parts.push(satiety);
  if (health) parts.push(health);
  let line = `${parts.join(', ')}。让它自然影响语气和话量, 别明说自己的身体状态。`;
  // L4: 生病态(sick_until 未到)措辞升级, 盖过普通的"状态一般"。
  if (isSick(s, now)) {
    line = '你现在生病了, 有点难受、没力气, 说话也提不起劲、容易撒娇想被照顾。让它自然影响语气和话量, 别报数值。';
  }
  // L3: 自然带上"此刻在做什么"(她有自己的一天, 可顺口提一句), 别报数值。
  if (s.current_activity) line += `\n你这会儿${s.current_activity}, 聊起来可以自然带一句你在忙的事, 但别硬凑。`;
  return line;
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
  constructor({
    userId,
    companionId = 'default',
    read = readLifeState,
    write = writeLifeState,
    now = () => Date.now(),
    activityFn = currentActivity, // L3: 可注入, 测试时换成确定函数
    rng = Math.random, // L4: 可注入, 测试时换成固定值
    lifeConfig = null, // P2: 角色专属身体参数 (companions/*.json 的 life: {sleep, sick_probability})
  } = {}) {
    this.userId = userId;
    this.companionId = companionId;
    this.read = read;
    this.write = write;
    this.now = now;
    this.activityFn = activityFn;
    this.rng = rng;
    this.sleepWindow = parseSleepWindow(lifeConfig?.sleep);
    this.sickProbability = lifeConfig?.sick_probability;
  }

  async current() {
    const state = this.userId ? await this.read(this.userId, this.companionId) : clampLife(defaultLifeState());
    const hours = state.updated_at ? Math.max(0, (this.now() - new Date(state.updated_at).getTime()) / HOUR) : 0;
    const decayed = decayLife(state, hours, this.now());
    // L3: 派生此刻在做什么 (只读, 不写库; 生病时 activityFn 会覆盖为休息)
    const activity = this.activityFn(this.now(), {
      userId: this.userId,
      companionId: this.companionId,
      sickUntil: decayed.sick_until,
    });
    return { ...decayed, current_activity: activity };
  }

  /**
   * L4: 演变 life, 并把"生病/被照顾"对【情绪/关系】的影响作为耦合增量回传
   * (由 src/memory.js 统一并进 affect 状态机落库, 避免双写竞态)。
   * @returns { moodDelta, relationshipDelta, careEvent } —— 无事件时各为 null
   */
  async evolve(turns = []) {
    if (!this.userId) return { moodDelta: null, relationshipDelta: null, careEvent: null };
    const now = this.now();
    let state = await this.current();
    let moodDelta = null;
    let relationshipDelta = null;
    let careEvent = null;

    // P2: 维护"连续熬夜天数"——这一轮对话发生在角色专属睡眠时段内才算一次熬夜
    const lateNightNow = turns.length > 0 && isLateNight(now, this.sleepWindow);
    state = { ...state, ...updateLateNightStreak(state, now, lateNightNow) };

    // 自动发病(熬夜抬概率; P2: sickProbability 按角色覆盖、连续熬夜达标翻倍)
    const fell = maybeFallSick(state, now, this.rng, 24, { sickProbability: this.sickProbability });
    if (fell.sick) {
      state = fell.state;
      moodDelta = mergeMood(moodDelta, fell.moodDelta);
    }
    // 病中被关心 → 加速康复 + 暖意/亲密增量 + careEvent
    const care = detectCare(turns);
    if (care.cared && isSick(state, now)) {
      const applied = applyCare(state, now, care.hits);
      if (applied.applied) {
        state = applied.state;
        moodDelta = mergeMood(moodDelta, applied.moodDelta);
        relationshipDelta = applied.relationshipDelta;
        careEvent = applied.careEvent;
      }
    }
    // 重新派生活动(生病/康复会改变), 固化进库
    state = { ...state, current_activity: this.activityFn(now, { userId: this.userId, companionId: this.companionId, sickUntil: state.sick_until }) };
    await this.write(this.userId, this.companionId, state);
    return { moodDelta, relationshipDelta, careEvent };
  }

  /** L3: 定时推进 —— 把派生的活动/衰减固化进库 (无对话时也让"她的一天"在走)。 */
  async tickActivity() {
    if (!this.userId) return undefined;
    const current = await this.current();
    return this.write(this.userId, this.companionId, current);
  }

  toPrompt(state) {
    return toLifePrompt(state, this.now());
  }

  samplingHints(state) {
    return lifeSamplingHints(state);
  }
}

// ---- helpers (纯) ----
/** L4: 合并两个 moodDelta ({mood:{valence,arousal}}); 任一为空返回另一个。 */
function mergeMood(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    mood: {
      valence: (a.mood?.valence ?? 0) + (b.mood?.valence ?? 0),
      arousal: (a.mood?.arousal ?? 0) + (b.mood?.arousal ?? 0),
    },
  };
}

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
