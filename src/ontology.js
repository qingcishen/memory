// 记忆本体 (M0)。纯逻辑, 无副作用, 可离线单测。
//
// 核心约束 (见 docs/DEVELOPMENT.md §1.6):
//   每条记忆 = 不可变的 fact_core  +  可重构的 affect/narrative
//   任何写路径都【禁止】改写已存在记忆的 fact_core —— 这是红线, 不是功能。
//   情感层 (valence/intensity/narrative) 才允许被情绪状态机重构, 且漂移有界。

export const SUBJECT_KINDS = ['user', 'self', 'dyad'];
export const MEMORY_TYPES = ['fact', 'episode', 'preference', 'relationship', 'reflection'];
export const MODALITIES = ['text', 'image', 'audio'];

/**
 * 把 LLM 提取出的原始对象规范化成标准两层记忆。
 * 只做清洗/裁剪/补默认, 不做任何 IO。
 * @returns {{type,fact_core,content,narrative,affect_valence,affect_intensity,subject_kind,fact_locked,importance,emotion}}
 */
export function normalizeMemory(raw = {}) {
  const fact_core = String(raw.fact_core ?? raw.content ?? '').trim();
  const narrative = raw.narrative != null ? String(raw.narrative).trim() : null;

  const affect = raw.affect ?? {};
  const affect_valence = clamp(numOr(affect.valence ?? raw.affect_valence, 0), -1, 1);
  const affect_intensity = clamp(numOr(affect.intensity ?? raw.affect_intensity ?? raw.emotion, 0), 0, 1);

  return {
    type: MEMORY_TYPES.includes(raw.type) ? raw.type : 'fact',
    fact_core,
    // content 兼容旧字段: 默认等于 fact_core, 注入 prompt 时用 narrative ?? fact_core
    content: fact_core,
    narrative,
    affect_valence,
    affect_intensity,
    subject_kind: SUBJECT_KINDS.includes(raw.subject_kind) ? raw.subject_kind : 'user',
    // M6 多模态: 来源模态 + 原始媒体出处 (纯文本记忆默认 text/null)
    modality: MODALITIES.includes(raw.modality) ? raw.modality : 'text',
    media_ref: raw.media_ref != null ? String(raw.media_ref) : null,
    fact_locked: Boolean(raw.fact_locked),
    // 兼容旧管线: importance 仍保留 (引擎里会逐步并入激活), emotion 镜像 intensity
    importance: clamp(numOr(raw.importance, 5), 1, 10),
    emotion: affect_intensity,
  };
}

/**
 * 唯一被许可的"改写已存储记忆"的入口。
 * 只动情感层, 强制保持 fact_core 不变, 并把 affect 漂移夹在 clamp 内。
 * M3 reconsolidation 会调它。这里集中实现是为了让"不变式"只有一处守卫。
 *
 * @param existing 已存储记忆 (含 fact_core / affect_valence / affect_intensity / narrative)
 * @param patch    期望的情感层变更 { affect_valence?, affect_intensity?, narrative? }
 * @param opts     { clamp: 单次最大漂移 (默认 0.15), factLocked: 是否连情感层也冻结 }
 * @returns 新的字段对象 (供落库), 保证 fact_core === existing.fact_core
 */
export function applyAffectUpdate(existing, patch = {}, opts = {}) {
  const step = opts.clamp ?? 0.15;
  const locked = opts.factLocked ?? existing.fact_locked ?? false;

  // fact_locked 的硬事实 (生日/承诺): 情感层也不动, 直接原样返回
  if (locked) {
    return {
      fact_core: existing.fact_core,
      affect_valence: existing.affect_valence ?? 0,
      affect_intensity: existing.affect_intensity ?? 0,
      narrative: existing.narrative ?? null,
      reconsolidation_count: existing.reconsolidation_count ?? 0,
    };
  }

  const v0 = numOr(existing.affect_valence, 0);
  const i0 = numOr(existing.affect_intensity, 0);

  const next = {
    // fact_core 绝不取 patch 的值 —— 红线
    fact_core: existing.fact_core,
    affect_valence: patch.affect_valence != null
      ? clamp(stepToward(v0, patch.affect_valence, step), -1, 1)
      : v0,
    affect_intensity: patch.affect_intensity != null
      ? clamp(stepToward(i0, patch.affect_intensity, step), 0, 1)
      : i0,
    narrative: patch.narrative != null ? String(patch.narrative).trim() : existing.narrative ?? null,
    reconsolidation_count: (existing.reconsolidation_count ?? 0) + 1,
  };
  return next;
}

/**
 * 不变式守卫: 断言一次写操作没有改变 fact_core。
 * 任何写路径在落库前/后都可调它做自检; 测试里也直接用。
 * @throws 若 fact_core 被改动
 */
export function assertFactCorePreserved(before, after) {
  const a = before?.fact_core ?? null;
  const b = after?.fact_core ?? null;
  if (a !== b) {
    throw new Error(
      `fact_core 不变式被破坏: "${a}" → "${b}" (任何机制都禁止改写事实核, 见 ontology.js)`
    );
  }
  return true;
}

// ---- helpers ----
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
function numOr(v, dflt) {
  const n = Number(v);
  return Number.isNaN(n) ? dflt : n;
}
/** 从 from 朝 to 走, 但单步不超过 step (有界靠拢, 防失真累积) */
function stepToward(from, to, step) {
  const delta = to - from;
  if (Math.abs(delta) <= step) return to;
  return from + Math.sign(delta) * step;
}
