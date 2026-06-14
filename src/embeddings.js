import { embedder, EMBED_MODEL } from './config.js';

// schema.sql 里 embedding/cue_embedding 都是 vector(1536)。
// 部分 OpenAI 兼容服务 (如智谱 embedding-3) 默认维度不是 1536, 用 dimensions 显式对齐;
// 同时显式要 float 格式 —— OpenAI SDK 默认走 base64, 这些服务对 base64 的处理不对会返回错误长度的向量。
const EMBED_DIMENSIONS = 1536;

/** 单条文本 -> 向量 */
export async function embed(text) {
  const res = await embedder.embeddings.create({
    model: EMBED_MODEL,
    input: text,
    dimensions: EMBED_DIMENSIONS,
    encoding_format: 'float',
  });
  return res.data[0].embedding;
}

/** 批量文本 -> 向量数组 (一次 API 调用) */
export async function embedMany(texts) {
  if (texts.length === 0) return [];
  const res = await embedder.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
    dimensions: EMBED_DIMENSIONS,
    encoding_format: 'float',
  });
  return res.data.map((d) => d.embedding);
}
