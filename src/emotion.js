// Emotion · 双层情绪子系统。
//
// baseline 是角色/性格底色, transient 是当前可观测状态; 读取时按半衰期回归基线。
// 对外接口对齐编排器: current / update / toPrompt / samplingHints。

import { supabase, llm, LLM_MODEL, PARAMS } from './config.js';

const HOUR = 1000 * 60 * 60;
const DEFAULT_BASELINE = { valence: 0.15, energy: 0.5, warmth: 0.5 };
const FIELD_RANGE = {
  valence: [-1, 1],
  energy: [0, 1],
  warmth: [0, 1],
};

export function defaultEmotion() {
  const p = PARAMS.emotion ?? {};
  return clampEmotion({
    baseline: {
      valence: p.baseline?.valence ?? DEFAULT_BASELINE.valence,
      energy: p.baseline?.energy ?? DEFAULT_BASELINE.energy,
      warmth: p.baseline?.warmth ?? DEFAULT_BASELINE.warmth,
    },
    halfLifeHours: p.halfLifeHours ?? 6,
    valence: p.baseline?.valence ?? DEFAULT_BASELINE.valence,
    energy: p.baseline?.energy ?? DEFAULT_BASELINE.energy,
    warmth: p.baseline?.warmth ?? DEFAULT_BASELINE.warmth,
    updated_at: null,
  });
}

export function clampEmotion(state = {}) {
  const d = defaultEmotionRaw();
  const baseline = { ...d.baseline, ...(state.baseline ?? {}) };
  const s = {
    baseline: {
      valence: clampField('valence', baseline.valence),
      energy: clampField('energy', baseline.energy),
      warmth: clampField('warmth', baseline.warmth),
    },
    halfLifeHours: positiveNumber(state.halfLifeHours, d.halfLifeHours),
    valence: clampField('valence', state.valence ?? baseline.valence),
    energy: clampField('energy', state.energy ?? baseline.energy),
    warmth: clampField('warmth', state.warmth ?? baseline.warmth),
    updated_at: state.updated_at ?? null,
  };
  return s;
}

export function decayEmotion(state, now = Date.now()) {
  const s = clampEmotion(state);
  if (!s.updated_at) return s;
  const hours = Math.max(0, (now - new Date(s.updated_at).getTime()) / HOUR);
  return decayEmotionByHours(s, hours);
}

export function decayEmotionByHours(state, hours) {
  const s = clampEmotion(state);
  const halfLives = normalizeHalfLives(s.halfLifeHours);
  return clampEmotion({
    ...s,
    valence: decayToward(s.valence, s.baseline.valence, hours, halfLives.valence),
    energy: decayToward(s.energy, s.baseline.energy, hours, halfLives.energy),
    warmth: decayToward(s.warmth, s.baseline.warmth, hours, halfLives.warmth),
  });
}

export function applyEmotionDeltas(state, deltas = {}, opts = {}) {
  const s = clampEmotion(state);
  const damping = positiveNumber(opts.damping, PARAMS.emotion?.damping ?? 0.4);
  const maxStep = positiveNumber(opts.maxStepPerTurn, PARAMS.emotion?.maxStepPerTurn ?? 0.25);
  return clampEmotion({
    ...s,
    valence: s.valence + clampMag(num(deltas.valence), maxStep) * damping,
    energy: s.energy + clampMag(num(deltas.energy), maxStep) * damping,
    warmth: s.warmth + clampMag(num(deltas.warmth), maxStep) * damping,
  });
}

export function inferEmotionDeltasHeuristic(userMessage = '', reply = '') {
  const text = `${userMessage}\n${reply}`;
  const user = String(userMessage ?? '');
  const d = { valence: 0, energy: 0, warmth: 0 };
  const hit = (re) => (re.test(text) ? 1 : 0);
  const userHit = (re) => (re.test(user) ? 1 : 0);

  if (hit(/喜欢你|爱你|想你|谢谢|开心|高兴|幸福|哈哈|嘻嘻|宝贝|亲亲|抱抱|么么|记得你|陪你/)) {
    d.valence += 0.25;
    d.energy += 0.08;
    d.warmth += 0.12;
  }

  if (userHit(/生气|烦死|讨厌你|失望|别理我|不想理|滚|分手|冷战|委屈|伤心|难过|哭|不在乎/)) {
    d.valence -= 0.35;
    d.energy += 0.14;
    d.warmth -= 0.2;
  }

  if (userHit(/对不起|抱歉|我错了|原谅|和好|别生气|不气了|没事了/)) {
    d.valence += 0.22;
    d.energy -= 0.05;
    d.warmth += 0.16;
  }

  if (userHit(/累|困|睡不着|没精神|好累|疲惫/)) d.energy -= 0.16;
  return d;
}

export function toEmotionPrompt(state) {
  if (!state) return '';
  const s = clampEmotion(state);
  const mood = s.valence > 0.4 ? '心情不错' : s.valence < -0.2 ? '有点低落' : '比较平静';
  const energy = s.energy > 0.7 ? '很有兴致' : s.energy < 0.3 ? '有些没精神' : '状态一般';
  const warmth = s.warmth < 0.35 ? '对对方会稍微收着一点' : s.warmth > 0.72 ? '语气可以更柔软亲近' : '';
  const parts = [`你现在${mood}, ${energy}`];
  if (warmth) parts.push(warmth);
  return `${parts.join(', ')}。让它自然影响语气和话量, 别明说自己的情绪状态。`;
}

