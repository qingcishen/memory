// M2 · 进程内向量索引。单用户 10³~10⁴ 条, brute-force 余弦几毫秒即可,
// 自建的意义在于把检索"打开"——让 activation.js 的心情/扩散能介入排序,
// 而不是被 pgvector 的 ORDER BY 锁死。pgvector 退化为"持久化后端"。
//
// 按 modality 分桶 (text / image / audio), 为 M6 多模态预留; 查询可跨桶或限桶。
// 纯逻辑 (不碰网络), 数据由上层喂进来。

/** 余弦相似度 (假设向量未归一化, 这里现算模长)。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class VectorIndex {
  constructor() {
    this.buckets = new Map(); // modality -> [{ id, vec, mem }]
  }

  /** 加入一条记忆 (需含 embedding)。无向量的跳过。 */
  add(mem, modality = mem.modality ?? 'text') {
    if (!mem || !Array.isArray(mem.embedding)) return;
    if (!this.buckets.has(modality)) this.buckets.set(modality, []);
    this.buckets.get(modality).push({ id: mem.id, vec: mem.embedding, mem });
  }

  /** 批量加入。 */
  addAll(mems) {
    for (const m of mems) this.add(m);
    return this;
  }

  get size() {
    let n = 0;
    for (const arr of this.buckets.values()) n += arr.length;
    return n;
  }

  /** 取出所有 (或某 modality 的) 记忆条目。 */
  items(modality) {
    if (modality) return (this.buckets.get(modality) ?? []).map((e) => e.mem);
    return [...this.buckets.values()].flat().map((e) => e.mem);
  }

  /**
   * 查询: 返回相似度最高的 k 条记忆 (每条带 similarity)。
   * @param queryVec 查询向量
   * @param opts { k, modalities, minSim }
   */
  query(queryVec, opts = {}) {
    const k = opts.k ?? 30;
    const minSim = opts.minSim ?? -1;
    const mods = opts.modalities ?? [...this.buckets.keys()];

    const scored = [];
    for (const mod of mods) {
      for (const e of this.buckets.get(mod) ?? []) {
        const sim = cosine(queryVec, e.vec);
        if (sim >= minSim) scored.push({ ...e.mem, similarity: sim });
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }
}
