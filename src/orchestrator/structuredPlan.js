/**
 * 两阶段决策：结构化本轮计划（启发式 + 可选便宜模型 enrich）
 * 输出驱动：话量、是否提故事/未完、是否 plain、是否想发图、气泡数。
 */

import { LLM_MODEL } from '../config.js';
import { PARAMS } from '../params.js';

/**
 * 纯启发式结构化计划（无 IO）
 */
export function planStructuredHeuristic(ctx = {}) {
  const msg = String(ctx.userMessage || '');
  const locks = ctx.sceneLocks || [];
  const lockIds = new Set(locks.map((l) => l.id));
  const goals = ctx.goals || [];
  const behavior = ctx.behavior || {};
  const storyBeat = ctx.storyBeat;
  const unfinished = ctx.unfinished || [];
  const phase = ctx.intimacyPhase;

  let lengthHint = behavior.lengthHint || 'normal';
  let mentionStory = goals.some((g) => g.kind === 'story' && g.priority >= 0.4);
  let mentionUnfinished = goals.some((g) => g.kind === 'unfinished');
  let wantPhoto = /自拍|照片|看看你|发张图/.test(msg);
  let bubbleCount = Math.min(3, Math.max(1, Number(behavior.partsBudget) || 2));
  let attitude = 'warm';

  // 冲突才 guarded；单纯 terse（修复期/累）仍可 warm，只是话少
  if (lockIds.has('conflict')) {
    attitude = 'guarded';
    bubbleCount = 1;
    mentionStory = false;
  } else if (lengthHint === 'terse') {
    bubbleCount = Math.min(bubbleCount, 1);
  }
  if (lockIds.has('intimate') || ['foreplay', 'peak', 'aftercare'].includes(phase)) {
    attitude = 'intimate';
    mentionStory = false;
  }
  if (ctx.bodySit?.sick || ctx.bodySit?.period || (ctx.bodySit?.lowEnergy && ctx.bodySit?.lowHealth)) {
    attitude = 'soft';
    lengthHint = 'terse';
    bubbleCount = 1;
    wantPhoto = false;
  }
  if (/(今天|最近|怎么样)/.test(msg) && storyBeat?.content) mentionStory = true;
  if (unfinished[0] && /(记得|上次|后来|怎么样了)/.test(msg)) mentionUnfinished = true;

  const replyFormat =
    lockIds.has('intimate') || lockIds.has('car') || ['foreplay', 'peak', 'aftercare', 'flirting'].includes(phase)
      ? 'json'
      : 'plain';

  const actions = [];
  if (wantPhoto) actions.push({ type: 'photo', reason: 'requested' });
  if (mentionStory && storyBeat?.content) actions.push({ type: 'mention_story', seed: storyBeat.content.slice(0, 60) });
  if (mentionUnfinished && unfinished[0]?.text) actions.push({ type: 'mention_unfinished', seed: unfinished[0].text });

  return {
    attitude,
    lengthHint,
    mentionStory,
    mentionUnfinished,
    wantPhoto,
    bubbleCount,
    replyFormat,
    actions,
    note: '',
    source: 'heuristic',
    _lockIds: [...lockIds],
  };
}

/**
 * 可选：便宜模型 enrich。失败则返回 heuristic。
 */
export async function enrichStructuredPlan(heuristic, ctx = {}, { client = null, model = LLM_MODEL, signal } = {}) {
  if (PARAMS.orchestrator?.structuredPlanLlm === false) return heuristic;
  // 必须显式注入 client（编排器传入真实 OpenAI 兼容客户端）；默认不连网，避免 mock 测试/离线路径被全局 llm 拖慢
  const planClient = client || null;
  if (!planClient?.chat?.completions?.create || !model) return heuristic;
  // 短寒暄不值得多一次 LLM
  if (String(ctx.userMessage || '').trim().length <= 4 && !heuristic.wantPhoto) return heuristic;

  try {
    const res = await planClient.chat.completions.create(
      {
        model,
        temperature: 0.2,
        max_tokens: 180,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '你是伴侣对话的回合规划器。只输出 JSON，不要解释。字段：attitude(warm|guarded|soft|intimate|playful), lengthHint(terse|normal|chatty), mentionStory(bool), mentionUnfinished(bool), wantPhoto(bool), bubbleCount(1-3), replyFormat(plain|json), note(短中文内心方向)。不要编造剧情。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              userMessage: ctx.userMessage,
              sceneLocks: (ctx.sceneLocks || []).map((l) => l.id),
              intimacyPhase: ctx.intimacyPhase,
              goals: (ctx.goals || []).slice(0, 3).map((g) => ({ kind: g.kind, text: String(g.text).slice(0, 40) })),
              hasStoryBeat: Boolean(ctx.storyBeat?.content),
              unfinished: (ctx.unfinished || []).map((u) => u.text).slice(0, 2),
              heuristic,
            }),
          },
        ],
      },
      { signal },
    );
    const parsed = JSON.parse(res.choices?.[0]?.message?.content || '{}');
    return mergeStructured(heuristic, parsed);
  } catch {
    return heuristic;
  }
}

