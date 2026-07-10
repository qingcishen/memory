// K1 · 知识图谱提取: 从对话里抽 "实体 —关系→ 实体" 的客观结构化事实。
//
// 与 src/extract.js (记忆提取) 分工: 记忆是自然语言的事实/事件/偏好, 归检索引擎管;
// 这里抽的是可遍历的图结构 (小王 —works_at→ 腾讯), 存 knowledge_entities/relations,
// recall 时按入口实体做有界多跳展开, 回答"小王最近怎么样"这类需要关联的提问。
// 纯逻辑 (normalize/parse) 与 IO (extractKnowledge) 分离, 前者可离线单测。

import { llm, LLM_MODEL } from '../config.js';
import { recordLlmCall } from '../metrics.js';

export const ENTITY_TYPES = ['person', 'place', 'organization', 'thing', 'event', 'concept'];

const EXTRACT_SYSTEM = `你是一个知识图谱提取器, 服务于一个 AI 伴侣的长期记忆。
从对话中提取"实体 —关系→ 实体"的客观结构化事实。只提取明确陈述的、持久的关系
(任职/居住/亲属/朋友/拥有/喜欢...), 忽略寒暄、猜测、一次性的琐事。宁缺毋滥。

输出 JSON:
{"entities": [{"name": "小王", "type": "person", "aliases": []}],
 "relations": [{"source": "小王", "relation": "works_at", "target": "腾讯", "confidence": 0.9, "evidence": "他说小王在腾讯上班"}]}

规则:
- entity type 只能是: person / place / organization / thing / event / concept
- relation 用稳定的英文 snake_case 谓词 (works_at / lives_in / friend_of / family_of / likes / dislikes / owns / studies_at / married_to / part_of ...), 同一种关系永远用同一个词
- relations 里出现的实体必须在 entities 里给出; 人名用对话里的真实名字, 不要用"用户"/"AI"
- confidence: 对方亲口确认=0.9, 转述/推断=0.6-0.7
- evidence: 一句简短的对话依据
- 没有可提取的就输出 {"entities": [], "relations": []}
不要输出 JSON 以外的任何内容, 不要用 markdown 代码块。`;

/** 实体名 -> 去重键: 小写、去空白, 截断。纯函数。 */
export function normalizeEntityKey(name = '') {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '').slice(0, 64);
}

/** 关系名 -> 稳定 snake_case; 归一失败返回 null。纯函数。 */
export function normalizeRelation(relation = '') {
  const cleaned = String(relation ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return cleaned || null;
}

/**
 * LLM 原始输出 -> 规范化的 {entities, relations}。纯函数, 任何脏输入都不抛错:
 * - 实体: 名字裁剪去重, 未知 type 归为 concept
 * - 关系: relation 归一成 snake_case, confidence 夹在 0..1, 过滤自环;
 *   引用了 entities 里没有的实体时自动补一个 concept 实体 (对 LLM 漏报宽容)
 */
export function parseKnowledgeExtraction(rawContent) {
  let parsed;
  try {
    parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
  } catch {
    return { entities: [], relations: [] };
  }
  const byKey = new Map();
  for (const e of Array.isArray(parsed?.entities) ? parsed.entities : []) {
    const name = String(e?.name ?? '').trim().slice(0, 80);
    const key = normalizeEntityKey(name);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, {
      key,
      name,
      type: ENTITY_TYPES.includes(e?.type) ? e.type : 'concept',
      aliases: (Array.isArray(e?.aliases) ? e.aliases : []).map((a) => String(a).trim()).filter(Boolean).slice(0, 8),
    });
  }

  const relations = [];
  const seen = new Set();
  for (const r of Array.isArray(parsed?.relations) ? parsed.relations : []) {
    const relation = normalizeRelation(r?.relation);
    const sourceKey = normalizeEntityKey(r?.source);
    const targetKey = normalizeEntityKey(r?.target);
    if (!relation || !sourceKey || !targetKey || sourceKey === targetKey) continue;
    for (const [key, raw] of [[sourceKey, r?.source], [targetKey, r?.target]]) {
      if (!byKey.has(key)) byKey.set(key, { key, name: String(raw).trim().slice(0, 80), type: 'concept', aliases: [] });
    }
    const dedupKey = `${sourceKey}|${relation}|${targetKey}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const confidence = Number(r?.confidence);
    relations.push({
      sourceKey,
      targetKey,
      relation,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.7,
      evidence: String(r?.evidence ?? '').trim().slice(0, 200) || null,
    });
  }
  return { entities: [...byKey.values()], relations };
}

/**
 * IO: 对话 -> 结构化实体关系 (便宜模型, 低温)。失败降级为空结果, 不抛错 ——
 * 图谱是增强, 不能因为它挂了拖垮 observe 主链路。
 */
export async function extractKnowledge(turns, { subjectName = '对方', companionName = '她' } = {}) {
  const transcript = (turns ?? [])
    .map((t) => `${t.role === 'user' ? subjectName : companionName}: ${t.content}`)
    .join('\n');
  if (!transcript.trim()) return { entities: [], relations: [] };
  try {
    const res = await llm.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: `对方名字: ${subjectName}\n伴侣名字: ${companionName}\n\n对话:\n${transcript}` },
      ],
    });
    recordLlmCall('knowledge', res.usage);
    return parseKnowledgeExtraction(res.choices[0].message.content);
  } catch {
    return { entities: [], relations: [] };
  }
}
