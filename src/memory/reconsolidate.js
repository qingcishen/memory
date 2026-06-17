// M3 · 重构性记忆 (reconsolidation) —— 本项目的灵魂, 最反主流的机制。
//
// 认知科学: 人每次"想起"一段记忆, 都会被当下情绪悄悄改写。和好后那次吵架自己变软,
// 开心时旧事记得更暖。过去是【活的】, 不是冻住的。
//
// 铁律 (见 docs/DEVELOPMENT.md §1.6):
//   只动情感层 (affect_valence/intensity/narrative), 【绝不】碰 fact_core。
//   全部漂移走 ontology.applyAffectUpdate 这一个入口 (单点守卫 + 有界夹紧),
//   并在每次重构后 assertFactCorePreserved 自检 —— 红线即使被改坏也会立刻抛错。
//
// 上半部纯逻辑 (离线可测), 下半部碰 IO (落库 / LLM 重写 narrative)。

import { supabase, llm, LLM_MODEL, PARAMS } from '../config.js';
import { applyAffectUpdate, assertFactCorePreserved } from '../ontology.js';

// ============================================================
//  纯逻辑
// ============================================================

/**
 * 把一批被唤起的记忆向【当下情绪状态】轻微靠拢 (有界、有阻尼)。
 * @param mems  被 recall 命中的记忆 (含 affect_valence/intensity/fact_core/fact_locked)
 * @param state M1 关系-情感状态 { mood:{valence,arousal} }
 * @param opts  { rate: 单次靠拢步长, narratives: {id->新解读}(可选, 来自 LLM) }
 * @returns 新数组, 每条 = { ...mem, ...patch }; 保证 fact_core 一字未变, reconsolidation_count++
 */
export function reconsolidate(mems, state, opts = {}) {
  const p = PARAMS.reconsolidation;
  const step = Math.min(opts.rate ?? p.onRecallRate, p.affectClamp);
  const pull = opts.originPull ?? p.originPull;
  const maxDrift = opts.maxDriftFromOrigin ?? p.maxDriftFromOrigin;
  const moodV = num(state?.mood?.valence, 0);
  const arousal = num(state?.mood?.arousal, 0);
  const narratives = opts.narratives ?? {};

  return mems.map((m) => {
    // 锁定的硬事实 (生日/承诺): 连情感层都零漂移
    if (m.fact_locked) return m;

    // 原始情感锚 (缺失则以当前值兜底, 等于无锚)
    const originV = num(m.affect_origin_valence ?? m.affect_valence, 0);
    const originI = num(m.affect_origin_intensity ?? m.affect_intensity, 0);

    const patch = applyAffectUpdate(
      m,
      {
        // 目标 = 当下心情, 但被原始锚往回拉一部分 (开心/受伤都不会把旧事彻底改性)
        affect_valence: anchorTarget(moodV, originV, pull),
        affect_intensity: anchorTarget(arousal, originI, pull),
        narrative: narratives[m.id], // 有 LLM 重写才换解读, 否则保留
      },
      { clamp: step, factLocked: false }
    );

    // 硬上限: 情感离诞生时不得超过 maxDrift —— 长期负面心情也洗不黑一条本来温暖的记忆
    patch.affect_valence = clamp(clampToOrigin(patch.affect_valence, originV, maxDrift), -1, 1);
    patch.affect_intensity = clamp(clampToOrigin(patch.affect_intensity, originI, maxDrift), 0, 1);

    assertFactCorePreserved(m, patch); // 红线自检: 任何路径改了 fact_core 立即抛
    return { ...m, ...patch };
  });
}

/** 重构目标: 当下心情与原始情感锚的加权 (pull 越大越被原始锚拉住)。 */
export function anchorTarget(mood, origin, pull) {
  const k = clamp(pull, 0, 1);
  return mood * (1 - k) + origin * k;
}

/** 把值夹在"距原始锚 ±maxDrift"之内 (情感漂移的硬边界)。 */
export function clampToOrigin(value, origin, maxDrift) {
  return Math.min(origin + maxDrift, Math.max(origin - maxDrift, value));
}

/** 漂移审计: 当前情感离诞生时锚有多远 (给 inspect / 监控用)。 */
export function driftFromOrigin(mem) {
  const v = num(mem.affect_valence, 0) - num(mem.affect_origin_valence ?? mem.affect_valence, 0);
  const i = num(mem.affect_intensity, 0) - num(mem.affect_origin_intensity ?? mem.affect_intensity, 0);
  return { valence: v, intensity: i, total: Math.abs(v) + Math.abs(i) };
}

