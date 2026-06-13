import { embedder, EMBED_MODEL } from './config.js';

/** 单条文本 -> 向量 */
export async function embed(text) {
  const res = await embedder.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return res.data[0].embedding;
}

/** 批量文本 -> 向量数组 (一次 API 调用) */
export async function embedMany(texts) {
  if (texts.length === 0) return [];
  const res = await embedder.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}
