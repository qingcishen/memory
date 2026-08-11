// B1 · 离散情绪推断。规则优先、纯函数、可解释。
// E1：可选 residual 惯性，避免金鱼情绪。
import { applyLabelInertia, normalizeEmotionResidue } from './emotionResidue.js';

export const EMOTION_LABELS = [
  '平静', '开心', '委屈', '吃醋', '生气', '失落', '撒娇', '心疼',
  '期待', '担心', '害羞', '暧昧', '感动', '无聊', '骄傲', '烦躁',
];

/**
 * @param state
 * @param desires
 * @param lastTurns
 * @param opts {{ previousResidual?, userMessage?, now?, recoverBias?, withResidual?: boolean }}
 * @returns string | { label, residual, rawLabel }
 */
export function inferEmotionLabel(state = {}, desires = {}, lastTurns = [], opts = {}) {
  const rawLabel = inferEmotionLabelRaw(state, desires, lastTurns);
  if (opts.withResidual === false && !opts.previousResidual) return rawLabel;

  const userMessage =
    opts.userMessage ??
    [...(lastTurns || [])].reverse().find((t) => t?.role === 'user')?.content ??
    '';
  const emotion = state?.emotion ?? state?.mood ?? {};
  const relationship = state?.relationship ?? {};
  const { label, residual } = applyLabelInertia(opts.previousResidual, rawLabel, {
    userMessage,
    relationship,
    valence: emotion.valence ?? state?.mood?.valence,
    emotion,
    now: opts.now,
    recoverBias: opts.recoverBias,
  });

  if (opts.withResidual || opts.previousResidual != null) {
    return {
      label,
      residual,
      rawLabel,
      confidence: emotionHeuristicConfidence(userMessage, rawLabel),
    };
  }
  // 无残留上下文时保持旧 API：只返回字符串
  return label;
}

