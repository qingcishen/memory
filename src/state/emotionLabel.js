// B1 · 离散情绪推断。规则优先、纯函数、可解释。
// E1：可选 residual 惯性，避免金鱼情绪。
import { applyLabelInertia, normalizeEmotionResidue } from './emotionResidue.js';

export const EMOTION_LABELS = ['平静', '开心', '委屈', '吃醋', '生气', '失落', '撒娇', '心疼'];

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
    return { label, residual, rawLabel };
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
  // 和好/释怀语境：repair 场景完成，余情是失落而非委屈
  if (/(说开了|和好了|和好吧|没事了|放下了|算了)/u.test(userText) && repairDebt >= 0.1) return '失落';
  if (/(对不起|抱歉|我错了|原谅我|别生气)/u.test(userText) && repairDebt > 0.2) return '委屈';
  // 用户表达受伤/失望 → 委屈（F2补充：侧重"让我"句式与情感词）
  if (/(让我.{0,8}(难受|伤心|失望|心寒|委屈)|说那句话|让我很|我不是小题大做|站在我这边)/u.test(userText)) {
    return '委屈';
  }
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
  // 明确愤怒口吻：不依赖 tension 已升高（新会话首轮也能挂生气）
  if (/(我很生气|气死|太过分了|你凭什么)/u.test(userText) || (/(你怎么这样|算了吧)/u.test(userText) && /(生气|烦|讨厌|分手)/u.test(userText))) {
    return '生气';
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
  };
  const line = map[label] ?? '';
  if (!line) return '';
  if (residual?.cause && NEGATIVE.has(label)) {
    return `${line}\n（余味来自不久前的相处，自然带连续性即可，不要复述原因清单。）`;
  }
  return line;
}

const NEGATIVE = new Set(['委屈', '吃醋', '生气', '失落']);

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
