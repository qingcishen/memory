import { supabase, llm, LLM_MODEL, PARAMS } from './config.js';
import { recordLlmCall } from './metrics.js';
import { embed } from './embeddings.js';
import { memoryStrength } from './decay.js';
import { selectNearDupMerges } from './dedup.js';
import { baseLevel } from './engine/activation.js';

const DAY = 24 * 60 * 60 * 1000;
const AUTO_FORGET_PROTECTED_TYPES = new Set([
  'relationship',
  // 私密事件即使旧数据缺了 dyad/fact_locked 标记，也不应被后台清理悄悄抹掉。
  'intimate_memory',
  'emotion_event',
]);
export const AUTO_FORGET_STRENGTH_THRESHOLD = 0.1;
export const AUTO_FORGET_BASE_LEVEL_THRESHOLD = 0.03;

/**
 * 反思: 把最近的零散记忆聚成更高层的总结 (如"诗雅最近压力大, 在备考"),
 * 作为高重要性的 reflection 记忆存回。让伴侣形成"整体印象"而非一堆碎片。
 */
export async function runReflection(userId, companionId = 'default', opts = {}) {
  const lookback = opts.recent ?? 40;

  const { data: mems, error } = await supabase
    .from('memories')
    .select('id, content, type, importance, emotion, created_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .is('superseded_by', null)
    .neq('type', 'reflection')
    .order('created_at', { ascending: false })
    .limit(lookback);
  if (error) throw error;
  if (!mems || mems.length < 5) return []; // 太少不值得反思

  const sys = `你在帮一个 AI 伴侣形成对对方的"高层印象"。
阅读下面的零散记忆, 归纳出 1-3 条更概括、更有洞察的总结 (趋势、状态、性格倾向、关系走向)。
不要简单复述, 要提炼。
严格输出 JSON: {"insights":[{"content":"...","importance":1-10,"emotion":0-1}]}。`;

  const res = await llm.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: mems.map((m) => `- ${m.content}`).join('\n') },
    ],
  });
  recordLlmCall('reflect', res.usage);

  let insights = [];
  try {
    insights = JSON.parse(res.choices[0].message.content).insights || [];
  } catch {
    return [];
  }

  const stored = [];
  for (const ins of insights) {
    const content = String(ins.content || '').trim();
    if (!content) continue;
    const embedding = await embed(content);
    const { data, error: e } = await supabase
      .from('memories')
      .insert({
        user_id: userId,
        companion_id: companionId,
        type: 'reflection',
        content,
        embedding,
        importance: clampNum(ins.importance, 1, 10, 7),
        emotion: clampNum(ins.emotion, 0, 1, 0.3),
      })
      .select()
      .single();
    if (!e) stored.push(data);
  }
  return stored;
}

/** 一条记忆最后一次可证实的访问时间；没有可靠时间戳时返回 null（宁可保留）。 */
export function lastMemoryAccessAt(memory = {}) {
  const timestamps = [
    memory.last_accessed,
    ...(Array.isArray(memory.access_log) ? memory.access_log : []),
  ]
    .map(toTimestamp)
    .filter(Number.isFinite);
  if (timestamps.length > 0) return Math.max(...timestamps);
  return Number.isFinite(toTimestamp(memory.created_at))
    ? toTimestamp(memory.created_at)
    : null;
}

/** M-4 的硬保护边界。旧/畸形私密记录也按 type 保护，避免因字段迁移不全被误删。 */
export function isAutoForgetProtected(memory = {}) {
  return Boolean(memory.fact_locked) ||
    memory.subject_kind === 'dyad' ||
    AUTO_FORGET_PROTECTED_TYPES.has(memory.type);
}

/**
 * M-4 自动遗忘候选纯逻辑。所有条件必须同时满足：
 * importance < 3、90 天没有访问、ACT-R base-level 与当前记忆强度都低于阈值，
 * 且不命中 fact_locked / dyad / relationship / 私密事件保护。
 */
export function selectAutoForgettable(memories = [], opts = {}) {
  const now = toTimestamp(opts.now ?? Date.now());
  if (!Number.isFinite(now)) return [];
  const staleDays = positiveNumber(opts.staleDays, 90);
  const importanceThreshold = finiteNumber(opts.importanceThreshold, 3);
  const strengthThreshold = finiteNumber(
    opts.strengthThreshold ?? opts.threshold,
    AUTO_FORGET_STRENGTH_THRESHOLD,
  );
  const baseLevelThreshold = finiteNumber(
    opts.baseLevelThreshold,
    AUTO_FORGET_BASE_LEVEL_THRESHOLD,
  );
  const cutoff = now - staleDays * DAY;

  return (memories ?? []).filter((memory) => {
    if (!memory || isAutoForgetProtected(memory)) return false;
    const importance = Number(memory.importance);
    if (!Number.isFinite(importance) || importance >= importanceThreshold) {
      return false;
    }
    const lastAccess = lastMemoryAccessAt(memory);
    if (!Number.isFinite(lastAccess) || lastAccess > cutoff) return false;

    // 老数据可能没有 access_count；用 access_log 做保守下界，避免低估强化次数后误删。
    const loggedAccesses = Array.isArray(memory.access_log)
      ? memory.access_log.map(toTimestamp).filter(Number.isFinite).length
      : 0;
    const normalized = {
      ...memory,
      importance,
      emotion: finiteNumber(memory.emotion, 0),
      access_count: Math.max(
        0,
        finiteNumber(memory.access_count, 0),
        loggedAccesses,
      ),
      last_accessed: new Date(lastAccess).toISOString(),
    };
    const strength = memoryStrength(normalized, now);
    const activationBase = baseLevel(normalized, now);
    return Number.isFinite(strength) &&
      strength < strengthThreshold &&
      Number.isFinite(activationBase) &&
      activationBase < baseLevelThreshold;
  });
}

