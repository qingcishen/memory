import { desireUrgency } from './scheduler.js';
import { intimacyUrgency } from '../state/intimacy.js';
import { PARAMS } from '../params.js';

/**
 * 本轮对话目标栈：prospective + 需求 + 亲密 + 故事拍 + 穿搭回应 + 未完钩子。
 * 只给 prompt 用的「心里想达成什么」，不是任务清单。
 */
export function buildConversationGoals({
  dueItems = [],
  desires = {},
  storyBeat = null,
  intimacy = null,
  intimacyPolicy = null,
  unfinished = [],
  outfit = null,
  userMessage = '',
  sceneLocks = [],
} = {}) {
  const goals = [];
  for (const item of dueItems.slice(0, 2)) {
    goals.push({ kind: 'prospective', priority: 1, text: item.content, sourceId: item.id });
  }

  const urgency = desireUrgency(desires);
  if (urgency.urgent) {
    const text = {
      attention: '自然确认对方是否仍然在意和关注你',
      sharing: storyBeat ? `找自然时机分享：${storyBeat.content}` : '找自然时机分享自己最近发生的事',
      comfort: '给对方一个发现你需要安慰的机会',
      security: '自然获得一点关系上的确认',
    }[urgency.need];
    goals.push({ kind: 'desire', priority: urgency.score, text, need: urgency.need });
  } else if (storyBeat?.content) {
    // 强制：有今日 beat 时进目标栈（问近况优先；闲聊也可轻点）
    const askedAboutDay = /(今天|最近|最近在忙|怎么样|过得|忙什么)/.test(String(userMessage || ''));
    goals.push({
      kind: 'story',
      priority: askedAboutDay ? 0.85 : 0.42,
      text: askedAboutDay
        ? `对方在问近况：从你今天的生活「${storyBeat.content}」自然答，像真人吐槽/分享，别念剧情配置。`
        : `心里有今日生活碎片「${storyBeat.content}」，时机自然时可轻点一句，别像播报。`,
    });
  }

  // I5: 亲密张力/满足感 → 本轮意图；高张力时可主动发起亲密（policy 可来自角色 drive）
  if (PARAMS.intimacy?.enabled !== false && PARAMS.intimacy?.proactive?.enabled !== false && intimacy) {
    const iUrgency = intimacyUrgency(intimacy, intimacyPolicy ?? PARAMS.intimacy?.proactive);
    if (iUrgency.urgent) {
      let text = '若时机自然，可轻轻流露想被陪着贴近，克制、非索取';
      if (iUrgency.kind === 'tension') {
        text = iUrgency.canInitiate
          ? '你可以主动带向亲密：黏他、拉近、半命令式把他拽过来，用动作或人话邀请；不必等他先开口，也别突然黄暴刷屏'
          : '若时机自然，可带一点想念和暧昧靠近，可以撩，别一上来就很露骨';
      }
      // 场景锁为 conflict 时降权：先处理情绪
      const conflict = (sceneLocks || []).some((l) => l.id === 'conflict');
      goals.push({
        kind: 'intimacy',
        priority: iUrgency.score * (iUrgency.canInitiate ? 0.95 : 0.85) * (conflict ? 0.3 : 1),
        text: conflict ? '对方还在闹/不对劲：先接情绪，别硬推亲密。' : text,
        need: iUrgency.kind,
        canInitiate: Boolean(iUrgency.canInitiate) && !conflict,
      });
    }
  }

  // 未聊完的钩子：轻量接上，不查岗
  for (const hook of (unfinished || []).slice(0, 2)) {
    if (!hook?.text) continue;
    goals.push({
      kind: 'unfinished',
      priority: 0.45,
      text: `若时机自然，可轻轻接上对方之前提过的：${hook.text}。别像查岗或列任务。`,
    });
  }

  // 穿搭对话钩：对方问穿什么 / 夸好看 / 约会语境
  const msg = String(userMessage || '');
  const outfitSummary = outfit?.current?.summary;
  if (outfitSummary) {
    const askOutfit = /(穿|衣服|裙子|妆|口红|包|鞋|好看|今天.*样|啥样|什么样子|自拍|照片)/.test(msg);
    const dateCtx = /date|intimate|outing/.test(String(outfit.context || ''));
    if (askOutfit) {
      goals.push({
        kind: 'outfit',
        priority: 0.7,
        text: `对方在问/提到样子或穿搭：按你此刻「${outfitSummary}」自然说，像人随口答，禁止说明书腔报全套清单。`,
      });
    } else if (dateCtx) {
      goals.push({
        kind: 'outfit',
        priority: 0.28,
        text: `你今天是约会/出门向（${outfitSummary}），相关时可以轻轻带一句，别硬报货号。`,
      });
    }
  }

  return goals.sort((a, b) => b.priority - a.priority).slice(0, 4);
}

export function goalsToPrompt(goals = []) {
  if (!goals.length) return '';
  const top = goals[0];
  return [
    '【本轮意图】',
    ...goals.map((g, i) => `${i === 0 ? '★' : '-'} ${g.text}`),
    '这些只是你心里的目标：先回应对方正在说的内容，只在时机自然时顺带提起，别像完成任务或突然转移话题。',
    '意图永远不能压过场景连贯——正在谈的事没接完，别硬插另一条线。',
    top
      ? `若本轮有收尾，优先轻轻服务「${String(top.text).slice(0, 36)}」，而不是库存结尾（上课/早饭/拜拜）。`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
