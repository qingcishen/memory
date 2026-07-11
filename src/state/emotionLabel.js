// B1 · 离散情绪推断。规则优先、纯函数、可解释。
export const EMOTION_LABELS = ['平静', '开心', '委屈', '吃醋', '生气', '失落', '撒娇', '心疼'];

export function inferEmotionLabel(state = {}, desires = {}, lastTurns = []) {
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

  if (closeness >= 0.62 && /(别的|其他|那个|有个|一个|一位).{0,4}(女生|女孩|姑娘|小姐姐|女同事|女朋友)|前女友|她好漂亮|跟她约会|喜欢上她/u.test(userText)) return '吃醋';
  if (attention >= 0.72 && userText) return '委屈';
  if (/(对不起|抱歉|我错了|原谅我|和好|别生气)/u.test(userText) && repairDebt > 0.2) return '委屈';
  if (/(我|最近|今天).{0,8}(难过|伤心|哭了|生病|不舒服|被欺负|很累|崩溃|失败|失眠)|被.{0,8}(骂|拒绝|裁员|开除)/u.test(userText) && closeness >= 0.5) return '心疼';
  if ((tension >= 0.62 || repairDebt >= 0.55) && /(吵|生气|烦|滚|别理|分手|讨厌|失望|对不起|抱歉)/u.test(`${userText}\n${companionText}`)) return '生气';
  if (security >= 0.58 && closeness >= 0.55 && tension < 0.55) return '委屈';
  if (comfort >= 0.58 && closeness >= 0.68 && tension < 0.4) return '撒娇';
  if (valence <= -0.35) return tension >= 0.45 || repairDebt >= 0.35 ? '委屈' : '失落';
  if (valence >= 0.35) return warmth >= 0.7 && closeness >= 0.65 ? '撒娇' : '开心';
  return '平静';
}

function recentText(turns, role) { return (turns ?? []).filter((t) => t?.role === role).slice(-2).map((t) => String(t.content ?? '')).join('\n'); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