/** 本轮情绪相对某记忆是否"显著变化", 值得花一次 LLM 重写 narrative。 */
export function shouldRewriteNarrative(mem, state) {
  const moodV = num(state?.mood?.valence, 0);
  const memV = num(mem.affect_valence, 0);
  return Math.abs(moodV - memV) >= PARAMS.reconsolidation.significantMoodDelta;
}

// ============================================================
//  IO 层
// ============================================================

/**
 * 把重构后的情感层落库。逐条 update, 落库前再断言一次 fact_core 不变 (双保险)。
 * 只写发生了变化的记忆, 省写。
 */
export async function persistReconsolidation(patched, originals) {
  const origById = new Map((originals ?? patched).map((m) => [m.id, m]));
  const changed = patched.filter((m) => {
    const o = origById.get(m.id);
    if (!o) return true;
    return (
      o.affect_valence !== m.affect_valence ||
      o.affect_intensity !== m.affect_intensity ||
      (o.narrative ?? null) !== (m.narrative ?? null)
    );
  });

  await Promise.all(
    changed.map((m) => {
      assertFactCorePreserved(origById.get(m.id) ?? m, m);
      return supabase
        .from('memories')
        .update({
          affect_valence: m.affect_valence,
          affect_intensity: m.affect_intensity,
          narrative: m.narrative ?? null,
          reconsolidation_count: m.reconsolidation_count ?? 0,
        })
        .eq('id', m.id);
    })
  );
  return changed.length;
}

/**
 * recall 命中时的轻量重构 (纯数值, 不调 LLM): 想起即被当下情绪染色一点点。
 * 返回染色后的 hits (供本轮注入), 落库异步进行不阻塞。
 */
export async function reconsolidateOnRecall(hits, state, opts = {}) {
  if (!hits || hits.length === 0 || !state) return hits;
  const patched = reconsolidate(hits, state, { rate: PARAMS.reconsolidation.onRecallRate });
  persistReconsolidation(patched, hits).catch(() => {}); // fire-and-forget
  return patched;
}

/**
 * 夜间/和好后的批量重构: 拉最近的非锁定记忆, 用较大步长朝当下状态软化,
 * 情绪显著变化的记忆额外让 LLM 重写 narrative。
 * 典型用法: 和好后调一次, 把高 tension 的旧怨整体软化。
 */
export async function reconsolidateRecent(userId, companionId = 'default', state, opts = {}) {
  const lookback = opts.recent ?? 60;
  const { data: mems, error } = await supabase
    .from('memories')
    .select('id, fact_core, content, narrative, affect_valence, affect_intensity, affect_origin_valence, affect_origin_intensity, fact_locked, reconsolidation_count, type')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .is('superseded_by', null)
    .eq('fact_locked', false)
    .order('created_at', { ascending: false })
    .limit(lookback);
  if (error) throw error;
  if (!mems || mems.length === 0) return { count: 0 };

  // 可选: 给情绪显著变化的记忆批量重写 narrative (低频 LLM)
  let narratives = {};
  if (opts.useLLM) {
    const toRewrite = mems.filter((m) => shouldRewriteNarrative(m, state));
    narratives = await rewriteNarratives(toRewrite, state).catch(() => ({}));
  }

  const patched = reconsolidate(mems, state, { rate: PARAMS.reconsolidation.nightlyRate, narratives });
  const count = await persistReconsolidation(patched, mems);
  return { count, rewritten: Object.keys(narratives).length };
}

/** 低频 LLM: 按当下情绪重写若干记忆的 narrative (主观解读), 绝不碰 fact_core。 */
async function rewriteNarratives(mems, state) {
  if (!mems || mems.length === 0) return {};
  const moodV = num(state?.mood?.valence, 0);
  const tone = moodV > 0.2 ? '此刻心情不错, 回忆偏暖' : moodV < -0.2 ? '此刻有些受伤, 回忆偏苦' : '此刻平静';
  const sys = `你在重写一个 AI 伴侣对往事的【主观解读 narrative】, 反映她此刻的心情 (${tone})。
只改解读口吻, 事实本身 (谁、何时、做了什么) 一律不许变或捏造。每条给一句简短的当下感受。
严格输出 JSON: {"items":[{"id":"...","narrative":"..."}]}, 不要其它内容。`;
  const list = mems.map((m) => ({ id: m.id, fact: m.fact_core ?? m.content, old: m.narrative ?? '' }));
  const res = await llm.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.5,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(list) },
    ],
  });
  const parsed = JSON.parse(res.choices[0].message.content);
  const out = {};
  for (const it of parsed.items ?? []) if (it.id && it.narrative) out[it.id] = String(it.narrative).trim();
  return out;
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isNaN(n) ? d : n;
}
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(x) || 0));
}
