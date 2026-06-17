// P1 工程债 #4 · 不确定性表达。
//
// 召回结果现在都是"我记得 XXX"的确定口吻; 但有些记忆相关度不高、很久没被
// 想起/强化, 或者与同批召回的另一条记忆在同一话题上情绪截然相反 (冲突) ——
// 这些情况下措辞该是"我记得好像 XXX", 而不是和铁打的事实一样自信。
// 纯逻辑, 可离线单测。

import { recencyScore } from './decay.js';
import { cosine } from './engine/vector-index.js';
import { PARAMS } from './params.js';

/**
 * 单条记忆的 confidence ∈ [0,1]。
 *  - similarity: 与当前 query 的相关度; 缺失 (如 dyad backdrop) 时按中性 0.5
 *  - strength:   recencyScore(decay.js); 缺 last_accessed 时按 1 (没数据不主动判定不确定)
 *  - conflict:   opts.conflicted 为真时按 PARAMS.confidence.conflictPenalty 扣分
 */
export function memoryConfidence(mem, opts = {}) {
  const { weights, conflictPenalty } = PARAMS.confidence;
  const similarity = mem.similarity ?? 0.5;
  const strength = mem.last_accessed != null ? recencyScore(mem, opts.now) : 1;
  const conflict = opts.conflicted ? conflictPenalty : 0;
  return clamp01(weights.similarity * similarity + weights.strength * strength - conflict);
}

/** confidence 低于阈值 → 该说"我记得好像...", 而不是"我记得..."。 */
export function isLowConfidence(score) {
  return score < PARAMS.confidence.lowThreshold;
}

/**
 * 在同一批候选里找"同话题但情绪相反"的记忆对: embedding 余弦相似度达到
 * conflict.similarityThreshold (同一件事), 但 affect_valence 符号相反且
 * 差值达到 conflict.valenceGap (当时的感受截然相反, 如一条"喜欢"一条"讨厌")。
 * @returns Set<id> 落在某个冲突对里的记忆 id
 */
export function detectConflicts(mems, opts = {}) {
  const { similarityThreshold, valenceGap } = { ...PARAMS.confidence.conflict, ...opts };
  const withVec = (mems ?? [])
    .map((m) => ({ ...m, _vec: toVector(m.embedding) }))
    .filter((m) => m._vec);
  const conflicted = new Set();

  for (let i = 0; i < withVec.length; i++) {
    for (let j = i + 1; j < withVec.length; j++) {
      const a = withVec[i];
      const b = withVec[j];
      const av = a.affect_valence ?? 0;
      const bv = b.affect_valence ?? 0;
      if (av * bv >= 0 || Math.abs(av - bv) < valenceGap) continue;
      if (cosine(a._vec, b._vec) >= similarityThreshold) {
        conflicted.add(a.id);
        conflicted.add(b.id);
      }
    }
  }
  return conflicted;
}

/** 给一批召回结果附上 _confidence (0..1) 与 _lowConfidence (bool)。 */
export function attachConfidence(mems, opts = {}) {
  const conflicted = detectConflicts(mems, opts);
  return (mems ?? []).map((m) => {
    const score = memoryConfidence(m, { ...opts, conflicted: conflicted.has(m.id) });
    return { ...m, _confidence: score, _lowConfidence: isLowConfidence(score) };
  });
}

// ---- helpers ----
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/** pgvector → number[]。已是数组则原样返回; 字符串 "[a,b,...]" 解析; 其它给 null。 */
function toVector(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  }
  return null;
}