export function mergeStructured(base, overlay = {}) {
  const next = { ...base, source: overlay && Object.keys(overlay).length ? 'heuristic+llm' : base.source };
  if (['warm', 'guarded', 'soft', 'intimate', 'playful'].includes(overlay.attitude)) next.attitude = overlay.attitude;
  if (['terse', 'normal', 'chatty'].includes(overlay.lengthHint)) next.lengthHint = overlay.lengthHint;
  if (typeof overlay.mentionStory === 'boolean') next.mentionStory = overlay.mentionStory;
  if (typeof overlay.mentionUnfinished === 'boolean') next.mentionUnfinished = overlay.mentionUnfinished;
  if (typeof overlay.wantPhoto === 'boolean') next.wantPhoto = overlay.wantPhoto;
  if (overlay.bubbleCount != null) next.bubbleCount = Math.min(3, Math.max(1, Number(overlay.bubbleCount) || 1));
  if (overlay.replyFormat === 'plain' || overlay.replyFormat === 'json') next.replyFormat = overlay.replyFormat;
  if (overlay.note) next.note = String(overlay.note).slice(0, 80);

  // 场景硬约束：亲密锁不能被 LLM 改成 plain 丢旁白能力随意；冲突不能 chatty 刷屏
  const locks = base._lockIds || [];
  if (locks.includes('conflict')) {
    next.lengthHint = 'terse';
    next.bubbleCount = 1;
  }
  if (locks.includes('intimate') || locks.includes('car')) next.replyFormat = 'json';

  next.actions = [];
  if (next.wantPhoto) next.actions.push({ type: 'photo', reason: 'plan' });
  if (next.mentionStory) next.actions.push({ type: 'mention_story' });
  if (next.mentionUnfinished) next.actions.push({ type: 'mention_unfinished' });
  return next;
}

/** 把 structured plan 折进 planTurn 结果与 behavior */
export function applyStructuredToTurn(turn, structured, behavior = {}) {
  if (!turn || !structured) return turn;
  const next = { ...turn };
  if (structured.bubbleCount) next.partsBudget = structured.bubbleCount;
  if (structured.replyFormat) next.replyFormat = structured.replyFormat;
  next.structured = structured;
  // 简报追加决策
  if (structured.note || structured.attitude) {
    const extra = [
      structured.attitude && `态度=${structured.attitude}`,
      structured.mentionStory && '可轻点今日生活',
      structured.mentionUnfinished && '可接未完话题',
      structured.wantPhoto && '可考虑发图',
      structured.note && `方向：${structured.note}`,
    ]
      .filter(Boolean)
      .join(' · ');
    if (extra) {
      next.turnBrief = `${turn.turnBrief || '【本轮简报】'}${turn.turnBrief ? ' · ' : ''}${extra}`;
    }
  }
  // 覆盖 behavior 话量提示（仅本轮）
  if (structured.lengthHint && behavior) {
    next._lengthHintOverride = structured.lengthHint;
  }
  return next;
}

export function structuredPlanToPrompt(structured) {
  if (!structured) return '';
  const lines = ['【本轮决策】'];
  lines.push(`态度倾向：${structured.attitude || 'warm'}；话量：${structured.lengthHint || 'normal'}；输出：${structured.replyFormat || 'auto'}。`);
  if (structured.mentionStory) lines.push('若自然，可轻轻带一点自己今天的生活碎片，别播报。');
  if (structured.mentionUnfinished) lines.push('若自然，可接上对方未完的话题，别查岗。');
  if (structured.wantPhoto) lines.push('对方想看你时再配合发图，别硬塞。');
  if (structured.note) lines.push(`心里有数：${structured.note}`);
  lines.push('决策服从场景锁与对方最后一句，不能压过连贯。');
  return lines.join('\n');
}
