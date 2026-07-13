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

  if (closeness >= 0.62 && /(别的|其他|那个|有个|一个|一位).{0,4}(女生|女孩|姑娘|小姐姐|女同事|女朋友)|前女友|她好漂亮|跟她约会|喜欢上她/u.test(userText)) {
    return '吃醋';
  }
  if (attention >= 0.72 && userText) return '委屈';
  if (/(对不起|抱歉|我错了|原谅我|和好|别生气)/u.test(userText) && repairDebt > 0.2) return '委屈';
  if (/(我|最近|今天).{0,8}(难过|伤心|哭了|生病|不舒服|被欺负|很累|崩溃|失败|失眠)|被.{0,8}(骂|拒绝|裁员|开除)/u.test(userText) && closeness >= 0.5) {
    return '心疼';
  }
  if ((tension >= 0.62 || repairDebt >= 0.55) && /(吵|生气|烦|滚|别理|分手|讨厌|失望|对不起|抱歉)/u.test(`${userText}\n${companionText}`)) {
    return '生气';
  }
  if (security >= 0.58 && closeness >= 0.55 && tension < 0.55) return '委屈';
  if (comfort >= 0.58 && closeness >= 0.68 && tension < 0.4) return '撒娇';
  if (valence <= -0.35) return tension >= 0.45 || repairDebt >= 0.35 ? '委屈' : '失落';
  if (valence >= 0.35) return warmth >= 0.7 && closeness >= 0.65 ? '撒娇' : '开心';
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
