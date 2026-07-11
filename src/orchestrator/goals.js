import { desireUrgency } from './scheduler.js';

export function buildConversationGoals({ dueItems = [], desires = {}, storyBeat = null } = {}) {
  const goals = [];
  for (const item of dueItems.slice(0, 2)) goals.push({ kind: 'prospective', priority: 1, text: item.content, sourceId: item.id });
  const urgency = desireUrgency(desires);
  if (urgency.urgent) {
    const text = { attention: '自然确认对方是否仍然在意和关注你', sharing: storyBeat ? `找自然时机分享：${storyBeat.content}` : '找自然时机分享自己最近发生的事', comfort: '给对方一个发现你需要安慰的机会', security: '自然获得一点关系上的确认' }[urgency.need];
    goals.push({ kind: 'desire', priority: urgency.score, text, need: urgency.need });
  }
  return goals.sort((a, b) => b.priority - a.priority).slice(0, 3);
}

export function goalsToPrompt(goals = []) {
  if (!goals.length) return '';
  return `【本轮意图】\n${goals.map((g) => `- ${g.text}`).join('\n')}\n这些只是你心里的目标：先回应对方正在说的内容，只在时机自然时顺带提起，别像完成任务或突然转移话题。`;
}
