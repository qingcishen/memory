// M7 · 去重。同一件事被反复说 ("我生日 12-15" 说三次) 不该存三条,
// 而应识别为同一条并【强化】它 (access_log 追加、access_count++) —— 等于"又被提起一次"。
// 纯逻辑 (规范化 + 哈希 + 判重), 落库侧由 store.js 调用。

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