/** 无惯性的原始规则标签（单测/调试用） */
export function inferEmotionLabelRaw(state = {}, desires = {}, lastTurns = []) {
  const emotion = state?.emotion ?? state?.mood ?? {};
  const relationship = state?.relationship ?? {};
  const valence = clamp(Number(emotion.valence) || 0, -1, 1);
  const warmth = clamp(Number(emotion.warmth ?? relationship.closeness ?? 0.5) || 0, 0, 1);
  const closeness = clamp(Number(relationship.closeness ?? warmth) || 0, 0, 1);
  const tension = clamp(Number(relationship.tension) || 0, 0, 1);
  const repairDebt = clamp(Number(relationship.repair_debt) || 0, 0, 1);
  const attention = clamp(Number(desires?.attention) || 0, 0, 1);
  const comfort = clamp(Number(desires?.comfort) || 0, 0, 1);
  const security = clamp(Number(desires?.security) || 0, 0, 1);
  const userText = recentText(lastTurns, 'user');
  const companionText = recentText(lastTurns, 'assistant');

  // 吃醋：放宽 closeness 门槛（F2 实测: 全部吃醋样本 closeness ≤ 0.6）；
  // 同时补充「新来的女同事」等无量词前缀的常见说法
  if (
    closeness >= 0.45 &&
    (/(别的|其他|那个|有个|一个|一位|新来的|来了.{0,3}个).{0,16}(女生|女孩|姑娘|小姐姐|女同事|女朋友)|前女友|她好漂亮|跟她约会|喜欢上她|漂亮的女|女同事.{0,10}(找我|聊|讨论)/u.test(userText))
  ) {
    return '吃醋';
  }
  // 被冷落/失联类口吻：不依赖 desire.attention 已攒高（新会话首轮也要能挂上委屈）
  if (
    /(不回我|不理我|把我忘|忘了我|冷落|都不回|不找我|是不是不想理|是不是把我忘|消失了|已读不回)/u.test(userText) ||
    /(这几天|好久|很久|半天).{0,8}(不回|不理|不找|没回|消失)/u.test(userText)
  ) {
    return '委屈';
  }
  // attention 积累驱动的委屈（依赖 desire 先升高后触发，不误判无 attention 的新会话）
  if (attention >= 0.72 && userText) return '委屈';
  // 明确愤怒必须先于「算了」类释怀词判断；“算了吧，我很生气”不是已经和好。
  // “别生气/对不起”里的 anger 指向对方，不代表说话者仍在发怒。
  const explicitRepair = /(对不起|抱歉|我错了|原谅|和好|别生气)/u.test(userText);
  const explicitAnger =
    !explicitRepair && (
      /(我很生气|气死|太过分了|你凭什么)/u.test(userText) ||
      (/(你怎么这样|算了吧)/u.test(userText) && /(生气|烦|讨厌|分手)/u.test(userText))
    );
  if (explicitAnger) return '生气';
  // 和好/释怀语境：repair 场景完成，余情是失落而非委屈
  if (/(说开了|和好了|和好吧|没事了|放下了|算了)/u.test(userText) && repairDebt >= 0.1) return '失落';
  if (/(对不起|抱歉|我错了|原谅我|别生气)/u.test(userText) && repairDebt > 0.2) return '委屈';
  // 用户表达受伤/失望 → 委屈（F2补充：侧重"让我"句式与情感词）
  if (/(让我.{0,8}(难受|伤心|失望|心寒|委屈)|说那句话|让我很|我不是小题大做|站在我这边)/u.test(userText)) {
    return '委屈';
  }
  // E-1: 明确的新标签证据要先于宽泛的“开心/失落/心疼”数值兜底。
  // 例如“好期待”和“谢谢你懂我”不能先被旧的开心关键词吞掉。
  const extended = inferExtendedEmotionEvidence({
    userText,
    companionText,
    closeness,
    tension,
    repairDebt,
  });
  if (extended) return extended;
  // 用户生病/受苦 → 心疼（需要更高 closeness，低亲密度时倾向于失落）
  if (/(我|最近|今天).{0,8}(难过|伤心|哭了|生病|发烧|不舒服|被欺负|很累|好累|崩溃|失败|失眠|睡不着|头疼|头晕)|被.{0,8}(骂|拒绝|裁员|开除)/u.test(userText) && closeness >= 0.6) {
    return '心疼';
  }
  // 用户忙碌/压力/焦虑 → 失落（F2实测: 这类场景 GLM 多标失落）
  if (
    /(忙疯了|加班到|顶不住|忙得|加班|这几天.{0,10}(没顾上|没时间|不|忙)|心里发慌|睡不着|睡不好|失眠|明天.{0,8}(面试|汇报|发布|交付)|发慌|忧虑)/u.test(userText) ||
    /(陪我说说话|陪陪我)/u.test(userText)
  ) {
    if (valence <= 0.15) return '失落';
  }
  if ((tension >= 0.62 || repairDebt >= 0.55) && /(吵|生气|烦|滚|别理|分手|讨厌|失望|对不起|抱歉)/u.test(`${userText}\n${companionText}`)) {
    return '生气';
  }
  if (security >= 0.58 && closeness >= 0.55 && tension < 0.55) return '委屈';
  if (comfort >= 0.58 && closeness >= 0.68 && tension < 0.4) return '撒娇';
  // 失落：扩大 valence 区间（F2 实测: 失落样本 valence 多在 [-0.3, 0.1]）
  if (valence <= -0.08) return tension >= 0.45 || repairDebt >= 0.35 ? '委屈' : '失落';
  // 开心文本信号：valence ≈ 0 时才需要文本提升（v > 0.02 已有足够正向信号）
  if (/(给你带|帮你|为你|记得我|想看看你|换我来|别跟我抢|你别担心|记得叫我|好期待|太好了|谢谢你懂我)/u.test(userText) && closeness >= 0.4 && valence <= 0.02) {
    return warmth >= 0.92 && closeness >= 0.78 ? '撒娇' : '开心';
  }
  // 开心：valence 门槛适度提高到 0.25，同时排除纯问候（在吗/你好/晚安）误报
  if (valence >= 0.25) {
    if (/(^在吗$|^在\?$|^在？$|^你好$|^hello$|^hi$|晚安|好的|嗯|好|哦|啊|噢)/iu.test(userText.trim()) && valence < 0.55) {
      return '平静';
    }
    return warmth >= 0.92 && closeness >= 0.78 ? '撒娇' : '开心';
  }

  return '平静';
}