/** 1% observe 调度的纯判定；sample 注入后可确定性测试。 */
export function shouldTriggerAutoForget(sample, probability = 0.01) {
  const draw = Number(sample);
  const chance = Math.min(1, Math.max(0, finiteNumber(probability, 0.01)));
  return Number.isFinite(draw) && draw >= 0 && draw < chance;
}

/**
 * 找出符合 M-4 完整契约的自动遗忘候选。默认不删除；传 { purge: true } 才清理。
 */
export async function findForgettable(
  userId,
  companionId = 'default',
  threshold = AUTO_FORGET_STRENGTH_THRESHOLD,
  opts = {},
) {
  const { data: mems, error } = await supabase
    .from('memories')
    .select('*')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .is('superseded_by', null);
  if (error) throw error;

  const weak = selectAutoForgettable(mems, {
    ...opts,
    threshold,
  });

  if (opts.purge && weak.length > 0) {
    if (typeof opts.beforeDelete === 'function') {
      await opts.beforeDelete(weak);
    }
    const { error: deleteError } = await supabase
      .from('memories')
      .delete()
      .in('id', weak.map((m) => m.id));
    if (deleteError) throw deleteError;
  }
  return weak;
}

/**
 * 主动遗忘 (P2 工程债 #9): 纯逻辑。从相似度候选 (如 match_memories 结果) 里
 * 选出"够相关、可以认定为在说这件事"的一批 —— 相似度需达到 threshold。
 * fact_locked (生日/名字/承诺等硬事实) 默认不进遗忘范围, 即使用户随口提到也不误删;
 * 传 { includeLocked: true } 可放开 (用户明确要求时)。
 */
export function selectForgettable(candidates = [], opts = {}) {
  const threshold = opts.threshold ?? PARAMS.forget.similarityThreshold;
  return (candidates ?? []).filter(
    (c) => (c.similarity ?? 0) >= threshold && (opts.includeLocked || !c.fact_locked)
  );
}

/**
 * 主动遗忘 API: "忘记我刚才说的那件事" 这类显式请求。
 * 按 query 向量召回候选, 挑出 selectForgettable 命中的几条直接删除 (不可恢复)。
 * @returns 被删除的记忆列表 (可能为空)
 */
export async function forgetByQuery(userId, companionId = 'default', query, opts = {}) {
  const queryEmbedding = await embed(query);
  const { data: candidates, error } = await supabase.rpc('match_memories', {
    p_user_id: userId,
    p_companion_id: companionId,
    query_embedding: queryEmbedding,
    match_count: opts.pool ?? PARAMS.candidatePool,
  });
  if (error) throw error;

  const targets = selectForgettable(candidates ?? [], opts);
  if (targets.length === 0) return [];

  if (typeof opts.beforeDelete === 'function') {
    await opts.beforeDelete(targets);
  }
  await supabase
    .from('memories')
    .delete()
    .in('id', targets.map((m) => m.id));
  return targets;
}

/**
 * #10 残余债收口: 维护期合并近义重复 (并发 observe 极端时序漏过去的"两条当前事实")。
 * 拉活跃记忆(带向量) → selectNearDupMerges 选出该合并的对 → loser.superseded_by 指向 winner,
 * 并把 loser 的访问计数并进 winner (强化, 不丢"被提起过几次")。
 * @returns { merged: number }
 */
export async function mergeNearDuplicates(userId, companionId = 'default', opts = {}) {
  const lookback = opts.recent ?? 200;
  const { data: mems, error } = await supabase
    .from('memories')
    .select('id, embedding, importance, created_at, access_count, access_log')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .is('superseded_by', null)
    .not('embedding', 'is', null)
    .order('created_at', { ascending: false })
    .limit(lookback);
  if (error) throw error;
  if (!mems || mems.length < 2) return { merged: 0 };

  const normalized = mems.map((m) => ({ ...m, embedding: parseVector(m.embedding) }));
  const merges = selectNearDupMerges(normalized, opts.threshold);
  for (const { loser, winner } of merges) {
    // loser 指向 winner; 同时把 loser 的 access_count 计进 winner (保留"被提起过"的强度)
    await supabase.from('memories').update({ superseded_by: winner.id }).eq('id', loser.id).is('superseded_by', null);
    await supabase
      .from('memories')
      .update({ access_count: (winner.access_count ?? 0) + (loser.access_count ?? 0) + 1, last_accessed: new Date().toISOString() })
      .eq('id', winner.id);
  }
  return { merged: merges.length };
}

/** pgvector → number[]。已是数组原样; 字符串 "[...]" 解析; 其它 null。 */
function parseVector(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a : null;
    } catch {
      return null;
    }
  }
  return null;
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function toTimestamp(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}
