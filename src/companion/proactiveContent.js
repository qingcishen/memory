/**
 * 主动消息内容源：把「为什么找他」落成有生活的理由，而不是空 cron。
 */

/**
 * @param ctx {{
 *   dueItems?: array,
 *   urgency?: object,
 *   intimacyUrg?: object,
 *   storyBeat?: { title, content }|null,
 *   outfit?: { current?: { summary }, context }|null,
 *   unfinished?: array,
 *   silenceTier?: object|null,
 *   bedtimeTier?: object|null,
 *   lifeActivity?: string|null,
 *   defaultReason?: string,
 * }}
 */
export function buildProactiveContentPack(ctx = {}) {
  const sources = [];
  const due = ctx.dueItems?.[0];
  if (due?.content) {
    sources.push({ kind: 'prospective', weight: 1.0, reason: `你答应过要提醒他：${due.content}`, seed: due.content });
  }
  if (ctx.storyBeat?.content) {
    // 分享欲高 + 有故事拍：故事作主因（压过裸 desire），这样主动消息有「生活内容」而不是空「想分享」
    const sharingBoost = ctx.urgency?.urgent && ctx.urgency?.need === 'sharing' ? 1.05 : 0.92;
    sources.push({
      kind: 'story',
      weight: sharingBoost,
      reason: `你今天生活里刚发生：${ctx.storyBeat.title || ''}——${ctx.storyBeat.content}。想第一时间跟他说，像真人分享，不是播报。`,
      seed: ctx.storyBeat.content,
    });
  }
  if (ctx.unfinished?.[0]?.text) {
    sources.push({
      kind: 'unfinished',
      weight: 0.88,
      reason: `上次他说过「${ctx.unfinished[0].text}」好像还没完，你想轻轻接上，别像查岗。`,
      seed: ctx.unfinished[0].text,
    });
  }
  if (ctx.outfit?.current?.summary && /date|intimate|outing/.test(String(ctx.outfit.context || ''))) {
    sources.push({
      kind: 'outfit',
      weight: 0.7,
      reason: `你今天穿着「${ctx.outfit.current.summary}」，想随口让他知道/让他夸，别像报货号。`,
      seed: ctx.outfit.current.summary,
    });
  }
  if (ctx.lifeActivity) {
    sources.push({
      kind: 'activity',
      weight: 0.65,
      reason: `你刚才在「${ctx.lifeActivity}」，忙里偷闲想起他，用生活碎片开场。`,
      seed: ctx.lifeActivity,
    });
  }
  if (ctx.urgency?.urgent) {
    const tone = ctx.urgency.tone || '';
    const needMap = {
      attention: '有点想被理一理',
      sharing: '有话想说',
      comfort: '想被轻轻接住',
      security: '想确认他还在',
    };
    sources.push({
      kind: 'desire',
      weight: 0.75 + (Number(ctx.urgency.score) || 0) * 0.2,
      reason: `${needMap[ctx.urgency.need] || '想找他'}。语气：${tone}`,
      seed: ctx.urgency.need,
    });
  }
  if (ctx.intimacyUrg?.urgent) {
    sources.push({
      kind: 'intimacy',
      weight: ctx.intimacyUrg.canInitiate ? 0.9 : 0.72,
      reason: ctx.intimacyUrg.canInitiate
        ? '你想靠近他、想亲密一点；第一句仍要像人，别黄暴刷屏。'
        : '心里有点黏，想自然地靠近。',
      seed: 'intimacy',
    });
  }
  // 优先级与 scheduler 旧链一致: bedtime > silence（睡前晚安压过单纯沉默搭话）
  if (ctx.bedtimeTier?.reason) {
    sources.push({ kind: 'bedtime', weight: 0.88, reason: ctx.bedtimeTier.reason, seed: 'bedtime' });
  }
  if (ctx.silenceTier?.reason) {
    sources.push({
      kind: 'silence',
      weight: 0.7 + (ctx.silenceTier.tier === 'miss' ? 0.1 : 0),
      reason: ctx.silenceTier.reason,
      seed: 'silence',
    });
  }

  sources.sort((a, b) => b.weight - a.weight);
  const top = sources[0] || {
    kind: 'default',
    weight: 0,
    reason: ctx.defaultReason || '想主动找对方聊一句',
    seed: 'hi',
  };

  // 组合副线索：主理由 + 最多一条辅料（故事/穿搭/未完）
  const secondary = sources.find((s) => s !== top && ['story', 'outfit', 'unfinished', 'activity'].includes(s.kind));
  let reason = top.reason;
  if (secondary && top.kind !== secondary.kind) {
    reason = `${top.reason} 也可以顺带一点点：${secondary.reason}`;
  }

  return {
    primary: top,
    secondary: secondary || null,
    reason,
    query: top.seed || secondary?.seed || '想主动找对方聊一句',
    style: ctx.urgency?.urgent ? ctx.urgency.tone : ctx.intimacyUrg?.urgent ? ctx.intimacyUrg.tone : undefined,
    sources,
  };
}
