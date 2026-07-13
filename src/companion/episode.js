/**
 * Episode · 会话篇章记忆（轻量）
 * 从一轮对话抽「小篇章」摘要，作为 dyad 叙事记忆素材（不改 fact_core 红线）。
 * 纯逻辑可单测；落库由调用方 memory/store 完成。
 */

/**
 * 从 turns 生成 episode 候选（不调 LLM 的启发式，失败安全）
 * @returns {{ title, content, importance, emotion, subject_kind } | null}
 */
export function buildEpisodeHeuristic(turns = [], { now = Date.now() } = {}) {
  const msgs = (turns || []).filter((t) => t?.content && String(t.content).trim());
  if (msgs.length < 2) return null;
  const userLines = msgs.filter((m) => m.role === 'user').map((m) => String(m.content).trim());
  const herLines = msgs.filter((m) => m.role === 'assistant').map((m) => String(m.content).trim());
  if (!userLines.length) return null;

  const topics = [];
  const blob = userLines.join(' ');
  if (/(工作|开会|加班|老板|项目)/.test(blob)) topics.push('工作');
  if (/(想你|亲亲|抱|做|亲密|床|车)/.test(blob)) topics.push('亲密');
  if (/(生气|吵架|对不起|不理)/.test(blob)) topics.push('情绪冲突');
  if (/(病|不舒服|疼|药|发烧)/.test(blob)) topics.push('身体');
  if (/(吃|饭|饿|外卖)/.test(blob)) topics.push('日常饮食');
  if (!topics.length) topics.push('日常闲聊');

  const lastUser = userLines[userLines.length - 1].slice(0, 40);
  const lastHer = (herLines[herLines.length - 1] || '').slice(0, 40);
  const day = new Date(now).toISOString().slice(0, 10);
  const title = `${day} · ${topics.slice(0, 2).join('·')}`;
  const content = [
    `【篇章】${title}`,
    `对方提到：${lastUser}${userLines.length > 1 ? '等' : ''}`,
    lastHer ? `她当时的回应大致是：${lastHer}` : '',
    `话题标签：${topics.join('、')}`,
    '这是一段关系里的小篇章，不是孤立事实清单。',
  ].filter(Boolean).join('。');

  let emotion = 0.3;
  if (topics.includes('亲密')) emotion = 0.55;
  if (topics.includes('情绪冲突')) emotion = 0.65;
  if (topics.includes('身体')) emotion = 0.45;

  return {
    title,
    content,
    importance: topics.includes('情绪冲突') || topics.includes('亲密') ? 7 : 5,
    emotion,
    subject_kind: 'dyad',
    type: 'episode',
    topics,
  };
}

/**
 * 给 prompt 用的篇章提示（从最近 episode 记忆文本列表）
 */
export function episodesToPrompt(episodeTexts = []) {
  const list = (episodeTexts || []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 3);
  if (!list.length) return '';
  return `【最近的关系篇章】\n${list.map((t) => `- ${t}`).join('\n')}\n被问起「最近/那天/之前」时优先从这里自然接，不要编造篇章里没有的具体情节。`;
}
