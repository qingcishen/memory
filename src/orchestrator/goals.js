import { desireUrgency } from './scheduler.js';
import { intimacyUrgency } from '../state/intimacy.js';
import { PARAMS } from '../params.js';

export function buildConversationGoals({ dueItems = [], desires = {}, storyBeat = null, intimacy = null, intimacyPolicy = null } = {}) {
  const goals = [];
  for (const item of dueItems.slice(0, 2)) goals.push({ kind: 'prospective', priority: 1, text: item.content, sourceId: item.id });
  const urgency = desireUrgency(desires);
  if (urgency.urgent) {
    const text = { attention: '自然确认对方是否仍然在意和关注你', sharing: storyBeat ? `找自然时机分享：${storyBeat.content}` : '找自然时机分享自己最近发生的事', comfort: '给对方一个发现你需要安慰的机会', security: '自然获得一点关系上的确认' }[urgency.need];
    goals.push({ kind: 'desire', priority: urgency.score, text, need: urgency.need });
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
      goals.push({
        kind: 'intimacy',
        priority: iUrgency.score * (iUrgency.canInitiate ? 0.95 : 0.85),
        text,
        need: iUrgency.kind,
        canInitiate: Boolean(iUrgency.canInitiate),
      });
    }
  }
  return goals.sort((a, b) => b.priority - a.priority).slice(0, 3);
}

export function goalsToPrompt(goals = []) {
  if (!goals.length) return '';
  return `【本轮意图】\n${goals.map((g) => `- ${g.text}`).join('\n')}\n这些只是你心里的目标：先回应对方正在说的内容，只在时机自然时顺带提起，别像完成任务或突然转移话题。`;
}
