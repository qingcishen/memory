// M2 · 激活函数 (见 docs/DEVELOPMENT.md §2)。纯逻辑, 无 IO, 离线可测。
//
//   Activation(m, ctx) =  B(m)                         ACT-R base-level: ln(Σ tₖ⁻ᵈ)  新近+频次
//                      +  wCtx · Sim(m, ctx)           语境相似
//                      +  wSpread · Spread(m)          联想扩散 (由 graph.js 预先算好填进来)
//                      +  wMood · MoodCongruence(m, s) ③ 心情门控: 与当前情绪同向的记忆被点亮
//                      +  wMile · Milestone(m)         关系里程碑常驻
//                      -  Temporal_penalty(m)          过期情节降权 (不归零)
//
// 这套打分是 SQL 永远做不到的 (心情/扩散塞进排序), 也是必须自研引擎的根本原因。

import { PARAMS } from '../params.js';
import { cosine } from './vector-index.js';

const HOUR = 1000 * 60 * 60;
const DAY = HOUR * 24;

/**
 * ACT-R base-level activation: B(m) = ln( Σ_k t_k^{-d} )。
 * t_k = 第 k 次唤起距今的天数 (至少一个很小的正数, 防 log 0 / 除 0)。
 * access_log 为历次唤起时间戳数组; 缺失时退回 created_at + last_accessed。
 */
export function baseLevel(mem, now = Date.now(), d = PARAMS.engine.forgetRate) {
  const times = accessTimes(mem);
  let sum = 0;
  for (const t of times) {
    const days = Math.max((now - t) / DAY, 1 / 24 / 60); // 下限 ~1 分钟
    sum += Math.pow(days, -d);
  }
  if (sum <= 0) return 0;
  return Math.log(sum);
}

/**
 * 心情门控一致度 (招牌③): 记忆情感正负与"她当下心情"同向则点亮, 反向则压低。
 * mood.valence 与 affect_valence 同号 → 正; 异号 → 负。强情绪记忆更敏感。
 * 返回大致 [-1, 1]。她受伤 (valence<0) 时, 负面记忆 (affect_valence<0) 被显著点亮。
 */
export function moodCongruence(mem, state) {
  const moodV = num(state?.mood?.valence, 0);
  const memV = num(mem.affect_valence, 0);
  const intensity = clamp01(num(mem.affect_intensity, 0));
  // 同号相乘为正 (点亮), 异号为负 (压低); 弱情绪记忆受心情影响小
  return moodV * memV * (0.4 + 0.6 * intensity);
}

/**
 * #5 定向心情门控: 在全局门控基础上, 当她的负面情绪【指向某外部话题】时,
 * 只点亮与该话题语义相关的负面记忆, 而不是一负面就翻出所有旧伤疤。
 * - tension_target !== 'external' / tension 不够高 / 没有话题向量 / 非负面记忆 → 退化为全局 moodCongruence。
 * - 否则把全局项乘上 gate = directedGateFloor + (1-floor)*cosine(话题, 记忆), 与话题无关的负面记忆被压到 floor。
 * @param opts { topicEmbedding?: number[] } 当前紧张话题的向量 (engineRecall 注入)
 */
export function directedMoodCongruence(mem, state, opts = {}) {
  const base = moodCongruence(mem, state);
  const rel = state?.relationship ?? {};
  const memV = num(mem.affect_valence, 0);
  const p = PARAMS.engine;
  const directed =
    rel.tension_target === 'external' &&
    num(rel.tension, 0) > p.tensionGateMin &&
    memV < 0 &&
    Array.isArray(opts.topicEmbedding) &&
    Array.isArray(mem.embedding);
  if (!directed) return base;
  const relTopic = clamp01(cosine(opts.topicEmbedding, mem.embedding));
  const gate = p.directedGateFloor + (1 - p.directedGateFloor) * relTopic;
  return base * gate;
}

/** 关系里程碑: dyad 共同记忆 / 锁定的硬事实 (生日承诺) / 关系类记忆常驻。返回 0..1。 */
export function milestone(mem) {
  if (mem.fact_locked) return 1;
  if (mem.subject_kind === 'dyad') return clamp01(num(mem.importance, 5) / 10);
  if (mem.type === 'relationship') return 0.6;
  return 0;
}

/** 过期情节降权 (不归零): 只对 episode 生效, 越老降得越多, 有上限。 */
export function temporalPenalty(mem, now = Date.now()) {
  if (mem.type !== 'episode') return 0;
  const created = mem.created_at ? new Date(mem.created_at).getTime() : now;
  const days = Math.max(0, (now - created) / DAY);
  const hl = PARAMS.engine.temporalHalfLifeDays;
  // 0..1 的"陈旧度", 越老越接近 1
  return 1 - Math.pow(0.5, days / hl);
}

/**
 * 对一批候选 (已带 similarity 与可选 _spread) 计算激活分并降序排序。
 * 纯函数: 不碰 IO, 给定相同输入产出相同顺序 (可断言)。
 * @param items  候选记忆数组, 每条含 { embedding?, similarity?, affect_*, type, subject_kind, importance, access_log, created_at, last_accessed, _spread? }
 * @param state  关系-情感状态 { mood, relationship } (来自 M1)
 * @param opts   { now, params } —— params 可覆盖 PARAMS.engine (如把 wMood 设 0 关闭门控)
 * @returns 带 _activation / _act(明细) 的新数组, 已降序
 */
export function scoreActivation(items, state, opts = {}) {
  const now = opts.now ?? Date.now();
  const p = { ...PARAMS.engine, ...(opts.params ?? {}) };

  return items
    .map((m) => {
      const B = baseLevel(m, now, p.forgetRate);
      const sim = num(m.similarity, 0);
      const spread = num(m._spread, 0);
      // #5: opts.topicEmbedding 在场且她负面情绪指向外部话题时, 走定向门控; 否则等同全局 moodCongruence。
      const mood = directedMoodCongruence(m, state, { topicEmbedding: opts.topicEmbedding });
      const mile = milestone(m);
      const tpen = temporalPenalty(m, now);

      const activation =
        B + p.wCtx * sim + p.wSpread * spread + p.wMood * mood + p.wMile * mile - p.temporalPenalty * tpen;

      return {
        ...m,
        _activation: activation,
        _act: { B, sim, spread, mood, mile, tpen },
      };
    })
    .sort((a, b) => b._activation - a._activation);
}

// ---- helpers ----
function accessTimes(mem) {
  const log = Array.isArray(mem.access_log) ? mem.access_log : [];
  const ts = log.map((x) => new Date(x).getTime()).filter((n) => !Number.isNaN(n));
  if (ts.length > 0) return ts;
  const fallback = [];
  if (mem.created_at) fallback.push(new Date(mem.created_at).getTime());
  if (mem.last_accessed) fallback.push(new Date(mem.last_accessed).getTime());
  return fallback.length ? fallback : [Date.now()];
}
function num(v, d = 0) {
  const n = Number(v);
  return Number.isNaN(n) ? d : n;
}
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
