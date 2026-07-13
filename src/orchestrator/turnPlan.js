/**
 * 编排器 · 本轮计划（纯逻辑）
 * 在 reply() 里根据场景/行为/意图决定：历史深度、是否独白、采样、parts 上限、召回 query、简报。
 * 不碰 IO，可单测。
 */

import { PARAMS } from '../params.js';

const GREETING_RE = /^(在吗|你好|嗨|哈喽|早|晚安|嗯+|哦+|好+| rec|哒)$/i;
const SHORT_ACK_RE = /^(嗯|哦|好的|行|ok|OK|知道了|收到)[.。!！?？…]*$/;

/**
 * @param {{
 *   userMessage?: string,
 *   sceneLocks?: array,
 *   behavior?: object,
 *   goals?: array,
 *   intimacyPhase?: string|null,
 *   bodySit?: object,
 *   gapHours?: number|null,
 *   historyTurnsDefault?: number,
 *   useMonologueDefault?: boolean,
 * }} ctx
 */
export function planTurn(ctx = {}) {
  const cfg = PARAMS.orchestrator || {};
  const msg = String(ctx.userMessage || '').trim();
  const locks = ctx.sceneLocks || [];
  const lockIds = new Set(locks.map((l) => l.id));
  const behavior = ctx.behavior || {};
  const goals = ctx.goals || [];
  const phase = ctx.intimacyPhase || null;
  const baseTurns = Math.max(2, Number(ctx.historyTurnsDefault ?? cfg.historyTurnsDefault ?? 6));

  // ---- 历史深度：亲密/冲突/出行要更多上下文；冷战 terse 少一点 ----
  let historyTurns = baseTurns;
  if (lockIds.has('intimate') || lockIds.has('car') || ['foreplay', 'peak', 'aftercare'].includes(phase)) {
    historyTurns = Math.min(12, baseTurns + 2);
  } else if (lockIds.has('conflict') || lockIds.has('travel')) {
    historyTurns = Math.min(10, baseTurns + 1);
  }
  if (behavior.lengthHint === 'terse' || lockIds.has('conflict')) {
    historyTurns = Math.max(3, historyTurns - 1);
  }
  if (ctx.gapHours != null && ctx.gapHours >= 4) {
    // 久别后历史可能已清空；若仍有，略减以免旧场景带偏
    historyTurns = Math.max(2, Math.min(historyTurns, 4));
  }

  // ---- 内心独白：短寒暄 / 极 terse 可跳过省延迟 ----
  let useMonologue = ctx.useMonologueDefault !== false;
  const skipShort = cfg.skipMonologueOnShort !== false;
  if (skipShort) {
    if (GREETING_RE.test(msg) || SHORT_ACK_RE.test(msg)) useMonologue = false;
    if (behavior.lengthHint === 'terse' && msg.length <= 8 && !lockIds.has('intimate')) useMonologue = false;
    if (behavior.stonewall) useMonologue = false;
  }
  // 高优先意图仍值得想一下
  if (goals.some((g) => g.kind === 'safety' || (g.kind === 'prospective' && g.priority >= 0.9))) {
    useMonologue = ctx.useMonologueDefault !== false;
  }

  // ---- 召回 query：用户句 + 未完钩子/顶意图种子，提高「接上茬」 ----
  const seeds = [msg];
  for (const g of goals.slice(0, 2)) {
    if (g.kind === 'unfinished' || g.kind === 'story' || g.kind === 'prospective') {
      const snip = String(g.text || '').replace(/^[^：:]*[：:]/, '').slice(0, 40);
      if (snip.length >= 4) seeds.push(snip);
    }
  }
  const recallQuery = seeds.filter(Boolean).join(' · ').slice(0, 200) || msg || '最近';

  // ---- parts 预算 ----
  const partsBudget = Math.max(1, Math.min(6, Number(behavior.partsBudget) || 2));

  // ---- 简报：高显著度、短 ----
  const turnBrief = buildTurnBrief({
    lockIds: [...lockIds],
    phase,
    lengthHint: behavior.lengthHint || 'normal',
    topGoal: goals[0]?.text,
    emotionHint: behavior.relationshipStage || null,
    recoveryPath: behavior.recoveryPath,
    sick: Boolean(ctx.bodySit?.sick || ctx.bodySit?.period),
  });

  return {
    historyTurns,
    useMonologue,
    recallQuery,
    partsBudget,
    turnBrief,
    skipNarrationHint: behavior.lengthHint === 'terse' && !lockIds.has('intimate'),
  };
}

