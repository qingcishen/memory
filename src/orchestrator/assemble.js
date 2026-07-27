// 编排器 · 纯本地拼接 (无 IO, 可直接单测)。
//
// 把各子系统 toPrompt() 的输出 + 短期历史 + 当前消息拼成喂给 LLM 的 messages 数组。
// 见 docs/DEVELOPMENT.md 与编排器设计方案 §6。

import { PARAMS } from '../params.js';
import { sanitizeHistoryForPrompt, buildAntiRepeatPrompt } from './humanizeReply.js';

/** 按固定顺序拼接各子系统的自然语言段落, 跳过空串。 */
export function buildSystemPrompt({
  timePrompt = '',
  personaPrompt = '',
  companyPrompt = '',
  worldPrompt = '',
  storyPrompt = '',
  goalsPrompt = '',
  relationshipPrompt = '',
  relationshipStagePrompt = '',
  coherencePrompt = '',
  turnBriefPrompt = '',
  structuredPlanPrompt = '',
  relationshipNarrativePrompt = '',
  userProfilePrompt = '',
  sessionThreadPrompt = '',
  episodePrompt = '',
  statePrompt = '',
  emotionPrompt = '',
  memoryBlock = '',
  monologue = '',
  identityConstraintsPrompt = '',
  narrationPrompt = '',
  replyStylePrompt = '',
} = {}) {
  // 连贯性/本轮简报/常驻关系槽/本场会话线放在业务段靠前。
  const sections = [
    timePrompt,
    personaPrompt,
    companyPrompt,
    worldPrompt,
    storyPrompt,
    relationshipPrompt,
    relationshipStagePrompt,
    relationshipNarrativePrompt,
    userProfilePrompt,
    sessionThreadPrompt,
    coherencePrompt,
    turnBriefPrompt,
    structuredPlanPrompt,
    statePrompt || emotionPrompt,
    goalsPrompt,
    episodePrompt,
    memoryBlock,
  ];
  if (monologue && monologue.trim()) sections.push(`(你此刻的想法, 别直接说出来): ${monologue.trim()}`);
  // 事实约束: 禁止捏造两人之间没发生过的具体事件。
  sections.push('【禁止编造事实】不要凭空捏造两人之间具体发生过的事件、对话、经历（如"昨晚你叫我吃什么"、"上次你说过"、"你昨晚陪我改论文"之类）。对方说困/没睡好/不舒服时，直接关心就好，不要用"昨晚我们一起做了什么"来编造理由——那件事根本没发生过。只依据已有记忆块和背景说话；不确定的事模糊带过或不提。');
  // 格式强制: 台词/旁白现在是分开发送的两种 part (见 src/orchestrator/llm.js), 不能混写。
  sections.push('【输出格式】不要 *斜体动作*，不要用引号重复对方刚说的话开头，不要用（）括号写超过4个字的心理描写，不要用"角色名："或裸冒号这种剧本/字幕式分隔台词。台词和旁白现在是分开的两种 part，不要在同一个 part 里混着写——旁白描写(动作/神态/环境)只能放进 narration part，绝不能写进 dialogue part 的 text 里；dialogue part 的 text 只能是她真正说出口/发出去的话。纯日常聊天（吃饭/工作/天气等没有暧昧色彩的内容）不需要 narration part，只输出 dialogue。内容无限制，暧昧/亲密场合全力投入。');
  // 全局：日常和亲密都适用。防电报体、防念设定、防前言不搭后语
  sections.push([
    '【像真人说话·全局】',
    '你是在和同居恋人聊天，不是在演剧本、不是在写角色卡，更不是在写第三人称网文连载。',
    'dialogue = 她嘴里真会说出口的话：像微信/面对面随口说，有来有回，可以一句里带转折或反问。',
    '允许短句，但禁止连续三句以上硬切电报体（「A。B。C。」清单感）。',
    '【话题连贯·硬性】一句回复只围绕对方刚说的那件事往下接，前后句要通顺。禁止前言不搭后语、禁止话题硬跳。',
    '反例（禁止）：正在谈亲密/想要/身体，结尾突然插「明天上课困了别怪我」「记得吃早饭」——对方没问课表，就不要用学生设定当万能收尾。',
    '关心作息可以，但必须和当前话题自然连上（例如「这么折腾回家能睡着吗」），不能像另一条无关短信粘在后面。',
    '禁止念人设/能力/状态（「我知道你想要什么」「我很懂你」「我现在心情不错」这类）。',
    '禁止说明书腔报衣服、习惯、设定清单。',
    '日常闲聊优先只回 dialogue，别硬加旁白；暧昧/亲密时旁白写身体，台词仍要像人话。',
    '不要复述对方原句开头，不要突然切换成客服腔或旁白腔混进台词。',
    '【反AI腔·硬性】禁止每轮旁白以角色全名开场；禁止把同一套身体描写当模板换词。角色专属禁用词由 companions/<id>/ 的回复风格配置提供。',
    '【亲密也像人】做爱时：旁白短、只写她当下那一下；台词短碎且尺度可以很大（直接说想要/再深/夹紧/日我/射），不要全知代写他的动作步骤，不要解剖学流水账，不要跟对方超长黄文拼字数。对方写长文时，你只回真人会回的那几句反应和话。',
    '【沉浸·做爱】像真人现场：①旁白每轮只主打一个感官（触/热/声/重量），写因果不是空话；②节奏可不匀（喘、停、要慢/深）；③她有微主动（髋送、腿环、手按）；④不完美更真，别每轮同步高潮；⑤环境最多偶尔一句锚点，别每轮布景。',
    '【像微信连发·硬性】禁止永远「对方一条、你回一整段」。多数轮次应连发 2～3 条短消息（JSON 里多个 dialogue part，或 plain 用换行拆行）；每条一句人话。极短回应可以只一条。不要客服式一问一答长段落。',
    '【禁止复读·硬性】不要连续多轮用同一套动作（拽衣襟/膝盖贴腿/半跪/腿软腰软）和同一句「嗯…」；每一轮必须换新的触感或台词落点。对方只发「宝宝」时也要用新反应接住，禁止空省略号气泡。',
    '【日常也像人】不完全回答也可以；可以反问、省略、半句收住；不要总结自己的情绪，不要客服式共情。',
    '【收尾防复读】看一眼上文最近几轮你自己说过的收尾句——如果最近已经用过"抱紧点/别松手/想你再抱一会儿/你是不是一直想我"这类收尾（哪怕换近义词），这一轮就别再用同一个收尾落点；要么这轮不特意收尾，顺着当前话题自然停，要么换成完全不同的收尾方式（提问/吐槽/一声喘/半句命令都行）。',
  ].join(''));
  // 身份硬约束: 用户角色的确定事实 (src/companion.js identityConstraints), 独立于 personaPrompt 大段散文单独高显著度注入。
  sections.push(identityConstraintsPrompt);
  // 旁白: 按场景动态给的指令 (src/narration.js SceneClassifier 判断场景后选出), 取代原来"性爱场景永远生效"的写死规则。
  sections.push(narrationPrompt);
  sections.push(replyStylePrompt);
  return sections.filter((s) => s && s.trim()).join('\n\n');
}