export function emotionSamplingHints(state) {
  const s = clampEmotion(state);
  const temperature = round(clamp(0.7 + s.energy * 0.4, 0.6, 1.15), 2);
  return {
    temperature,
    maxTokens: s.energy < 0.3 ? 220 : s.energy > 0.75 ? 650 : 500,
  };
}

export async function readEmotion(userId, now = Date.now()) {
  const { data, error } = await supabase
    .from('emotion')
    .select('baseline_valence, baseline_energy, baseline_warmth, half_life_hours, valence, energy, warmth, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return defaultEmotion();
  return decayEmotion(rowToEmotion(data), now);
}

export async function writeEmotion(userId, state, now = new Date()) {
  const s = clampEmotion(state);
  const { error } = await supabase.from('emotion').upsert(
    {
      user_id: userId,
      baseline_valence: s.baseline.valence,
      baseline_energy: s.baseline.energy,
      baseline_warmth: s.baseline.warmth,
      half_life_hours: normalizePersistedHalfLife(s.halfLifeHours),
      valence: s.valence,
      energy: s.energy,
      warmth: s.warmth,
      updated_at: now.toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
  return { ...s, updated_at: now.toISOString() };
}

export async function judgeEmotionDeltas(userMessage, reply, opts = {}) {
  if (opts.useLLM === false) return inferEmotionDeltasHeuristic(userMessage, reply);
  const fallback = inferEmotionDeltasHeuristic(userMessage, reply);
  try {
    const sys = `你在维护一个 AI 伴侣的短时情绪。读用户消息和 AI 回复, 只输出这一轮带来的情绪增量。
严格输出 JSON: {"valence":0,"energy":0,"warmth":0}
范围: valence -0.4..0.4, energy -0.3..0.3, warmth -0.3..0.3。没有变化就给 0。`;
    const res = await llm.chat.completions.create({
      model: opts.model ?? LLM_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `用户: ${userMessage}\nAI: ${reply}` },
      ],
    });
    const parsed = JSON.parse(res.choices[0].message.content);
    return {
      valence: clamp(num(parsed.valence), -0.4, 0.4) + fallback.valence,
      energy: clamp(num(parsed.energy), -0.3, 0.3) + fallback.energy,
      warmth: clamp(num(parsed.warmth), -0.3, 0.3) + fallback.warmth,
    };
  } catch {
    return fallback;
  }
}

export class Emotion {
  constructor({ userId }) {
    if (!userId) throw new Error('Emotion 需要 userId');
    this.userId = userId;
  }

  async current(opts = {}) {
    return readEmotion(this.userId, opts.now ?? Date.now());
  }

  async update(userMessage, reply, opts = {}) {
    const cur = await this.current(opts);
    const deltas = await judgeEmotionDeltas(userMessage, reply, opts);
    const next = applyEmotionDeltas(cur, deltas, opts);
    return writeEmotion(this.userId, next, opts.now ? new Date(opts.now) : new Date());
  }

  toPrompt(state) {
    return toEmotionPrompt(state);
  }

  samplingHints(state) {
    return emotionSamplingHints(state);
  }
}

function defaultEmotionRaw() {
  const p = PARAMS.emotion ?? {};
  return {
    baseline: {
      valence: p.baseline?.valence ?? DEFAULT_BASELINE.valence,
      energy: p.baseline?.energy ?? DEFAULT_BASELINE.energy,
      warmth: p.baseline?.warmth ?? DEFAULT_BASELINE.warmth,
    },
    halfLifeHours: p.halfLifeHours ?? 6,
    valence: p.baseline?.valence ?? DEFAULT_BASELINE.valence,
    energy: p.baseline?.energy ?? DEFAULT_BASELINE.energy,
    warmth: p.baseline?.warmth ?? DEFAULT_BASELINE.warmth,
    updated_at: null,
  };
}

function rowToEmotion(row) {
  return {
    baseline: {
      valence: row.baseline_valence,
      energy: row.baseline_energy,
      warmth: row.baseline_warmth ?? DEFAULT_BASELINE.warmth,
    },
    halfLifeHours: row.half_life_hours,
    valence: row.valence,
    energy: row.energy,
    warmth: row.warmth ?? DEFAULT_BASELINE.warmth,
    updated_at: row.updated_at,
  };
}

function normalizeHalfLives(value) {
  if (typeof value === 'number') return { valence: value, energy: value, warmth: value };
  return {
    valence: positiveNumber(value?.valence, 6),
    energy: positiveNumber(value?.energy, 4),
    warmth: positiveNumber(value?.warmth, 6),
  };
}

function normalizePersistedHalfLife(value) {
  if (typeof value === 'number') return value;
  return positiveNumber(value?.valence, 6);
}

function decayToward(value, baseline, hours, halfLife) {
  if (!(hours > 0)) return value;
  const k = Math.pow(0.5, hours / halfLife);
  return baseline + (value - baseline) * k;
}

function clampField(field, value) {
  const [lo, hi] = FIELD_RANGE[field];
  return clamp(num(value, (lo + hi) / 2), lo, hi);
}

function clampMag(value, cap) {
  return clamp(value, -cap, cap);
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return n > 0 ? n : fallback;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function round(value, digits) {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}
