// O-2 · 穿搭偏好学习 · 纯逻辑层
//
// 扫描用户消息里对当前穿搭的正面/负面反馈，
// 积累 preferred_ids / disliked_ids 列表，
// 供 composeDailyLook 按偏好权重选造型。

const LIKED_RE = /好看|好美|喜欢(你穿)?这(个|套|件)|真的好|这件棒|这套棒|穿这个|这衣服|漂亮|美美|美炸|心动|OMG.*衣|衣.*爱了/i;
const DISLIKED_RE = /换(一)?(套|件|个)|不喜欢|不好看|难看|太普通|不好意思穿|穿腻了|换身衣服|换个造型/i;

const MAX_IDS = 12;

/**
 * 从本轮用户消息扫描穿搭反馈。
 * @param turns  最近几轮对话 [{ role, content }]
 * @param outfitId  当前穿搭 id（只有用户在看当前穿搭时反馈才有意义）
 * @returns { liked: string[], disliked: string[] }  — 增量 id 列表
 */
export function scanOutfitFeedback(turns = [], outfitId = null) {
  if (!outfitId) return { liked: [], disliked: [] };
  // observe 理论上只收到本轮 user+assistant，但导入/重放可能带多轮。
  // 只信最后一条用户消息，避免旧反馈覆盖用户刚刚改变的态度。
  const userText = String(
    [...(Array.isArray(turns) ? turns : [])]
      .reverse()
      .find((turn) => turn?.role === 'user')
      ?.content ?? '',
  );
  if (!userText.trim()) return { liked: [], disliked: [] };
  // “不好看”包含“好看”子串，必须先判负面；“不好看，换一套”不能误记成喜欢。
  if (DISLIKED_RE.test(userText)) return { liked: [], disliked: [outfitId] };
  if (LIKED_RE.test(userText)) return { liked: [outfitId], disliked: [] };
  return { liked: [], disliked: [] };
}

/**
 * 把新反馈合并进已有的偏好列表，去重、限长、保持最近优先。
 * @param prefs { preferred_ids: string[], disliked_ids: string[] }
 * @param feedback { liked: string[], disliked: string[] }
 */
export function mergeOutfitFeedback(prefs = {}, feedback = {}) {
  const prefIds = Array.isArray(prefs.preferred_ids) ? [...prefs.preferred_ids] : [];
  const disIds = Array.isArray(prefs.disliked_ids) ? [...prefs.disliked_ids] : [];

  for (const id of feedback.liked ?? []) {
    // 从 disliked 里移除（用户重新喜欢）
    const di = disIds.indexOf(id);
    if (di >= 0) disIds.splice(di, 1);
    // 移到 preferred 头部
    const pi = prefIds.indexOf(id);
    if (pi >= 0) prefIds.splice(pi, 1);
    prefIds.unshift(id);
  }

  for (const id of feedback.disliked ?? []) {
    const pi = prefIds.indexOf(id);
    if (pi >= 0) prefIds.splice(pi, 1);
    const di = disIds.indexOf(id);
    if (di >= 0) disIds.splice(di, 1);
    disIds.unshift(id);
  }

  return {
    preferred_ids: prefIds.slice(0, MAX_IDS),
    disliked_ids: disIds.slice(0, MAX_IDS),
  };
}

/**
 * 从偏好列表和候选 pool 中选出最优 preferId。
 * 只在 pool 里找匹配项（避免推荐当前 context 不支持的造型）。
 * @param prefs { preferred_ids: string[] }
 * @param poolIds  当前 context 可用的 outfit id 列表
 */
export function resolvePreferId(prefs = null, poolIds = []) {
  if (!prefs || typeof prefs !== 'object') return null;
  const preferred = Array.isArray(prefs.preferred_ids) ? prefs.preferred_ids : [];
  for (const id of preferred) {
    if (poolIds.includes(id)) return id;
  }
  return null;
}