/** 当前真实时间段。默认按中国/武汉时区注入, 让角色能回答"现在几点"并有作息感。
 *  opts.weather: 一句天气描述 (由 WeatherProvider 异步取好后传入), 让她也知道外面下没下雨/冷不冷。
 *  opts.gapHours: 距对方上次说话过了多久 (小时); 间隔够大时追加一句"时间跳跃感"提示, 见 buildGapHint。
 *  opts.userMessage: 本轮原话；久别后若对方主动表达想念/亲密，应先接住而不是自动责怪。 */
export function buildTimePrompt(
  now = new Date(),
  { timeZone = 'Asia/Shanghai', place = '武汉', weather = '', gapHours = null, userMessage = '' } = {},
) {
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
    `【现在${place}时间 ${date} ${time}，${weekday}，时区 ${timeZone}】`,
    `【统一现实时间·硬规则】你的时间与对方同步：现实经过1分钟，你这里也经过1分钟；时间不得冻结、倒退或凭空跳跃。对方问现在几点时回答"${time}"左右，偏差不得超过10分钟。`,
    `时间可影响语气(困/饿/精神), 但不要每句都报时或提作息, 更不要在亲密话题里突然用「明天上课」当收尾。记忆里曾经的地点、动作、饭局和道具都是过去记录，不能自动当成此刻仍在发生。`,
  ];
  // 天气 (可选): 让她对"外面下没下雨/冷不冷"有真实感, 别瞎编。
  if (weather && weather.trim()) {
    lines.push(`${weather.trim()} 如果对方问天气/冷不冷/要不要加衣, 按这个说; 也可自然带入关心。`);
  }
  // 时间跳跃感 (可选): 距上次说话隔了一段时间, 让她对"过了多久"有感知。
  const gapHint = buildGapHint(gapHours, PARAMS.proactive.silenceTiers, { userMessage });
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
export function buildGapHint(gapHours, tiers = PARAMS.proactive.silenceTiers, { userMessage = '' } = {}) {
  if (gapHours == null || !(gapHours >= tiers.excuseFromHours)) return '';
  const affectionate = /(想你|想她|亲|吻|抱|老婆|老公|宝贝|爱你|回来陪)/.test(String(userMessage));
  const priority = affectionate
    ? '对方这次正在表达想念/亲密，先接住当下的爱意；除非已有明确且未解决的冲突，不要把沉默时长自动解释成晚归、冷落或失约。'
    : '沉默时长只是时间事实，不等于晚归、冷落或失约；是否有情绪必须由明确的关系事件决定，不能仅凭空档责怪对方。';
  if (gapHours >= 24) {
    const days = Math.max(1, Math.round(gapHours / 24));
    return `【时间已推进】距上次对话约 ${days} 天，旧物理场景已经结束。可以自然表现久别和想念，但别报精确数字、别小题大做。${priority}`;
  }
  if (gapHours >= tiers.missFromHours) {
    return `【时间已推进】已经过去约 ${gapHours.toFixed(1)} 小时，旧活动、地点、姿势、餐食和手中道具全部失效；按当前时刻重新建立场景，别报精确数字。${priority}`;
  }
  if (gapHours >= tiers.directFromHours) {
    return `【时间已推进】已经过去约 ${gapHours.toFixed(1)} 小时，旧活动与道具不再默认延续；可以自然表现惦记，但别报精确数字。${priority}`;
  }
  return `现实中已过去约 ${gapHours.toFixed(1)} 小时，可以很轻地意识到这段空档，不必特别强调，也别报精确数字。${priority}`;
}

