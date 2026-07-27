/**
 * P2 · 多用户配额与隔离骨架（纯逻辑）
 * 不替代真实计费；给 Bot/API 门控用：超配额拒绝高成本动作。
 */

export const DEFAULT_QUOTA = {
  version: 1,
  // 每用户（userId）每日上限
  maxMessagesPerDay: 200,
  maxPhotosPerDay: 12,
  maxMemoriesStored: 50000,
  maxActiveCompanions: 3,
  // 月度 token 粗估预算（可选，0=不限）
  maxTokensPerMonth: 0,
  // 超限时是否仍允许只读（看状态/相册）
  allowReadWhenExceeded: true,
};

export function normalizeQuota(input = {}) {
  const q = { ...DEFAULT_QUOTA, ...input };
  for (const k of ['maxMessagesPerDay', 'maxPhotosPerDay', 'maxMemoriesStored', 'maxActiveCompanions', 'maxTokensPerMonth']) {
    q[k] = Math.max(0, Math.floor(Number(q[k]) || 0));
  }
  q.allowReadWhenExceeded = q.allowReadWhenExceeded !== false;
  q.version = Number(q.version) || 1;
  return q;
}

/**
 * @param usage {{ messagesToday?, photosToday?, memories?, companions?, tokensMonth? }}
 * @returns {{ ok, action: 'allow'|'degrade'|'deny', reasons, remaining }}
 */
export function checkQuota(usage = {}, quota = DEFAULT_QUOTA) {
  const q = normalizeQuota(quota);
  const u = {
    messagesToday: Math.max(0, Number(usage.messagesToday) || 0),
    photosToday: Math.max(0, Number(usage.photosToday) || 0),
    memories: Math.max(0, Number(usage.memories) || 0),
    companions: Math.max(0, Number(usage.companions) || 0),
    tokensMonth: Math.max(0, Number(usage.tokensMonth) || 0),
  };
  const reasons = [];
  const remaining = {
    messagesToday: Math.max(0, q.maxMessagesPerDay - u.messagesToday),
    photosToday: Math.max(0, q.maxPhotosPerDay - u.photosToday),
    memories: Math.max(0, q.maxMemoriesStored - u.memories),
    companions: Math.max(0, q.maxActiveCompanions - u.companions),
  };

  if (q.maxMessagesPerDay && u.messagesToday >= q.maxMessagesPerDay) reasons.push('messages_daily_limit');
  if (q.maxPhotosPerDay && u.photosToday >= q.maxPhotosPerDay) reasons.push('photos_daily_limit');
  if (q.maxMemoriesStored && u.memories >= q.maxMemoriesStored) reasons.push('memories_cap');
  if (q.maxActiveCompanions && u.companions > q.maxActiveCompanions) reasons.push('companions_cap');
  if (q.maxTokensPerMonth && u.tokensMonth >= q.maxTokensPerMonth) reasons.push('tokens_monthly_limit');

  if (!reasons.length) {
    return { ok: true, action: 'allow', reasons: [], remaining, usage: u, quota: q };
  }

  // 仅消息/图超限 → degrade（可只读）；存储硬顶 → deny 写
  const hard = reasons.some((r) => r === 'memories_cap' || r === 'companions_cap' || r === 'tokens_monthly_limit');
  if (hard) {
    return {
      ok: false,
      action: 'deny',
      reasons,
      remaining,
      usage: u,
      quota: q,
    };
  }
  return {
    ok: false,
    action: q.allowReadWhenExceeded ? 'degrade' : 'deny',
    reasons,
    remaining,
    usage: u,
    quota: q,
  };
}

/** 是否允许写路径（发消息/出图） */
export function canWriteAction(check, action = 'message') {
  if (!check || check.action === 'allow') return true;
  if (check.action === 'deny') return false;
  // degrade: 禁止 message/photo 写入
  if (action === 'message' && check.reasons.includes('messages_daily_limit')) return false;
  if (action === 'photo' && check.reasons.includes('photos_daily_limit')) return false;
  return check.action !== 'deny';
}

/**
 * 作用域隔离键：所有读写必须带 userId+companionId
 */
export function scopeKey(userId, companionId = 'default') {
  return `${String(userId || '').trim()}::${String(companionId || 'default').trim()}`;
}

export function assertScopeIsolation(row = {}, userId, companionId = 'default') {
  if (!userId) return { ok: false, reason: 'missing_user' };
  if (row.user_id && row.user_id !== userId) return { ok: false, reason: 'user_mismatch' };
  if (row.companion_id && row.companion_id !== (companionId || 'default')) return { ok: false, reason: 'companion_mismatch' };
  return { ok: true };
}
