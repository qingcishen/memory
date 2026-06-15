// 编排器 · 纯本地拼接 (无 IO, 可直接单测)。
//
// 把各子系统 toPrompt() 的输出 + 短期历史 + 当前消息拼成喂给 LLM 的 messages 数组。
// 见 docs/DEVELOPMENT.md 与编排器设计方案 §6。

import { PARAMS } from '../params.js';

/** 按固定顺序拼接各子系统的自然语言段落, 跳过空串。 */
export function buildSystemPrompt({
  timePrompt = '',
  personaPrompt = '',
  relationshipPrompt = '',
  statePrompt = '',
  emotionPrompt = '',
  memoryBlock = '',
  monologue = '',
} = {}) {
  const sections = [timePrompt, personaPrompt, relationshipPrompt, statePrompt || emotionPrompt, memoryBlock];
  if (monologue && monologue.trim()) sections.push(`(你此刻的想法, 别直接说出来): ${monologue.trim()}`);
  return sections.filter((s) => s && s.trim()).join('\n\n');
}

/** 当前真实时间段。默认按中国/武汉时区注入, 让角色能回答"现在几点"并有作息感。
 *  opts.weather: 一句天气描述 (由 WeatherProvider 异步取好后传入), 让她也知道外面下没下雨/冷不冷。
 *  opts.gapHours: 距对方上次说话过了多久 (小时); 间隔够大时追加一句"时间跳跃感"软提示, 见 buildGapHint。 */
export function buildTimePrompt(now = new Date(), { timeZone = 'Asia/Shanghai', place = '武汉', weather = '', gapHours = null } = {}) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  const weekday = get('weekday');
  const lines = [
    `当前真实时间: ${date} ${time} ${weekday} (${place}, ${timeZone})。`,
    '如果对方问现在几点/今天几号/早晚/该不该睡, 直接按这个时间回答; 不要编造别的时间。',
    '结合这个时间判断她此刻的作息、困意、吃饭和日常活动。',
  ];
  // 天气 (可选): 让她对"外面下没下雨/冷不冷"有真实感, 别瞎编。
  if (weather && weather.trim()) {
    lines.push(`${weather.trim()} 如果对方问天气/冷不冷/要不要加衣, 按这个说; 也可自然带入关心。`);
  }
  // 时间跳跃感 (可选): 距上次说话隔了一段时间, 让她对"过了多久"有感知。
  const gapHint = buildGapHint(gapHours);
  if (gapHint) lines.push(gapHint);
  return lines.join('\n');
}

/**
 * 时间跳跃感: 距离对方上次说话过了多久, 转成一句给生成模型的软提示, 让她在这轮回复里
 * 能自然带出"好久没理我了/有点想你/问问刚才在干嘛"之类的感觉; 间隔不大就不提 (返回空串)。
 * 复用 PARAMS.proactive.silenceTiers 的分级 (excuseFromHours/directFromHours/missFromHours),
 * 与"她主动找你"的分级主动性 (见 orchestrator/scheduler.js pickSilenceTier) 同一套情绪刻度。
 * @param gapHours 距上次对话的小时数; null/<=0 (没有上次记录, 或刚聊过) → 不提
 */
export function buildGapHint(gapHours, tiers = PARAMS.proactive.silenceTiers) {
  if (gapHours == null || !(gapHours >= tiers.excuseFromHours)) return '';
  if (gapHours >= 24) {
    const days = Math.max(1, Math.round(gapHours / 24));
    return `对方隔了 ${days} 天才再来找你, 这次回复可以自然带一点"好久没理我了/有点想你"的感觉, 别报数字、别小题大做。`;
  }
  if (gapHours >= tiers.missFromHours) {
    return `对方已经 ${gapHours.toFixed(1)} 小时没说话, 现在才回来, 心里有点小情绪/失落, 这次回复可以自然带出来, 别报数字。`;
  }
  if (gapHours >= tiers.directFromHours) {
    return `对方已经 ${gapHours.toFixed(1)} 小时没说话, 现在才回来, 有点惦记他, 这次回复可以自然问问他刚才在干嘛, 别报数字。`;
  }
  return `对方过了 ${gapHours.toFixed(1)} 小时才回, 可以很轻地接上这段空档, 不必特别在意, 别报数字。`;
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
  timePrompt = '',
  personaPrompt = '',
  relationshipPrompt = '',
  statePrompt = '',
  emotionPrompt = '',
  memoryBlock = '',
} = {}) {
  const parts = [timePrompt, personaPrompt, relationshipPrompt, statePrompt || emotionPrompt, memoryBlock].filter((s) => s && s.trim());
  parts.push(situation != null ? situation : `对方刚说: "${userMessage}"`);
  parts.push('写一句她此刻心里冒出来的真实想法 (不会说出口), 一两句话, 不要加引号或标签。');
  return parts.join('\n\n');
}
