import { llm, LLM_MODEL, PARAMS } from './config.js';
import { normalizeMemory } from './ontology.js';

const EXTRACT_SYSTEM = `你是一个记忆提取器, 服务于一个 AI 伴侣。
从给定对话中提取值得"长期记住"的信息。只提取持久的事实、重要事件、明确的偏好或关系变化。
忽略寒暄、闲聊、临时性的话。宁缺毋滥。

每条记忆把"客观事实"与"情感色彩"分开输出:
- type: "fact" | "episode" | "preference" | "relationship"
- fact_core: 不带主观色彩的客观事实陈述, 第三人称, 主语用对方的名字。例如 "诗雅讨厌香菜"。这层将被永久保存、永不改写, 所以只写事实, 别写评价。
- narrative: (可选) 她当下对这件事的主观解读/感受, 例如 "她说起香菜时皱了下眉, 大概是真的很抗拒"。没有就给 null。
- subject_kind: 这条记忆属于谁 —— "user"(关于对方的事) / "self"(她对自己的设定, 如她自述的喜好) / "dyad"(你俩共有的, 如"我们一起看了那场雨")
- importance: 1-10。生日/重要承诺/重大事件=8-10; 明确偏好=4-6; 一般信息=3-4; 琐事不要提取
- fact_locked: true 仅用于绝对不容出错的硬事实(生日、名字、明确承诺), 其余 false
- affect: {"valence": -1..1, "intensity": 0..1} —— 这件事的情绪正负向与强度

严格输出 JSON: {"memories": [...]}。没有可记的就输出 {"memories": []}。
不要输出 JSON 以外的任何内容, 不要用 markdown 代码块。`;

/**
 * 从最近若干轮对话里提取记忆。
 * @param {Array<{role:string, content:string}>} turns
 * @param {string} subjectName 对方的名字, 用于 content 主语
 * @returns {Promise<Array>} 提取出的记忆 (未含 embedding)
 */
export async function extractMemories(turns, subjectName = '用户') {
  const transcript = turns
    .map((t) => `${t.role === 'user' ? subjectName : 'AI'}: ${t.content}`)
    .join('\n');

  const res = await llm.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `对方名字: ${subjectName}\n\n对话:\n${transcript}` },
    ],
  });

  let parsed;
  try {
    parsed = JSON.parse(res.choices[0].message.content);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed.memories) ? parsed.memories : [];

  // 规范化成两层本体 (ontology.normalizeMemory 负责裁剪/补默认) + 过滤低重要性
  return list
    .map((m) => normalizeMemory(m))
    .filter((m) => m.fact_core && m.importance >= PARAMS.minImportance);
}

/**
 * 情绪 → 记忆重要性 (emotion-design.md §8): 本轮心情位移越大, 说明发生的事越"要紧",
 * 给这一轮提取出的记忆 importance 一点加成(按 PARAMS.moodShiftImportanceBoost, 夹在 1-10 内)。
 * @param memories extractMemories 的结果
 * @param moodShift moodShiftMagnitude(before, after) 的值
 */
export function applyMoodShiftBoost(memories, moodShift = 0) {
  const { threshold, maxShift, maxBoost } = PARAMS.moodShiftImportanceBoost;
  if (memories.length === 0 || !(moodShift > threshold)) return memories;
  const ratio = Math.min(1, (moodShift - threshold) / (maxShift - threshold));
  const boost = maxBoost * ratio;
  return memories.map((m) => ({ ...m, importance: Math.min(10, m.importance + boost) }));
}
