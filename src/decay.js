import { PARAMS } from './params.js';

const HOUR = 1000 * 60 * 60;

/** 距某时间过去了多少小时 */
export function hoursSince(ts, now = Date.now()) {
  return Math.max(0, (now - new Date(ts).getTime()) / HOUR);
}

/**
 * 有效衰减率: 情绪越强, 衰减率越接近 1 (忘得越慢)。
 * emotion=0 -> baseDecay ; emotion=1 -> baseDecay + (1-baseDecay)*emotionProtect
 */
export function effectiveDecay(emotion = 0) {
  const { baseDecay, emotionProtect } = PARAMS;
  return baseDecay + (1 - baseDecay) * emotionProtect * clamp01(emotion);
}

/**
 * recency 分: 自"上次被访问"以来按天衰减。被检索命中会刷新 last_accessed,
 * 等于重新变鲜活 —— 这就是强化。返回 0-1。
 */
export function recencyScore(mem, now = Date.now()) {
  const days = hoursSince(mem.last_accessed, now) / 24;
  return Math.pow(effectiveDecay(mem.emotion), days);
}

/**
 * 综合记忆"当前强度" (用于 reflection 时判断哪些该被遗忘 / 归档)。
 * = importance * recency * (1 + ln(access_count+1)*k)
 */
export function memoryStrength(mem, now = Date.now()) {
  const recency = recencyScore(mem, now);
  const reinforce = 1 + Math.log(mem.access_count + 1) * PARAMS.reinforceK;
  return (mem.importance / 10) * recency * reinforce;
}

/**
 * 检索重排: 把候选集按 similarity / recency / importance 三项各自归一化后加权。
 * 返回带 _score 的新数组, 已降序排序。
 */
export function rerank(candidates, now = Date.now()) {
  if (candidates.length === 0) return [];
  const { wSimilarity, wRecency, wImportance } = PARAMS;

  const sims = candidates.map((c) => c.similarity ?? 0);
  const recs = candidates.map((c) => recencyScore(c, now));
  const imps = candidates.map((c) => c.importance ?? 0);

  const nSim = normalize(sims);
  const nRec = normalize(recs);
  const nImp = normalize(imps);

  return candidates
    .map((c, i) => ({
      ...c,
      _score: wSimilarity * nSim[i] + wRecency * nRec[i] + wImportance * nImp[i],
      _debug: { sim: nSim[i], rec: nRec[i], imp: nImp[i] },
    }))
    .sort((a, b) => b._score - a._score);
}

// ---- helpers ----
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/** min-max 归一化到 [0,1]; 全相等时返回全 1 */
function normalize(arr) {
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  if (max - min < 1e-9) return arr.map(() => 1);
  return arr.map((x) => (x - min) / (max - min));
}
