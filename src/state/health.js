// L4 · 健康/生病闭环 (见 docs/appearance-life-design.md 第三部分 §5)。
//
// 纯逻辑, 无 IO。由 LifeDimension.evolve 在演变时调用:
//   maybeFallSick  低频自动发病(熬夜抬概率) → 压 health/设 sick_until + 产出心情下跌增量
//   detectCare     从对方的话里嗅出"关心"(多喝水/早点睡/心疼…)
//   applyCare      病中被关心 → 提前康复 + 加 health + 产出 valence/亲密 增量 + 一个 careEvent
//
// 关键: health/sick_until 写进 life_state; 而生病/被照顾对【情绪/关系】的影响走"耦合增量"
// 回传给 affect 状态机统一落库(见 src/memory.js 的编排), 避免两条持久化路径互相覆盖。

import { PARAMS } from '../config.js';
import { minutesInRange, dateKey, shanghaiWallClock } from './activity.js';

const HOUR = 1000 * 60 * 60;
const DAY = HOUR * 24;

/** 此刻是否在病中。 */
export function isSick(state, now = Date.now()) {
  return !!state?.sick_until && new Date(state.sick_until).getTime() > now;
}

/** 距上次睡觉的小时数; 没有记录返回 null(不判熬夜)。 */
function hoursSinceSleep(state, now) {
  if (!state?.last_slept_at) return null;
  return Math.max(0, (now - new Date(state.last_slept_at).getTime()) / HOUR);
}

/** 此刻(Asia/Shanghai 挂钟时间)是否落在角色专属睡眠时段内。sleepWindow 为 {from,to}(分钟, 见 scheduler.parseSleepWindow); 未配置则总是 false。 */
export function isLateNight(now, sleepWindow) {
  if (!sleepWindow) return false;
  const d = shanghaiWallClock(now);
  return minutesInRange(d.getUTCHours() * 60 + d.getUTCMinutes(), sleepWindow.from, sleepWindow.to);
}

/**
 * P2: 维护"连续熬夜天数"。"熬夜"重定义为"在角色专属睡眠时段内还在对话"(避开已死的 last_slept_at)。
 * 与上次熬夜日相邻的下一天 → streak+1; 同一天内重复命中不重复计数; 中断过 → 重新计 1。
 * 这一步不是熬夜则原样透传(留给下次熬夜时按日期间隔判定是否连续)。
 * @returns { late_night_streak, last_late_night_day }
 */
export function updateLateNightStreak(state, now, isLateNightNow) {
  const streak = Math.max(0, Number(state?.late_night_streak) || 0);
  const lastDay = state?.last_late_night_day ?? null;
  if (!isLateNightNow) return { late_night_streak: streak, last_late_night_day: lastDay };

  const today = dateKey(new Date(now));
  if (today === lastDay) return { late_night_streak: streak, last_late_night_day: lastDay };

  const yesterday = dateKey(new Date(now - DAY));
  return { late_night_streak: lastDay === yesterday ? streak + 1 : 1, last_late_night_day: today };
}

/**
 * 可能发病。已在病中则不重复发病。
 * @param state life 状态
 * @param now 时间戳
 * @param rng 注入的 [0,1) 随机(默认 Math.random; 测试注入固定值)
 * @param stepHours 距上次演变的时长(把"日概率"折算到这一步; 默认按一整天算一次, 给 1 步=1 天的近似)
 * @param opts { sickProbability? } —— P2: 按角色覆盖 baseDailySickProb (companions/*.json 的 life.sick_probability)
 * @returns { sick:boolean, state, moodDelta }
 */
export function maybeFallSick(state, now = Date.now(), rng = Math.random, stepHours = 24, opts = {}) {
  const h = PARAMS.health;
  if (isSick(state, now)) return { sick: false, state, moodDelta: null };

  // 日概率 → 本步概率(按时长线性近似, 夹在 [0,1])
  const dailyProb = opts.sickProbability ?? h.baseDailySickProb;
  let prob = Math.min(1, dailyProb * (Math.max(0, stepHours) / 24));
  // 熬夜抬概率(距上次睡觉过久)
  const sinceSleep = hoursSinceSleep(state, now);
  if (sinceSleep != null && sinceSleep > h.sleepDeprivationHours) prob = Math.min(1, prob * h.staleupMultiplier);
  // P2: 连续熬夜(对话发生在角色专属睡眠时段)达标后概率翻倍
  if ((state?.late_night_streak ?? 0) >= h.lateNightStreakForDouble) prob = Math.min(1, prob * h.lateNightStreakMultiplier);

  if (rng() >= prob) return { sick: false, state, moodDelta: null };

  // 发病: 设 sick_until、压 health
  const jitter = (rng() * 2 - 1) * h.sickDurationJitterHours;
  const durationH = Math.max(6, h.sickDurationHours + jitter);
  const next = {
    ...state,
    health: clamp01(num(state.health, 1) - h.onsetHealthDrop),
    sick_until: new Date(now + durationH * HOUR).toISOString(),
  };
  return {
    sick: true,
    state: next,
    moodDelta: { mood: { valence: -h.onsetValenceDrop, arousal: -h.onsetArousalDrop } },
  };
}

const CARE_RE = /多喝(点)?水|早(点|些)?睡|按时吃药|吃(点|颗)?药|多(休息|喝水)|好好休息|注意身体|照顾好自己|心疼|抱抱|乖乖(休息|养病)|别(累着|熬夜)|盖好被子|喝点?热的|养病|快点好起来|保重/;

/** 从对方(user)的话里嗅"关心"。@returns { cared:boolean, hits:string[] } */
export function detectCare(turns = []) {
  const text = (turns ?? [])
    .filter((t) => t.role === 'user')
    .map((t) => String(t.content ?? ''))
    .join('\n');
  const hits = [];
  let m;
  const re = new RegExp(CARE_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    hits.push(m[0]);
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return { cared: hits.length > 0, hits: [...new Set(hits)] };
}

/**
 * 病中被关心 → 加速康复 + 产出情绪/关系耦合增量 + careEvent(供写 dyad 记忆)。
 * 不在病中则不触发(关心一个没病的人不产生康复闭环, 但调用方仍可有其它温情逻辑)。
 * @returns { applied:boolean, state, moodDelta, relationshipDelta, careEvent }
 */
export function applyCare(state, now = Date.now(), careHits = []) {
  const h = PARAMS.health;
  if (!isSick(state, now)) return { applied: false, state, moodDelta: null, relationshipDelta: null, careEvent: null };

  const newSickUntil = new Date(new Date(state.sick_until).getTime() - h.careRecoverHours * HOUR).toISOString();
  const next = {
    ...state,
    health: clamp01(num(state.health, 0.6) + h.careHealthGain),
    sick_until: newSickUntil,
  };
  return {
    applied: true,
    state: next,
    moodDelta: { mood: { valence: h.careValenceGain, arousal: 0 } },
    relationshipDelta: { relationship: { closeness: h.careClosenessGain, trust: h.careTrustGain } },
    careEvent: { hits: careHits, at: new Date(now).toISOString() },
  };
}

// ---- helpers ----
function num(v, d = 0) {
  const n = Number(v);
  return Number.isNaN(n) ? d : n;
}
function clamp01(x) {
  return Math.min(1, Math.max(0, Number(x) || 0));
}