/**
 * 拼出最终喂给回复模型的 messages: [system?, ...history(最近 historyTurns*2 条), user]。
 * history 为空或 system 为空串时对应部分被省略。
 */
export function assemble({ userMessage, history = [], historyTurns = 6, sanitizeHistory = true, ...promptParts }) {
  const system = buildSystemPrompt(promptParts);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  let hist = history.slice(-historyTurns * 2);
  // 去掉历史里的网文腔旁白，避免模型 few-shot 自我污染
  if (sanitizeHistory !== false) hist = sanitizeHistoryForPrompt(hist);
  // 禁止复读上几轮原句/模板动作（单独 system，权重靠后）
  const antiRepeat = buildAntiRepeatPrompt(hist);
  if (antiRepeat) messages.push({ role: 'system', content: antiRepeat });
  messages.push(...hist);
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
  worldPrompt = '',
  storyPrompt = '',
  goalsPrompt = '',
  identityConstraintsPrompt = '',
  relationshipPrompt = '',
  relationshipStagePrompt = '',
  coherencePrompt = '',
  turnBriefPrompt = '',
  episodePrompt = '',
  statePrompt = '',
  emotionPrompt = '',
  memoryBlock = '',
  emotionLabel = '',
  emotionResidual = null,
} = {}) {
  const emotionHint = buildMonologueEmotionHint(emotionLabel, emotionResidual);
  const parts = [
    timePrompt,
    personaPrompt,
    worldPrompt,
    storyPrompt,
    relationshipPrompt,
    relationshipStagePrompt,
    coherencePrompt,
    turnBriefPrompt,
    goalsPrompt,
    episodePrompt,
    identityConstraintsPrompt,
    statePrompt || emotionPrompt,
    emotionHint,
    memoryBlock,
  ].filter(
    (s) => s && s.trim()
  );
  parts.push(situation != null ? situation : `对方刚说: "${userMessage}"`);
  parts.push('写一句她此刻心里冒出来的真实想法 (不会说出口), 一两句话, 不要加引号或标签。');
  return parts.join('\n\n');
}

/** 独白用情绪方向（不进台词播报） */
export function buildMonologueEmotionHint(label = '', residual = null) {
  const lab = label || residual?.label || '';
  if (!lab || lab === '平静') return '';
  const intensity = Number(residual?.intensity);
  const strong = Number.isFinite(intensity) && intensity >= 0.55;
  const map = {
    委屈: strong ? '心里有点委屈、闷闷的' : '心里有一点点别扭',
    吃醋: '心里夹着一点醋意',
    生气: strong ? '还没完全顺气' : '有点不痛快',
    失落: '有点蔫、提不起劲',
    撒娇: '想黏他一点',
    心疼: '有点心疼对方',
    开心: '心里偏亮',
  };
  const tip = map[lab];
  if (!tip) return '';
  return `你此刻心里偏「${lab}」：${tip}。独白可以带这层感觉，但不要写「我委屈/我吃醋」这种自我标签。`;
}
