// M6 · 图片记忆。发来的图 → vision 模型生成 caption → 当作一条 image 模态记忆入库。
// caption 进 content/embedding, 因此能被【文本】召回 ("还记得我发的那张海边的照片吗")。
// 可选 media_embedding (CLIP 等) 留给跨图相似检索。复用 M0~M3 的本体/状态/重构/引擎。
//
// 缺 vision 凭证时降级: 若调用方已给 caption, 仍可入库; 否则跳过, 不抛、不崩。

import { llm, LLM_MODEL } from '../config.js';
import { normalizeMemory } from '../ontology.js';
import { storeMemories } from '../store.js';

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
