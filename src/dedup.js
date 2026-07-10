// M7 · 去重。同一件事被反复说 ("我生日 12-15" 说三次) 不该存三条,
// 而应识别为同一条并【强化】它 (access_log 追加、access_count++) —— 等于"又被提起一次"。
// 纯逻辑 (规范化 + 哈希 + 判重 + 近邻判重), 落库侧由 store.js 调用。
import { PARAMS } from './params.js';
import { cosine } from './engine/vector-index.js';

/**
 * 把文本规范化成判重用的指纹串: 去首尾/折叠空白、去常见标点、统一大小写。
 * 目的是让"诗雅讨厌香菜""诗雅 讨厌香菜。""诗雅讨厌香菜!"指向同一条。
 */
export function normalizeForHash(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:~～\-—_"'`()（）【】\[\]{}]/g, '')
    .trim();
}

/** 规范化文本 → 稳定短哈希 (djb2)。语义相同(在规范化意义下)产出相同 hash。 */
export function dedupHash(text) {
  const s = normalizeForHash(text);
  if (!s) return null;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `d${(h >>> 0).toString(36)}`;
}

/**
 * 在已存在记忆里找与给定 hash 完全相同的一条 (精确判重)。
 * @returns 命中的已存在记忆, 或 null
 */
export function findDuplicate(hash, existing = []) {
  if (!hash) return null;
  return existing.find((m) => m.dedup_hash === hash) ?? null;
}

/**
 * 向量相似度高到这个程度, 基本可以认为是"同一件事的不同说法"
 * (如"讨厌香菜"/"不爱吃香菜"), 应强化旧记忆而非新增一条。
 * 阈值明显高于矛盾判断的相似度门槛: 同话题但立场相反 (讨厌/喜欢) 相似度通常达不到这么高。
 */
export function isNearDuplicate(similarity, threshold = PARAMS.dedup.nearDuplicateThreshold) {
  return typeof similarity === 'number' && similarity >= threshold;
}

/**
 * 在候选 (如 match_memories 按相似度降序的结果) 里找第一条够"近义"的当作重复 (近邻判重)。
 * @returns 命中的候选, 或 null
 */
export function findNearDuplicate(candidates = [], threshold = PARAMS.dedup.nearDuplicateThreshold) {
  return candidates.find((c) => isNearDuplicate(c.similarity, threshold)) ?? null;
}

/**
 * #10 残余债收口: 找出一批记忆里互为"近义重复"的对, 决定保留谁、取代谁。
 * 用途: 并发 observe() 的极端时序下可能各插一条近义的"当前事实"(dedup_hash 挡不住),
 * 这里在维护期(reflect/nightly) 把它们合并 —— 保留"更值得留"的那条, 另一条 superseded_by 指向它。
 *
 * 纯逻辑 (cosine 在进程内算)。保留规则确定可重现 (并发双方会收敛到同一结果):
 *   importance 高者胜 → 并列取 created_at 早者 → 再并列取 id 字典序小者。
 * @param mems 活跃记忆 (含 id, embedding:number[], importance, created_at)
 * @param threshold 近义阈值 (默认同近邻判重)
 * @returns [{ loser, winner }] —— loser.superseded_by 应指向 winner
 */
export function selectNearDupMerges(mems = [], threshold = PARAMS.dedup.nearDuplicateThreshold) {
  const items = (mems ?? []).filter((m) => Array.isArray(m.embedding) && m.embedding.length);
  const superseded = new Set();
  const merges = [];
  for (let i = 0; i < items.length; i++) {
    if (superseded.has(items[i].id)) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (superseded.has(items[j].id)) continue;
      if (cosine(items[i].embedding, items[j].embedding) < threshold) continue;
      const winner = preferKeep(items[i], items[j]);
      const loser = winner === items[i] ? items[j] : items[i];
      merges.push({ loser, winner });
      superseded.add(loser.id);
      if (loser.id === items[i].id) break; // i 被取代了, 跳出内层换下一个 i
    }
  }
  return merges;
}

/** 近义对里"留谁": importance 高 → created_at 早 → id 小。确定可重现。 */
function preferKeep(a, b) {
  const ia = Number(a.importance ?? 0);
  const ib = Number(b.importance ?? 0);
  if (ia !== ib) return ia > ib ? a : b;
  const ta = new Date(a.created_at ?? 0).getTime();
  const tb = new Date(b.created_at ?? 0).getTime();
  if (ta !== tb) return ta < tb ? a : b;
  return String(a.id) <= String(b.id) ? a : b;
}
