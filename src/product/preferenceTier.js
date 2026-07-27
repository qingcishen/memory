/**
 * 偏好分层（纯逻辑，不改 schema）
 * - locked：硬边界 / 姓名生日承诺 — 永不当玩笑改、不轻易 supersede 情感层
 * - soft：稳定偏好 — 可随对话更新（矛盾 supersede）
 * - whim：一时兴起 — 低权重、可被新说法覆盖，prompt 标明别当铁律
 *
 * 推断只依赖已有字段：type / fact_locked / importance / fact_core 文本。
 */

export const PREFERENCE_TIERS = ['locked', 'soft', 'whim', 'none'];

const LOCKED_RE =
  /(生日|真名|法定|雷点|底线|边界|禁止|绝对不要|说停就停|safe\s*word|安全词|过敏|不能碰|fact_locked)/i;
const WHIM_RE = /(今天想|暂时|试试|偶尔|随便|这一次|忽然想|兴致来了)/;

/**
 * @param mem {{ type?, fact_locked?, importance?, fact_core?, content?, narrative? }}
 * @returns {'locked'|'soft'|'whim'|'none'}
 */
export function inferPreferenceTier(mem = {}) {
  if (mem.fact_locked) return 'locked';
  const text = String(mem.fact_core || mem.content || mem.narrative || '');
  const type = mem.type || 'fact';
  const imp = Number(mem.importance) || 5;

  if (LOCKED_RE.test(text) && (type === 'preference' || type === 'fact' || type === 'relationship')) {
    return 'locked';
  }
  if (type === 'preference' || /喜欢|讨厌|偏好|习惯|爱吃|不爱/.test(text)) {
    if (imp <= 3 || WHIM_RE.test(text)) return 'whim';
    return 'soft';
  }
  return 'none';
}

/** prompt 行前缀 */
export function preferenceTierPrefix(tier) {
  if (tier === 'locked') return '【硬边界·不可戏说】';
  if (tier === 'soft') return '【偏好】';
  if (tier === 'whim') return '【一时兴起·可改】';
  return '';
}

/**
 * 是否允许被矛盾记忆 supersede（locked 默认不允许被软偏好盖掉）
 * @param existing 旧记忆
 * @param incoming 新记忆
 */
export function canSupersedePreference(existing = {}, incoming = {}) {
  const oldT = inferPreferenceTier(existing);
  const newT = inferPreferenceTier(incoming);
  if (oldT === 'locked' && newT !== 'locked') return false;
  if (oldT === 'locked' && newT === 'locked') return true; // 硬边界更新需同等 locked（如改安全词）
  if (oldT === 'soft' && newT === 'whim') return false; // 一时兴起不盖稳定偏好
  return true;
}

/**
 * 给 formatForPrompt 用的一行
 */
export function formatMemoryLine(mem, { lowConfidence = false } = {}) {
  const tier = mem.preference_tier || inferPreferenceTier(mem);
  const prefix = preferenceTierPrefix(tier);
  const text = String(mem.narrative || mem.fact_core || mem.content || '').trim();
  if (!text) return '';
  const body = lowConfidence ? `我记得好像${text}` : text;
  return prefix ? `- ${prefix}${body}` : `- ${body}`;
}

/**
 * 规范化时附上 preference_tier（内存字段，落库可忽略未知列）
 */
export function attachPreferenceTier(mem = {}) {
  const preference_tier = inferPreferenceTier(mem);
  return { ...mem, preference_tier };
}