function inferExtendedEmotionEvidence({
  userText = '',
  companionText = '',
  closeness = 0,
  tension = 0,
  repairDebt = 0,
} = {}) {
  if (
    closeness >= 0.5 &&
    /(记得你说过|帮你记着|特意|专门|就是为了你|第一个想到你|你不是一个人|我会陪着你|我支持你|谢谢你懂我|真的懂我|一直陪着你)/u.test(userText)
  ) {
    return '感动';
  }
  if (
    /(好期待|期待死了|迫不及待|下次见|什么时候见|还有几天|明天.{0,8}(见|约|去)|周末.{0,8}(见|约|去|一起)|终于等到|快了吧)/u.test(userText) ||
    /(好期待|期待死了|迫不及待)/u.test(companionText)
  ) {
    return '期待';
  }
  if (
    /(我做到了|成功了|拿到了|考过了|晋升了|录取了|赢了|第一名|offer|通过了|终于完成|做出来了)/iu.test(userText)
  ) {
    return '骄傲';
  }
  if (
    tension < 0.4 &&
    repairDebt < 0.3 &&
    /(烦死了|快被逼疯|搞不定|乱七八糟|哪都是问题|什么破|太乱了|脑子转不动|忙得烦|一堆事|烦透了)/u.test(userText)
  ) {
    return '烦躁';
  }
  if (
    /(好无聊|无聊死了|没事做|不知道干嘛|闲着没事|好无趣|没意思|干嘛好|打发时间|随便聊|没什么事)/u.test(userText)
  ) {
    return '无聊';
  }
  if (
    closeness >= 0.5 &&
    /(你好可爱|你好漂亮|你好美|你真的很迷人|你让我心动|我好喜欢你|喜欢你|爱你|你是最|你最好|你真棒|夸你)/u.test(userText)
  ) {
    return '害羞';
  }
  if (
    closeness >= 0.55 &&
    tension < 0.25 &&
    /(心跳|脸红|好近|在想你|不知道该|有点不一样|好奇怪|说不清楚|感觉不对劲|心里有什么)/u.test(`${userText}\n${companionText}`)
  ) {
    return '暧昧';
  }
  if (
    closeness >= 0.5 &&
    /(你注意安全|路上小心|好好照顾自己|记得吃饭|你没事吧|还好吗|身体怎么样|别太拼|不会有事吧|我有点担心|担心你|明天.{0,8}(面试|手术|考试)|一个人.{0,8}(开夜车|走夜路)|好害怕|压力好大|要崩了)/u.test(userText)
  ) {
    return '担心';
  }
  return null;
}

/**
 * 标签 → 可观察说话指引（禁自我播报数值）
 */
export function emotionLabelToPrompt(label = '平静', residual = null) {
  const intensity = residual?.intensity != null ? Number(residual.intensity) : 0;
  const strong = intensity >= 0.55;
  const map = {
    平静: '',
    开心: strong
      ? '【情绪表现】这会儿心里偏亮，语气可以轻快一点、愿意多接一句，但别写成假亢奋，也别说「我好开心」。'
      : '【情绪表现】心情还行，自然一点就好，别刻意表演开心。',
    委屈: strong
      ? '【情绪表现】心里有点委屈：话少、带点别扭或欲言又止，可以闷，但别连环质问、别播报「我委屈」。'
      : '【情绪表现】有一点闷：回得短一点、软一点别扭即可，别大吵。',
    吃醋: '【情绪表现】夹着一点醋意：语气可别扭、试探，嘴硬心软，别审讯、别列罪证。',
    生气: strong
      ? '【情绪表现】明显不痛快：极短、冷一点，可以留缝，别判死刑，也别长篇讲道理。'
      : '【情绪表现】有点火气：话收着，别突然粘人撒娇。',
    失落: '【情绪表现】有点蔫：语气轻、慢半拍，别假开朗硬撑。',
    撒娇: '【情绪表现】可以黏一点、任性一点，像恋人随口撒娇，别油、别喊口号。',
    心疼: '【情绪表现】先接住对方的难受/累，关心落在具体处，少把话题拧回自己。',
    期待: '【情绪表现】有点小雀跃，轻轻流露就好，别把期待演成催促或过分热闹。',
    担心: '【情绪表现】带着点挂心，关切落在具体的事上，别变成反复确认的唠叨。',
    害羞: '【情绪表现】有点窘，绕一下再接，别太快直直地接受赞美或表白。',
    暧昧: '【情绪表现】语气可以软近一点，带一点欲言又止，别直白打破气氛。',
    感动: '【情绪表现】心里有点热，话轻一点，别用大词渲染，也别马上转话题。',
    无聊: '【情绪表现】有点无精打采，想找点事但又提不起劲，语气可以散漫。',
    骄傲: '【情绪表现】有点小得意，可以轻描淡写带一句，别吹大了或主动炫耀。',
    烦躁: '【情绪表现】有点坐不住，话可以短一点急一点，是焦不是发脾气。',
  };
  const line = map[label] ?? '';
  if (!line) return '';
  if (residual?.cause && NEGATIVE.has(label)) {
    return `${line}\n（余味来自不久前的相处，自然带连续性即可，不要复述原因清单。）`;
  }
  return line;
}

const NEGATIVE = new Set(['委屈', '吃醋', '生气', '失落', '担心', '烦躁']);

// ── E-3: LLM 情绪推断触发策略 ──────────────────────────────────────────────

// 启发式已能直接解释的显式信号。长文本没有这些信号时，才值得交给 LLM
// 处理反语、委婉和上下文依赖；短问候/纯表情不触发。
const HEURISTIC_EMOTION_SIGNAL_RE =
  /生气|气死|过分|讨厌|委屈|难受|伤心|失望|心寒|哭|发烧|不舒服|很累|好累|崩溃|失败|失眠|睡不着|焦虑|发慌|担心|害怕|烦死|烦躁|无聊|没意思|喜欢你|爱你|想你|脸红|心跳|期待|迫不及待|成功了|做到了|录取|晋升|谢谢|感动|对不起|抱歉|和好|不回我|不理我|前女友|女同事/u;

