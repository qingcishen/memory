/**
 * P2 · 用户端时间线：把聊天、篇章、故事拍、照片合成「一起过日子」的事件流。
 * 纯逻辑，不连库。
 */

/**
 * @param {{
 *   history?: array,
 *   episodes?: array,
 *   story?: array,
 *   photos?: array,
 *   annuals?: array,
 *   life?: object,
 * }} input
 */
export function buildTimeline(input = {}, { limit = 40 } = {}) {
  const events = [];

  for (const h of input.history || []) {
    if (!h?.content) continue;
    events.push({
      id: `chat-${h.id || h.created_at}-${h.role}`,
      kind: 'chat',
      at: h.created_at || null,
      role: h.role,
      title: h.role === 'user' ? '你' : '她',
      body: String(h.content).slice(0, 280),
      meta: {},
    });
  }

  for (const ep of input.episodes || []) {
    const body = ep.narrative || ep.content || ep.fact_core || '';
    if (!body) continue;
    events.push({
      id: `ep-${ep.id || ep.created_at}`,
      kind: 'episode',
      at: ep.created_at || null,
      title: '关系篇章',
      body: String(body).slice(0, 320),
      meta: { type: ep.type, topics: ep.topics },
    });
  }

  for (const s of input.story || []) {
    if (!s?.last_beat && !s?.title) continue;
    events.push({
      id: `story-${s.storyline_key || s.id || s.title}`,
      kind: 'story',
      at: s.last_beat_at || s.updated_at || null,
      title: s.title || '生活故事',
      body: s.last_beat || s.next_beat_hint || '',
      meta: { stage: s.stage },
    });
  }

  for (const p of input.photos || []) {
    events.push({
      id: `photo-${p.id || p.created_at}`,
      kind: 'photo',
      at: p.created_at || null,
      title: '照片',
      body: (p.tags || []).join(' · ') || p.prompt?.slice(0, 80) || '一张照片',
      meta: { url: p.url, tags: p.tags },
    });
  }

  for (const a of input.annuals || []) {
    events.push({
      id: `annual-${a.id}`,
      kind: 'milestone',
      at: a.trigger_at || a.created_at || null,
      title: '纪念日',
      body: a.content || '',
      meta: { status: a.status },
    });
  }

  events.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0;
    const tb = b.at ? new Date(b.at).getTime() : 0;
    return tb - ta;
  });

  return {
    events: events.slice(0, limit),
    summary: buildDaySummary(input),
  };
}

export function buildDaySummary(input = {}) {
  const life = input.life || {};
  const storyToday = (input.story || []).find((s) => s.last_beat);
  return {
    activity: life.current_activity || null,
    energy: life.energy ?? null,
    health: life.health ?? null,
    sick: Boolean(life.sick_until && new Date(life.sick_until).getTime() > Date.now()),
    outfit: life.outfit?.current?.summary || null,
    storyBeat: storyToday?.last_beat || null,
    storyTitle: storyToday?.title || null,
  };
}