/**
 * 把 lengthHint / 病中 叠到 life samplingHints 上
 */
export function applyBehaviorSampling(base = {}, behavior = {}, bodySit = {}) {
  const out = { ...base };
  let maxTokens = Number(out.maxTokens) || 500;
  let temperature = Number(out.temperature);
  if (Number.isNaN(temperature)) temperature = 0.8;

  const hint = behavior.lengthHint || 'normal';
  // terse：硬压长度（委屈/冷战）；chatty 只靠 prompt 话量指引，不抬 maxTokens，避免盖住 life 采样基线
  if (hint === 'terse') {
    maxTokens = Math.min(maxTokens, Math.max(180, Math.round(maxTokens * 0.55)));
    temperature = Math.max(0.55, temperature - 0.08);
  }

  if (bodySit?.sick || bodySit?.period || bodySit?.lowEnergy) {
    maxTokens = Math.min(maxTokens, Math.max(200, Math.round(maxTokens * 0.7)));
    temperature = Math.max(0.55, temperature - 0.05);
  }

  out.maxTokens = Math.round(maxTokens);
  out.temperature = Math.round(temperature * 100) / 100;
  return out;
}

export function buildTurnBrief({
  lockIds = [],
  phase = null,
  lengthHint = 'normal',
  topGoal = null,
  recoveryPath = null,
  sick = false,
} = {}) {
  const bits = [];
  if (lockIds.length) bits.push(`场景锁=${lockIds.join('+')}`);
  if (phase && phase !== 'none') bits.push(`亲密阶段=${phase}`);
  bits.push(`话量=${lengthHint}`);
  if (sick) bits.push('身体不适');
  if (topGoal) bits.push(`意图=${String(topGoal).slice(0, 36)}`);
  if (recoveryPath && (lockIds.includes('conflict') || lengthHint === 'terse')) {
    bits.push(`可恢复=${String(recoveryPath).slice(0, 28)}`);
  }
  if (!bits.length) return '';
  return `【本轮简报】${bits.join(' · ')}。第一句必须接住对方；简报不能替代对方原话。`;
}

/**
 * 执行行为策略的 parts 上限：保留全部 narration，dialogue 最多 budget 条。
 */
export function enforcePartsBudget(parts = [], budget = 2) {
  const cap = Math.max(1, Math.floor(Number(budget) || 2));
  const list = Array.isArray(parts) ? parts : [];
  if (!list.length) return list;
  let dialogues = 0;
  const out = [];
  for (const p of list) {
    if (!p?.text) continue;
    if (p.type === 'narration') {
      out.push(p);
      continue;
    }
    if (dialogues < cap) {
      out.push(p.type === 'dialogue' ? p : { ...p, type: 'dialogue' });
      dialogues++;
    }
  }
  return out.length ? out : list.slice(0, 1);
}

/**
 * 后处理：砍掉 dialogue 里明显的库存结尾（跳戏重试失败时的最后兜底，不整段重写）
 */
export function stripStockEndingsFromParts(parts = [], sceneLocks = []) {
  if (!sceneLocks?.length) return parts;
  const stock = /(明天上课|记得吃早饭|写作业|考试加油|我先睡了哈)/;
  let changed = false;
  const next = (parts || []).map((p) => {
    if (p.type !== 'dialogue' || !stock.test(p.text || '')) return p;
    const cleaned = String(p.text)
      .replace(/[，,。]?\s*(明天上课|记得吃早饭|写作业|考试加油|我先睡了哈)[^。！？]*[。！？]?/g, '')
      .trim();
    if (cleaned && cleaned !== p.text) {
      changed = true;
      return { ...p, text: cleaned };
    }
    return p;
  }).filter((p) => p.text && p.text.trim());
  return changed && next.length ? next : parts;
}