/**
 * 对规则标签给出可解释置信度。这里只判断“规则是否看见了明确文本证据”，
 * 不冒充统计模型概率：长而无显式信号的中性结果为低置信度，触发 E-3。
 */
export function emotionHeuristicConfidence(text = '', label = '平静') {
  const value = String(text ?? '').trim();
  if (!value) return label === '平静' ? 0.65 : 0.72;
  if (HEURISTIC_EMOTION_SIGNAL_RE.test(value)) return 0.9;
  if (label !== '平静') return 0.72;
  return [...value].length > 15 ? 0.35 : 0.65;
}

/**
 * 判断本轮是否值得花 LLM 做情绪分类。
 * 新调用协议：shouldLLMInfer(text, {
 *   confidence, currentTurn, lastInferTurn, pending
 * })
 * 只在 confidence < 0.5、文本 > 15 字、没有尚未完成任务，且距上次触发至少
 * 3 轮时返回 true。数字旧签名仍兼容，但仅用于旧调用方平滑迁移。
 */
export function shouldLLMInfer(text = '', context = {}, legacyInferCount = 0) {
  const t = String(text ?? '').trim();
  if ([...t].length <= 15) return false;

  const legacy = typeof context === 'number';
  const currentTurn = Math.max(
    0,
    Math.floor(Number(legacy ? context : context.currentTurn) || 0),
  );
  const confidence = Number(
    legacy
      ? emotionHeuristicConfidence(t, '平静')
      : context.confidence ?? emotionHeuristicConfidence(t, context.label),
  );
  if (!Number.isFinite(confidence) || confidence >= 0.5) return false;
  if (!legacy && context.pending) return false;

  if (legacy) {
    const inferCount = Math.max(0, Number(legacyInferCount) || 0);
    return inferCount === 0 || currentTurn / inferCount >= 3;
  }
  const lastInferTurn =
    context.lastInferTurn != null &&
    Number.isFinite(Number(context.lastInferTurn))
      ? Number(context.lastInferTurn)
      : null;
  return lastInferTurn == null || currentTurn - lastInferTurn >= 3;
}

/**
 * 启动一个非阻塞 LLM 分类任务。状态对象会在 promise 完成时原地变为
 * settled；下一轮只读取已完成值，不在回复链上等待网络。
 */
export function startLLMEmotionInference(
  text,
  llmCall,
  { sourceTurn = 0 } = {},
) {
  const task = {
    status: 'pending',
    label: null,
    sourceTurn: Math.max(0, Math.floor(Number(sourceTurn) || 0)),
    promise: null,
  };
  task.promise = llmInferEmotionLabel(text, llmCall)
    .then((label) => {
      task.status = 'settled';
      task.label = EMOTION_LABELS.includes(label) ? label : null;
      return task.label;
    })
    .catch(() => {
      task.status = 'settled';
      task.label = null;
      return null;
    });
  return task;
}

/**
 * 消费已经完成的上一轮结果。pending 任务不会阻塞；悬挂超过 maxPendingTurns
 * 会被丢弃，让后续轮次可以再次尝试。
 */
export function consumeLLMEmotionInference(
  task,
  { currentTurn = 0, maxPendingTurns = 3 } = {},
) {
  if (!task) return { label: null, task: null, consumed: false };
  if (task.status === 'settled') {
    return {
      label: EMOTION_LABELS.includes(task.label) ? task.label : null,
      task: null,
      consumed: true,
    };
  }
  const age = Math.max(0, Number(currentTurn) - Number(task.sourceTurn || 0));
  if (age >= Math.max(1, Number(maxPendingTurns) || 3)) {
    return { label: null, task: null, consumed: false, expired: true };
  }
  return { label: null, task, consumed: false };
}

/**
 * 调用 LLM 对用户消息做情绪分类，返回 EMOTION_LABELS 中的一个标签或 null。
 * @param text 用户消息原文
 * @param llmCall async (messages) => string  —— 由调用方注入，避免循环依赖
 */
export async function llmInferEmotionLabel(text, llmCall) {
  if (!text || typeof llmCall !== 'function') return null;
  try {
    const prompt = `用一个词标注对话中"用户"当前的情绪:\n可选: ${EMOTION_LABELS.join('/')}\n用户说: "${String(text).slice(0, 200)}"\n只输出标签，不解释。`;
    const raw = await llmCall([{ role: 'user', content: prompt }]);
    const label = String(raw ?? '').trim().replace(/["""「」]/g, '');
    return EMOTION_LABELS.includes(label) ? label : null;
  } catch {
    return null;
  }
}

function recentText(turns, role) {
  return (turns ?? [])
    .filter((t) => t?.role === role)
    .slice(-2)
    .map((t) => String(t.content ?? ''))
    .join('\n');
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export { normalizeEmotionResidue };
