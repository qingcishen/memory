// 编排器 · 纯本地拼接 (无 IO, 可直接单测)。
//
// 把各子系统 toPrompt() 的输出 + 短期历史 + 当前消息拼成喂给 LLM 的 messages 数组。
// 见 docs/DEVELOPMENT.md 与编排器设计方案 §6。

/** 按固定顺序拼接各子系统的自然语言段落, 跳过空串。 */
export function buildSystemPrompt({
  personaPrompt = '',
  relationshipPrompt = '',
  statePrompt = '',
  emotionPrompt = '',
  memoryBlock = '',
  monologue = '',
} = {}) {
  const sections = [personaPrompt, relationshipPrompt, statePrompt || emotionPrompt, memoryBlock];
  if (monologue && monologue.trim()) sections.push(`(你此刻的想法, 别直接说出来): ${monologue.trim()}`);
  return sections.filter((s) => s && s.trim()).join('\n\n');
}

/**
 * 拼出最终喂给回复模型的 messages: [system?, ...history(最近 historyTurns*2 条), user]。
 * history 为空或 system 为空串时对应部分被省略。
 */
export function assemble({ userMessage, history = [], historyTurns = 6, ...promptParts }) {
  const system = buildSystemPrompt(promptParts);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...history.slice(-historyTurns * 2));
  messages.push({ role: 'user', content: userMessage });
  return messages;
}

/**
 * 拼内心独白用的输入: 人格/关系/情绪/记忆段 + 当下情境 + 指令。
 * - 回复路径传 userMessage: 框成"对方刚说: ..."。
 * - 主动性路径传 situation (一段情境描述, 不是对方说的话, 不加"对方刚说"前缀)。
 */
export function buildMonologueContext({
  userMessage,
  situation,
  personaPrompt = '',
  relationshipPrompt = '',
  statePrompt = '',
  emotionPrompt = '',
  memoryBlock = '',
} = {}) {
  const parts = [personaPrompt, relationshipPrompt, statePrompt || emotionPrompt, memoryBlock].filter((s) => s && s.trim());
  parts.push(situation != null ? situation : `对方刚说: "${userMessage}"`);
  parts.push('写一句她此刻心里冒出来的真实想法 (不会说出口), 一两句话, 不要加引号或标签。');
  return parts.join('\n\n');
}
