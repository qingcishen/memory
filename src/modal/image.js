// M6 · 图片记忆。发来的图 → vision 模型生成 caption → 当作一条 image 模态记忆入库。
// caption 进 content/embedding, 因此能被【文本】召回 ("还记得我发的那张海边的照片吗")。
// 可选 media_embedding (CLIP 等) 留给跨图相似检索, recallMedia 闭环这条路 (图搜图)。
// 复用 M0~M3 的本体/状态/重构/引擎。
//
// 缺 vision 凭证时降级: 若调用方已给 caption, 仍可入库; 否则跳过, 不抛、不崩。

import { supabase, llm, LLM_MODEL, PARAMS } from '../config.js';
import { normalizeMemory } from '../ontology.js';
import { storeMemories } from '../store.js';
import { cosine } from '../engine/vector-index.js';

// ---- 纯逻辑 ----

/**
 * 把一段 caption 组装成 image 模态记忆 (走标准两层本体)。
 * @param opts { caption, mediaRef, affect:{valence,intensity}, subjectName, importance, subject_kind }
 */
export function buildImageMemory(opts = {}) {
  const caption = String(opts.caption ?? '').trim();
  if (!caption) return null;
  return {
    ...normalizeMemory({
      type: 'episode',
      fact_core: caption,
      narrative: opts.narrative ?? null,
      subject_kind: opts.subject_kind ?? 'dyad', // 一起看的图多半是"我们"的
      modality: 'image',
      media_ref: opts.mediaRef ?? null,
      affect: opts.affect ?? { valence: 0, intensity: 0.4 },
      importance: opts.importance ?? 5,
    }),
    media_embedding: opts.mediaEmbedding ?? null,
  };
}

/**
 * 媒体向量闭环 (#6 工程债): 按 media_embedding 与 queryEmbedding 的余弦相似度给候选排序 (图搜图)。
 * 没有 media_embedding 的候选 (纯文本记忆, 或图片只有 caption 没存向量) 直接跳过。
 * 本模块不耦合具体视觉模型: queryEmbedding 由调用方算好 (如 CLIP) 传入。
 * @param candidates 候选记忆数组 (含 media_embedding)
 * @param queryEmbedding 查询图的向量
 * @returns 带 _mediaSimilarity 的新数组, 按相似度降序, 最多 opts.topK 条
 */
export function rankByMediaSimilarity(candidates, queryEmbedding, opts = {}) {
  const topK = opts.topK ?? PARAMS.modal.mediaTopK;
  const queryVec = toVector(queryEmbedding);
  if (!queryVec) return [];

  return (candidates ?? [])
    .map((m) => ({ mem: m, vec: toVector(m.media_embedding) }))
    .filter(({ vec }) => vec)
    .map(({ mem, vec }) => ({ ...mem, _mediaSimilarity: cosine(vec, queryVec) }))
    .sort((a, b) => b._mediaSimilarity - a._mediaSimilarity)
    .slice(0, topK);
}

// ---- helpers ----

/** pgvector → number[]。已是数组则原样返回; 字符串 "[a,b,...]" 解析; 其它给 null。 */
function toVector(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ---- IO ----

/** 用 vision 模型给图片生成 caption。缺凭证/失败时抛, 由 ingestImage 兜底降级。 */
export async function captionImage(imageUrl, opts = {}) {
  const res = await llm.chat.completions.create({
    model: opts.model ?? LLM_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '用一句中文客观描述这张图里值得记住的内容 (人、地点、在做什么)。只描述, 不要评价。' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  });
  return String(res.choices[0].message.content ?? '').trim();
}

/**
 * 摄取一张图片为记忆。
 * @param opts { url, caption?, affect?, mediaRef?, mediaEmbedding?, subjectName?, ... }
 * @returns 存入的记忆数组 (失败/无 caption 时返回 [], 不抛)
 */
export async function ingestImage(userId, opts = {}) {
  let caption = opts.caption;
  if (!caption && opts.url) caption = await captionImage(opts.url).catch(() => null);
  if (!caption) return []; // 降级: 没有 caption 就不记, 不崩

  const mem = buildImageMemory({ ...opts, caption, mediaRef: opts.mediaRef ?? opts.url });
  if (!mem) return [];
  return storeMemories(userId, [mem]);
}

/**
 * 图搜图 (#6 工程债 · 媒体向量闭环): 给一个查询图的向量 (调用方用 CLIP 等模型算好),
 * 在该用户带 media_embedding 的记忆里找最相似的几条 ——
 * "还记得跟这张差不多的那张照片吗"。
 * 进程内 brute-force 余弦 (同 M2 VectorIndex 思路): 单用户量级下足够快, 也省一次 SQL 函数。
 * @returns 排序后的记忆数组 (含 _mediaSimilarity); 命中会被强化 (last_accessed/access_count)
 */
export async function recallMedia(userId, queryEmbedding, opts = {}) {
  const { data, error } = await supabase
    .from('memories')
    .select('id, type, content, fact_core, narrative, subject_kind, modality, media_ref, media_embedding, importance, emotion, created_at, last_accessed, access_count, access_log')
    .eq('user_id', userId)
    .is('superseded_by', null)
    .not('media_embedding', 'is', null);
  if (error) throw error;
  if (!data || data.length === 0) return [];

  const ranked = rankByMediaSimilarity(data, queryEmbedding, opts);
  await reinforce(ranked);
  return ranked;
}

/** 强化: 被检索命中等于"又想起一次", 刷新时间并累加访问次数 */
async function reinforce(mems) {
  const now = new Date().toISOString();
  await Promise.all(
    mems.map((m) => {
      const log = Array.isArray(m.access_log) ? m.access_log : [];
      return supabase
        .from('memories')
        .update({ last_accessed: now, access_count: (m.access_count ?? 0) + 1, access_log: [...log, now].slice(-50) })
        .eq('id', m.id);
    })
  );
}
