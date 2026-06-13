// M2 · 联想扩散 (Spread)。人想起一件事会顺藤摸瓜想起相关的事。
// 这里用记忆间的相似度建一张稀疏图 (kNN), 从"命中点"沿边扩散激活,
// 逐跳衰减。纯逻辑, 无 IO。Postgres 邻接表 + 这里的进程内扩散足够,
// 不引独立图数据库 (见 §7 不做什么)。

import { cosine } from './vector-index.js';
import { PARAMS } from '../params.js';

/**
 * 用相似度给一批记忆建无向稀疏图: 每个节点连相似度 ≥ threshold 的最多 k 个近邻。
 * @returns Map<id, Array<{ id, w }>>  邻接表 (w = 相似度边权)
 */
export function buildSimGraph(items, opts = {}) {
  const k = opts.k ?? PARAMS.engine.graphK;
  const threshold = opts.threshold ?? PARAMS.engine.graphThreshold;
  const withVec = items.filter((m) => Array.isArray(m.embedding));

  const adj = new Map();
  for (const m of withVec) adj.set(m.id, []);

  for (let i = 0; i < withVec.length; i++) {
    const neigh = [];
    for (let j = 0; j < withVec.length; j++) {
      if (i === j) continue;
      const w = cosine(withVec[i].embedding, withVec[j].embedding);
      if (w >= threshold) neigh.push({ id: withVec[j].id, w });
    }
    neigh.sort((a, b) => b.w - a.w);
    adj.set(withVec[i].id, neigh.slice(0, k));
  }
  return adj;
}

/**
 * 从种子节点出发做有界扩散, 算每个节点收到的扩散激活。
 * seed 强度沿边按 w 传播, 每跳乘 graphDecay, 最多 hops 跳。
 * @param adj    buildSimGraph 的邻接表
 * @param seeds  Map<id, strength> 或 id 数组 (数组则各取强度 1)
 * @returns Map<id, spread>  每个节点累计收到的扩散值 (不含自身种子强度)
 */
export function spreadActivation(adj, seeds, opts = {}) {
  const hops = opts.hops ?? PARAMS.engine.graphHops;
  const decay = opts.decay ?? PARAMS.engine.graphDecay;

  const seedMap = seeds instanceof Map ? seeds : new Map([...seeds].map((id) => [id, 1]));
  const spread = new Map();
  let frontier = new Map(seedMap); // 当前波前: id -> 该跳带来的强度

  for (let h = 0; h < hops; h++) {
    const next = new Map();
    for (const [id, energy] of frontier) {
      for (const { id: nid, w } of adj.get(id) ?? []) {
        const delta = energy * w * decay;
        if (delta < 1e-4) continue;
        next.set(nid, (next.get(nid) ?? 0) + delta);
      }
    }
    for (const [id, val] of next) {
      if (seedMap.has(id)) continue; // 种子自身不计扩散收益
      spread.set(id, (spread.get(id) ?? 0) + val);
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return spread;
}

/**
 * 便捷: 给候选集附上 _spread 字段。
 * 以"语境相似度最高的若干条"为种子 (它们最先被想起), 向外扩散。
 * @param items 候选 (含 similarity 与 embedding)
 * @param opts  { seedCount, ...buildSimGraph/spreadActivation opts }
 */
export function attachSpread(items, opts = {}) {
  const seedCount = opts.seedCount ?? 3;
  const adj = buildSimGraph(items, opts);
  const seeds = new Map(
    [...items]
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, seedCount)
      .map((m) => [m.id, Math.max(0, m.similarity ?? 0)])
  );
  const spread = spreadActivation(adj, seeds, opts);
  return items.map((m) => ({ ...m, _spread: spread.get(m.id) ?? 0 }));
}
