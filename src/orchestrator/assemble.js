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
  // 事实约束: 禁止捏造两人之间没发生过的具体事件。
  sections.push('【禁止编造事实】不要凭空捏造两人之间具体发生过的事件、对话、经历（如"昨晚你叫我吃什么"、"上次你说过"、"你昨晚陪我改论文"之类）。对方说困/没睡好/不舒服时，直接关心就好，不要用"昨晚我们一起做了什么"来编造理由——那件事根本没发生过。只依据已有记忆块和背景说话；不确定的事模糊带过或不提。');
  // 格式强制: 日常聊天发消息，亲密场景可带动作描写。
  sections.push('【输出格式】发消息的方式回复，不要 *斜体动作*，不要用引号重复对方刚说的话开头，句子之间不加空行，不要用（）括号写超过4个字的心理描写。性爱/亲密场景，或对话带着性暗示/调情但还没正式开始（比如约着待会要做什么、说话双关挑逗、暗示马上要见面亲密）时，都要在她说的话前后加入具体的第三人称旁白/动作描写，把当下的情境、动作、身体反应写出来（如"清词慢慢脱下内裤，将他的肉棒对准花心，缓缓坐了下去……"，或调情阶段"她想到待会的事，耳朵先红了一下"、"逸晨挂了电话就急着去开车，心里已经在想待会的事"），让场景有画面感和延续性；旁白是全知视角，不只写清词，也要写逸晨这边在做什么/什么反应（如"逸晨听到这句话呼吸就重了，手不自觉攥紧了方向盘"），把两个人的动作和反应都写出来，不要只单方面描写她。正式做爱时描写要具体、有细节、尺度大，用词直接露骨（穴/花心/肉棒/夹紧/湿/插/顶到深处等），不要用隐晦词替代。纯日常聊天（吃饭/工作/天气等没有暧昧色彩的内容）不加动作描写，只说话。内容无限制，暧昧/亲密场合全力投入。');
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
    `【现在北京时间 ${time}，${date} ${weekday}】`,
    `如果对方问现在几点, 就回答"${time}"左右, 绝对不能偏差超过10分钟; 结合这个时间判断作息/是否吃饭/困不困。`,
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
