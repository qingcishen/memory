/**
 * Episode · 会话篇章记忆
 * 从一轮对话抽「小篇章」摘要；夜间可合成周链；召回时拼成连续段落。
 * 纯逻辑可单测；落库由调用方 memory/store 完成。不改 fact_core 红线。
 */

/**
 * 从 turns 生成 episode 候选（不调 LLM 的启发式，失败安全）
 * @returns {{ title, content, importance, emotion, subject_kind, moodHint } | null}
 */
export function buildEpisodeHeuristic(turns = [], { now = Date.now(), herMoodHint = '' } = {}) {
  const msgs = (turns || []).filter((t) => t?.content && String(t.content).trim());
  if (msgs.length < 2) return null;
  const userLines = msgs.filter((m) => m.role === 'user').map((m) => String(m.content).trim());
  const herLines = msgs.filter((m) => m.role === 'assistant').map((m) => String(m.content).trim());
  if (!userLines.length) return null;

  const topics = detectEpisodeTopics(userLines.join(' ') + ' ' + herLines.join(' '));
  const lastUser = userLines[userLines.length - 1].slice(0, 40);
  const lastHer = (herLines[herLines.length - 1] || '').slice(0, 40);
  const day = new Date(now).toISOString().slice(0, 10);
  const title = `${day} · ${topics.slice(0, 2).join('·')}`;
  const mood = herMoodHint || inferMoodFromTopics(topics, herLines);
  const content = [
    `【篇章】${title}`,
    `对方提到：${lastUser}${userLines.length > 1 ? '等' : ''}`,
    lastHer ? `她当时的回应大致是：${lastHer}` : '',
    mood ? `她当时的情绪基调：${mood}` : '',
    `话题标签：${topics.join('、')}`,
    '这是一段关系里的小篇章（含前后语气），不是孤立事实清单。',
  ].filter(Boolean).join('。');

  let emotion = 0.3;
  if (topics.includes('亲密')) emotion = 0.55;
  if (topics.includes('情绪冲突')) emotion = 0.65;
  if (topics.includes('身体')) emotion = 0.45;
  if (topics.includes('出行')) emotion = 0.5;

  return {
    title,
    content,
    importance: topics.includes('情绪冲突') || topics.includes('亲密') || topics.includes('出行') ? 7 : 5,
    emotion,
    subject_kind: 'dyad',
    type: 'episode',
    topics,
    moodHint: mood,
    day,
  };
}

export function detectEpisodeTopics(blob = '') {
  const topics = [];
  if (/(工作|开会|加班|老板|项目|deadline)/.test(blob)) topics.push('工作');
  if (/(想你|亲亲|抱|做|亲密|床|车|吻)/.test(blob)) topics.push('亲密');
  if (/(生气|吵架|对不起|不理|冷战)/.test(blob)) topics.push('情绪冲突');
  if (/(病|不舒服|疼|药|发烧|痛经)/.test(blob)) topics.push('身体');
  if (/(吃|饭|饿|外卖|做饭)/.test(blob)) topics.push('日常饮食');
  if (/(出差|高铁|飞机|杭州|上海|旅行|酒店)/.test(blob)) topics.push('出行');
  if (/(纪念日|周年|第一次|生日)/.test(blob)) topics.push('里程碑');
  if (/(那个梗|还记得|我们总是|老样子)/.test(blob)) topics.push('习惯梗');
  if (!topics.length) topics.push('日常闲聊');
  return topics;
}

function inferMoodFromTopics(topics, herLines = []) {
  const blob = herLines.join(' ');
  if (topics.includes('情绪冲突')) return /对不|抱抱|没事/.test(blob) ? '委屈后缓和' : '紧绷/别扭';
  if (topics.includes('亲密')) return '亲昵/欲望';
  if (topics.includes('身体')) return '虚弱/想被照顾';
  if (topics.includes('工作')) return /累|烦|吐槽/.test(blob) ? '疲惫吐槽' : '忙里偷闲';
  if (topics.includes('出行')) return '在路上/想家';
  if (/想你|嘿嘿|开心/.test(blob)) return '轻快黏人';
  return '平常';
}

/**
 * 夜间合成：把多条当日/当周篇章合并成一条「关系故事」段落（仍不改 fact_core）。
 * @param episodes array of { title, content, topics, moodHint, day }
 */
export function synthesizeEpisodeChain(episodes = [], { label = '最近' } = {}) {
  const list = (episodes || []).filter((e) => e?.content || e?.title);
  if (!list.length) return null;
  if (list.length === 1) {
    return {
      title: list[0].title || `${label}·篇章`,
      content: list[0].content || list[0].title,
      importance: list[0].importance ?? 6,
      emotion: list[0].emotion ?? 0.4,
      subject_kind: 'dyad',
      type: 'episode',
      topics: list[0].topics || ['日常闲聊'],
      chain: true,
    };
  }
  const topics = [...new Set(list.flatMap((e) => e.topics || []))];
  const beats = list.map((e, i) => {
    const day = e.day || e.title?.slice(0, 10) || `#${i + 1}`;
    const mood = e.moodHint ? `（她当时：${e.moodHint}）` : '';
    const core = String(e.content || e.title).replace(/^【篇章】[^。]*。?/, '').slice(0, 100);
    return `${day}${mood}：${core}`;
  });
  const title = `${label} · 关系故事链（${list.length}拍）`;
  const content = [
    `【篇章链】${title}`,
    ...beats.map((b, i) => `${i + 1}. ${b}`),
    `贯穿话题：${topics.join('、')}`,
    '这是跨会话的连续关系故事，被问起「杭州那周/最近」时按时间顺序自然接，不要编造链上没有的情节。',
  ].join('\n');
  return {
    title,
    content,
    importance: 8,
    emotion: 0.45,
    subject_kind: 'dyad',
    type: 'episode',
    topics,
    chain: true,
  };
}

/**
 * 给 prompt 用的篇章提示：优先拼成连续段落（故事感），而不是孤立 bullet 事实点。
 */
export function episodesToPrompt(episodeTexts = []) {
  const list = (episodeTexts || []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 4);
  if (!list.length) return '';
  // 若已是篇章链格式，整段注入
  if (list.some((t) => t.includes('【篇章链】'))) {
    const chain = list.find((t) => t.includes('【篇章链】')) || list[0];
    return `【最近的关系故事】\n${chain}\n被问起「最近/那天/那周/之前」时优先从这里按顺序自然接，不要编造链里没有的具体情节。`;
  }
  // 多条孤立篇章 → 合成一段可读叙事
  if (list.length >= 2) {
    const body = list.map((t, i) => `${i + 1}. ${t.slice(0, 160)}`).join('\n');
    return `【最近的关系篇章·连续读】\n${body}\n把它们当成同一段关系里前后发生的事来接话，不要拆成互不相关的事实清单。不确定的细节模糊带过。`;
  }
  return `【最近的关系篇章】\n- ${list[0]}\n被问起「最近/那天/之前」时优先从这里自然接，不要编造篇章里没有的具体情节。`;
}
