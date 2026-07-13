/**
 * 主动消息内容源：把「为什么找他」落成有生活的理由，而不是空 cron。
 * 克制美学：短、有信息、有她自己的生活，不粘。
 */

/** 主动消息风格硬指引（进 proactiveTick 指令） */
export const PROACTIVE_STYLE_GUIDE = [
  '【主动·克制美学】',
  '一条短消息就够：有信息、有生活碎片，别连环追问。',
  '禁止空「在吗」「忙吗」；禁止查岗腔、情绪勒索。',
  '可以带一点点她自己的事（开会完/穿了某套/上次没聊完），像真人想起他。',
  '冷淡/沉默后找他：留台阶，别一上来质问；想亲密也先像人说话。',
].join('');

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
 *   life?: object|null,
 *   defaultReason?: string,
 *   emotionLabel?: string,
 *   emotionResidue?: { label, intensity }|null,
 * }}
 */
export function buildProactiveContentPack(ctx = {}) {
  const sources = [];
  const emoLabel = ctx.emotionLabel || ctx.emotionResidue?.label || null;
  const emoI = Number(ctx.emotionResidue?.intensity) || 0;
  const due = ctx.dueItems?.[0];
  if (due?.content) {
    sources.push({ kind: 'prospective', weight: 1.0, reason: `你答应过要提醒他：${due.content}`, seed: due.content });
  }
  if (ctx.storyBeat?.content) {
    const sharingBoost = ctx.urgency?.urgent && ctx.urgency?.need === 'sharing' ? 1.05 : 0.92;
    sources.push({
      kind: 'story',
      weight: sharingBoost,
      reason: `你今天生活里刚发生：${ctx.storyBeat.title || ''}——${ctx.storyBeat.content}。想第一时间跟他说，像真人分享，不是播报。一句就够。`,
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
  if (ctx.outfit?.current?.summary && /date|intimate|outing|home/.test(String(ctx.outfit.context || ''))) {
    const complimentHook = /date|outing/.test(String(ctx.outfit.context || ''));
    sources.push({
      kind: 'outfit',
      weight: complimentHook ? 0.72 : 0.55,
      reason: complimentHook
        ? `你今天穿着「${ctx.outfit.current.summary}」，可以随口让他知道/让他夸一句，像真人晒，别报货号。`
        : `你这会儿是「${ctx.outfit.current.summary}」，若提到样子可轻轻带一句。`,
      seed: ctx.outfit.current.summary,
    });
  }
  // 工作/梦/活动碎片
  const activity = ctx.lifeActivity || ctx.life?.current_activity;
  if (activity && !/睡着|睡了/.test(String(activity))) {
    const isWork = /开会|加班|工位|项目|客户/.test(String(activity));
    sources.push({
      kind: isWork ? 'work' : 'activity',
      weight: isWork ? 0.7 : 0.65,
      reason: isWork
        ? `你刚忙完「${activity}」，有点累，想用一句生活碎片找他，不粘。`
        : `你刚才在「${activity}」，忙里偷闲想起他，用生活碎片开场。`,
      seed: activity,
    });
  }
  // 病中：主动更克制，内容是想被轻轻关心，不是撒泼
  if (ctx.life?.sick_until && new Date(ctx.life.sick_until).getTime() > Date.now()) {
    sources.push({
      kind: 'sick',
      weight: 0.8,
      reason: '你身体不太舒服，想轻轻让他知道你在，话少，别卖惨连环。',
      seed: '不舒服',
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
      reason: `${needMap[ctx.urgency.need] || '想找他'}。语气：${tone}。仍要短、有生活，别空催。`,
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
  if (ctx.bedtimeTier?.reason) {
    sources.push({ kind: 'bedtime', weight: 0.88, reason: ctx.bedtimeTier.reason, seed: 'bedtime' });
  }
  if (ctx.silenceTier?.reason) {
    // 沉默后：强调可恢复、不质问；叠当前情绪标签（L4）
    let silenceReason =
      ctx.silenceTier.tier === 'miss'
        ? `${ctx.silenceTier.reason}。可以带一点小情绪，但留缝，别质问「是不是不想理我了」开场。`
        : ctx.silenceTier.reason;
    silenceReason = applyEmotionToSilenceReason(silenceReason, emoLabel, emoI, ctx.silenceTier);
    sources.push({
      kind: 'silence',
      weight: 0.7 + (ctx.silenceTier.tier === 'miss' ? 0.1 : 0) + (emoLabel === '委屈' || emoLabel === '失落' ? 0.08 : 0),
      reason: silenceReason,
      seed: 'silence',
    });
  }

  // L4：纯情绪动机源（有 residual 时给主动一条「心里还挂着」的辅料）
  if (emoLabel && emoI >= 0.4 && ['委屈', '失落', '吃醋', '生气'].includes(emoLabel)) {
    sources.push({
      kind: 'emotion',
      weight: 0.62 + emoI * 0.15,
      reason: emotionProactiveReason(emoLabel),
      seed: emoLabel,
    });
  }

  sources.sort((a, b) => b.weight - a.weight);
  const top = sources[0] || {
    kind: 'default',
    weight: 0,
    reason: ctx.defaultReason || '想主动找对方聊一句',
    seed: 'hi',
  };

  const secondary = sources.find((s) => s !== top && ['story', 'outfit', 'unfinished', 'activity', 'work'].includes(s.kind));
  let reason = top.reason;
  if (secondary && top.kind !== secondary.kind) {
    reason = `${top.reason} 也可以顺带一点点：${secondary.reason}`;
  }

  return {
    primary: top,
    secondary: secondary || null,
    reason,
    query: top.seed || secondary?.seed || '想主动找对方聊一句',
    style: buildProactiveStyle(ctx, top),
    styleGuide: PROACTIVE_STYLE_GUIDE,
    sources,
  };
}

function buildProactiveStyle(ctx, top) {
  const bits = [];
  if (ctx.urgency?.urgent && ctx.urgency.tone) bits.push(ctx.urgency.tone);
  if (ctx.intimacyUrg?.urgent && ctx.intimacyUrg.tone) bits.push(ctx.intimacyUrg.tone);
  if (top?.kind === 'silence') bits.push('短、留缝、不质问');
  if (top?.kind === 'sick') bits.push('话少、软、不卖惨');
  if (top?.kind === 'story' || top?.kind === 'work') bits.push('像分享生活碎片，一句够');
  if (top?.kind === 'emotion' || ctx.emotionLabel) {
    const lab = ctx.emotionLabel || ctx.emotionResidue?.label;
    if (lab === '委屈') bits.push('别扭一点、可闷，不连环质问');
    if (lab === '生气') bits.push('极短、冷一点，留缝');
    if (lab === '失落') bits.push('轻、软，不假开心');
    if (lab === '吃醋') bits.push('试探、嘴硬心软');
  }
  bits.push('整条主动消息控制在一两句内');
  return bits.filter(Boolean).join('；');
}

function applyEmotionToSilenceReason(base, label, intensity, silenceTier) {
  if (!label || intensity < 0.35) return base;
  if (label === '委屈') {
    return `${base} 你心里还有点委屈余味，可以闷闷地想确认他还在，别一上来控诉。`;
  }
  if (label === '失落') {
    return `${base} 你有点蔫，找他时话少软一点，别假开朗。`;
  }
  if (label === '生气' && silenceTier?.tier === 'miss') {
    return `${base} 你还没完全消气：极短、冷一点也行，但留一点可回复的缝，别判死刑。`;
  }
  if (label === '吃醋') {
    return `${base} 可以带一点别扭试探，别审讯。`;
  }
  return base;
}

function emotionProactiveReason(label) {
  const map = {
    委屈: '你心里还挂着一点委屈，想用一句短消息确认他还在意你；别扭可以，别连环追问。',
    失落: '你有点低落，想轻轻找他待一会儿；话少，别卖惨。',
    吃醋: '心里有点别扭，想自然地被他多看一眼；嘴硬心软，别审犯人。',
    生气: '还没完全顺气，若找他只发极短一句，留缝，别长篇指责。',
  };
  return map[label] || '你心里还挂着一点情绪，找他时自然带一点，别播报情绪名。';
}
