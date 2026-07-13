// 主动性调度与限流。
//
// Orchestrator.proactiveTick() 只负责"生成一句主动消息"; 本模块负责"现在能不能发"、
// "用什么理由发"、"发完如何记录频率"。它不依赖具体 cron/队列服务, 外部定时调用 tick() 即可。

import { supabase, PARAMS } from '../config.js';
import { minutesInRange, shanghaiWallClock } from '../state/activity.js';
import { inferEmotionLabel } from '../state/emotionLabel.js';
import { behaviorPolicy } from '../state/behavior.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTES_IN_DAY = 24 * 60;

export const DEFAULT_PROACTIVE_POLICY = {
  minIntervalMinutes: 180,
  maxPerDay: 3,
  quietHours: { start: 23, end: 8 },
  timezoneOffsetMinutes: null,
};

export function defaultRateLimitState() {
  return { sentAt: [] };
}

export function normalizeRateLimitState(state = {}) {
  return {
    sentAt: (state.sentAt ?? [])
      .map((t) => new Date(t))
      .filter((d) => !Number.isNaN(d.getTime()))
      .map((d) => d.toISOString()),
  };
}

export function isQuietHour(now = Date.now(), quietHours = DEFAULT_PROACTIVE_POLICY.quietHours, timezoneOffsetMinutes = null) {
  if (!quietHours) return false;
  const hour = localHour(now, timezoneOffsetMinutes);
  const start = Number(quietHours.start);
  const end = Number(quietHours.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function canSendProactive(state = {}, now = Date.now(), policy = {}) {
  const p = { ...DEFAULT_PROACTIVE_POLICY, ...policy };
  const s = normalizeRateLimitState(state);
  const timestamps = s.sentAt.map((t) => new Date(t).getTime()).filter((t) => t <= now);

  if (isQuietHour(now, p.quietHours, p.timezoneOffsetMinutes)) {
    return { ok: false, reason: 'quiet_hours', nextAt: nextQuietEnd(now, p.quietHours, p.timezoneOffsetMinutes) };
  }

  const last = timestamps.at(-1);
  const minGapMs = Math.max(0, Number(p.minIntervalMinutes) || 0) * 60 * 1000;
  if (last != null && now - last < minGapMs) {
    return { ok: false, reason: 'cooldown', nextAt: new Date(last + minGapMs).toISOString() };
  }

  const todayStart = startOfLocalDay(now, p.timezoneOffsetMinutes);
  const sentToday = timestamps.filter((t) => t >= todayStart).length;
  if (sentToday >= p.maxPerDay) {
    return { ok: false, reason: 'daily_limit', nextAt: new Date(todayStart + DAY).toISOString() };
  }

  return { ok: true, reason: 'ok' };
}

export function markProactiveSent(state = {}, now = Date.now(), policy = {}) {
  const p = { ...DEFAULT_PROACTIVE_POLICY, ...policy };
  const s = normalizeRateLimitState(state);
  const keepAfter = now - 8 * DAY;
  return {
    sentAt: [...s.sentAt, new Date(now).toISOString()].filter((t) => new Date(t).getTime() >= keepAfter),
    policy: {
      minIntervalMinutes: p.minIntervalMinutes,
      maxPerDay: p.maxPerDay,
      quietHours: p.quietHours,
    },
  };
}

export class MemoryRateLimitStore {
  constructor(initial = {}) {
    this.state = normalizeRateLimitState(initial);
  }

  async load() {
    return this.state;
  }

  async save(state) {
    this.state = normalizeRateLimitState(state);
    return this.state;
  }
}

export class SupabaseRateLimitStore {
  constructor({ client = supabase, table = 'proactive_rate_limits' } = {}) {
    this.client = client;
    this.table = table;
  }

  async load({ userId, companionId = 'default' } = {}) {
    if (!userId) return defaultRateLimitState();
    const { data, error } = await this.client
      .from(this.table)
      .select('state')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .maybeSingle();
    if (error || !data) return defaultRateLimitState();
    return normalizeRateLimitState(data.state ?? {});
  }

  async save(state, { userId, companionId = 'default' } = {}) {
    if (!userId) throw new Error('SupabaseRateLimitStore.save 需要 userId');
    const normalized = normalizeRateLimitState(state);
    const { error } = await this.client.from(this.table).upsert(
      {
        user_id: userId,
        companion_id: companionId,
        state: normalized,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,companion_id' }
    );
    if (error) throw error;
    return normalized;
  }
}

/**
 * P1 分级主动性: 按"对方上次说话距今多久"分级, 越久语气越直接/越带情绪 (见 PARAMS.proactive.silenceTiers)。
 * @param now 当前时间 (ms)
 * @param lastUserMessageAt 对方上次说话的时间 (ms | ISO string | null/undefined); 未知则不触发
 * @returns { tier:'excuse'|'direct'|'miss', hours, reason } | null (还不够久, 不必为此找理由)
 */
export function pickSilenceTier(now, lastUserMessageAt, tiers = PARAMS.proactive.silenceTiers) {
  if (lastUserMessageAt == null) return null;
  const last = typeof lastUserMessageAt === 'number' ? lastUserMessageAt : new Date(lastUserMessageAt).getTime();
  if (Number.isNaN(last)) return null;
  const hours = Math.max(0, (now - last) / HOUR);
  const h = hours.toFixed(1);
  if (hours >= tiers.missFromHours) {
    return { tier: 'miss', hours, reason: `对方已经 ${h} 小时没说话了, 心里有点小情绪/失落, 想简短地搭句话, 哪怕只是叫一下他的名字也好` };
  }
  if (hours >= tiers.directFromHours) {
    return { tier: 'direct', hours, reason: `对方已经 ${h} 小时没说话了, 有点惦记, 想直接问问他在干嘛` };
  }
  if (hours >= tiers.excuseFromHours) {
    return { tier: 'excuse', hours, reason: `对方已经 ${h} 小时没说话了, 想找个不经意的小理由跟他聊两句, 别直接说想他` };
  }
  return null;
}

/**
 * P1 分级主动性: 快到自己睡觉的时间时, 想在睡前跟对方说一句晚安 (见 PARAMS.proactive.bedtimeLeadMinutes)。
 * sleepWindow 来自角色专属作息 (Asia/Shanghai 挂钟时间), 这里按同一时区判断"现在几点", 不依赖服务器本地时区。
 * @param now 当前时间 (ms)
 * @param sleepWindow {from,to}(分钟, 见 state/activity.js parseSleepWindow); 无则不触发
 * @param leadMinutes 提前多少分钟算"快到睡觉时间"
 * @returns { tier:'bedtime', reason } | null
 */
export function pickBedtimeTier(now, sleepWindow, leadMinutes = PARAMS.proactive.bedtimeLeadMinutes) {
  if (!sleepWindow) return null;
  const d = shanghaiWallClock(now);
  const cur = d.getUTCHours() * 60 + d.getUTCMinutes();
  const lead = Math.max(0, Number(leadMinutes) || 0);
  const from = (((sleepWindow.from - lead) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  if (!minutesInRange(cur, from, sleepWindow.from)) return null;
  return { tier: 'bedtime', reason: '快到自己要睡觉的时间了, 想在睡前跟对方说一句晚安' };
}

/** D3: 从四项需求里选出当前最强驱力，并给主动消息提供口吻与冷却系数。 */
export function desireUrgency(desires = {}, policy = PARAMS.proactive.desire) {
  const labels = { attention: 'attention', sharing: 'sharing', comfort: 'comfort', security: 'security' };
  const entries = Object.keys(labels).map((key) => [key, Math.min(1, Math.max(0, Number(desires?.[key]) || 0))]);
  const [need, score] = entries.sort((a, b) => b[1] - a[1])[0];
  const trigger = Number(policy?.triggerThreshold ?? 0.45);
  if (!(score >= trigger)) return { urgent: false, need: null, tone: '', score, cooldownFactor: 1 };

  let tone;
  if (need === 'attention') tone = score >= (policy?.highThreshold ?? 0.8) ? '有点委屈地问“你是不是把我忘了”，但不要指责或连续追问' : '自然地表达“有点想你了”，语气轻一点，不给对方压力';
  else if (need === 'sharing') tone = '带着忍不住想分享的兴奋感，用“跟你说个事”自然开场';
  else if (need === 'comfort') tone = '稍微露出一点脆弱，给对方关心的机会，但不要卖惨或索取';
  else tone = '带一点克制的试探，想确认对方在乎你，但不要逼迫或情绪勒索';

  const minFactor = Math.min(1, Math.max(0.1, Number(policy?.minCooldownFactor ?? 0.35)));
  const progress = Math.min(1, Math.max(0, (score - trigger) / Math.max(0.01, 1 - trigger)));
  return { urgent: true, need, tone, score, cooldownFactor: 1 - progress * (1 - minFactor) };
}

export class ProactiveScheduler {
  constructor({
    orchestrator,
    deliver,
    getDueItems,
    markFired,
    stateStore,
    policy = {},
    clock = () => Date.now(),
    defaultReason = '想主动找对方聊一句',
    sleepWindow = null, // P1: 角色专属睡眠时段 {from,to}(分钟), 供 pickBedtimeTier
    getLastUserMessageAt = null, // P1: ({userId,companionId}) => 对方上次说话时间 (ms|ISO|null), 供 pickSilenceTier
  } = {}) {
    if (!orchestrator) throw new Error('ProactiveScheduler 需要 orchestrator');
    this.orchestrator = orchestrator;
    this.deliver = deliver ?? (async () => {});
    this.getDueItems = getDueItems ?? (async () => []);
    this.markFired = markFired ?? (async () => {});
    this.stateStore = stateStore ?? new MemoryRateLimitStore();
    this.policy = { ...DEFAULT_PROACTIVE_POLICY, ...policy };
    this.clock = clock;
    this.defaultReason = defaultReason;
    this.sleepWindow = sleepWindow;
    this.getLastUserMessageAt = getLastUserMessageAt;
    this._timer = null;
  }

  async tick(ctx = {}) {
    const now = ctx.now ?? this.clock();
    const userId = this.orchestrator.userId;
    const companionId = this.orchestrator.companionId ?? 'default';
    const state = normalizeRateLimitState(await this.stateStore.load({ userId, companionId }).catch(() => defaultRateLimitState()));
    const dueItems = await this.getDueItems({ userId, companionId, now, ctx }).catch(() => []);

    // D3: 读 StateLayer 的同一份需求快照。没有该能力的旧接入保持原行为。
    const supportsDesires = typeof this.orchestrator.stateLayer?.snapshot === 'function';
    const stateSnapshot = supportsDesires ? await this.orchestrator.stateLayer.snapshot().catch(() => null) : null;
    const relState = typeof this.orchestrator.relationship?.current === 'function'
      ? await this.orchestrator.relationship.current().catch(() => null)
      : null;
    const urgency = desireUrgency(stateSnapshot?.desires);
    // I5: 亲密紧迫度（仅冷却系数与语气；仍受 quietHours / 每日上限硬约束）
    let intimacyUrg = { urgent: false, cooldownFactor: 1, tone: '', kind: null };
    if (PARAMS.intimacy?.enabled !== false && PARAMS.intimacy?.proactive?.enabled !== false) {
      try {
        const { intimacyUrgency } = await import('../state/intimacy.js');
        intimacyUrg = intimacyUrgency(stateSnapshot?.intimacy);
        // 关系门控：未和好/高 tension 时不因亲密张力主动暧昧
        const rel = relState?.relationship ?? relState ?? {};
        if (intimacyUrg.urgent && (Number(rel.tension) >= 0.7 || Number(rel.repair_debt) >= 0.55)) {
          intimacyUrg = { urgent: false, cooldownFactor: 1, tone: '', kind: null };
        }
      } catch {
        intimacyUrg = { urgent: false, cooldownFactor: 1, tone: '', kind: null };
      }
    }
    const storyBeat = urgency.urgent && urgency.need === 'sharing' && typeof this.orchestrator.story?.pendingShare === 'function'
      ? await this.orchestrator.story.pendingShare(now).catch(() => null)
      : null;
    const emotionLabel = inferEmotionLabel({ ...(stateSnapshot ?? {}), relationship: relState?.relationship ?? relState ?? {} }, stateSnapshot?.desires, this.orchestrator.history?.slice(-4) ?? []);
    const behavior = behaviorPolicy(emotionLabel, { relationship: relState?.relationship ?? relState ?? {} });
    const basePolicy = { ...this.policy, ...(ctx.policy ?? {}) };
    const behaviorCooldownFactor = clamp(1 - behavior.proactiveBias, 0.5, 1.5);
    const desireFactor = urgency.urgent ? urgency.cooldownFactor : 1;
    const intimacyFactor = intimacyUrg.urgent ? intimacyUrg.cooldownFactor : 1;
    const effectivePolicy = {
      ...basePolicy,
      minIntervalMinutes: basePolicy.minIntervalMinutes * desireFactor * intimacyFactor * behaviorCooldownFactor,
    };

    const allowed = canSendProactive(state, now, effectivePolicy);
    // 到期事项(如"7点叫我起床")是她答应过的事——哪怕在安静时段(她在睡觉)也要叫醒, 但仍受冷却/每日上限保护。
    const overrideQuietHours = dueItems.length > 0 && allowed.reason === 'quiet_hours';
    if (!allowed.ok && !overrideQuietHours) return { sent: false, reason: allowed.reason, nextAt: allowed.nextAt };

    // 优先级: 显式原因 > 到期事项 > 需求 > 睡前 > 沉默分级 > 旧默认理由。
    const bedtimeTier = this.sleepWindow ? pickBedtimeTier(now, this.sleepWindow) : null;
    const lastUserMessageAt = this.getLastUserMessageAt
      ? await this.getLastUserMessageAt({ userId, companionId }).catch(() => null)
      : null;
    const silenceTier = pickSilenceTier(now, lastUserMessageAt);
    const desireReason = storyBeat
      ? `她今天刚经历了这件事，很想第一时间告诉对方：${storyBeat.title}——${storyBeat.content}`
      : urgency.urgent ? formatDesireReason(urgency) : null;
    const intimacyReason = intimacyUrg.urgent
      ? intimacyUrg.kind === 'tension'
        ? intimacyUrg.canInitiate
          ? '你想要他了，主动找他亲近；可以黏、可以半命令式把人拽近、暗示想亲密，第一句仍像真人说话'
          : '心里有一点亲近的渴望，想自然地靠近对方，可以撩一点'
        : '最近少了一些贴近，想被陪着，语气轻、不抱怨'
      : null;
    const reason =
      ctx.reason ??
      formatDueReason(dueItems) ??
      desireReason ??
      intimacyReason ??
      bedtimeTier?.reason ??
      silenceTier?.reason ??
      this.defaultReason;
    const usedDesireReason = Boolean(desireReason && reason === desireReason);
    const usedIntimacyReason = Boolean(intimacyReason && reason === intimacyReason);
    const usedStoryBeat = Boolean(storyBeat && usedDesireReason);
    // 新版接入有需求快照时，不再让纯 cron 在无任何动机时凭空发消息。
    if (
      supportsDesires &&
      !ctx.reason &&
      dueItems.length === 0 &&
      !desireReason &&
      !intimacyReason &&
      !bedtimeTier &&
      !silenceTier
    ) {
      return { sent: false, reason: 'no_trigger' };
    }
    const message = await this.orchestrator.proactiveTick({
      ...ctx,
      reason,
      query: ctx.query ?? (usedStoryBeat ? storyBeat.content : undefined),
      style: ctx.style ?? (usedDesireReason ? urgency.tone : usedIntimacyReason ? intimacyUrg.tone : undefined),
      shouldSend: true,
    });
    if (!message) return { sent: false, reason: 'orchestrator_skipped' };

    await this.deliver({ userId, companionId, message, reason, dueItems, now });
    if (usedStoryBeat && typeof this.orchestrator.story?.markShared === 'function') {
      await this.orchestrator.story.markShared(storyBeat, now).catch(() => {});
    }
    const nextState = markProactiveSent(state, now, effectivePolicy);
    await this.stateStore.save(nextState, { userId, companionId });

    const firedIds = dueItems.map((item) => item?.id).filter(Boolean);
    if (firedIds.length > 0) await this.markFired(firedIds).catch(() => {});

    return { sent: true, message, reason, dueItems, storyBeat: usedStoryBeat ? storyBeat : null, urgency, emotionLabel, behaviorPolicy: behavior, state: nextState };
  }

  start({ intervalMs = 5 * 60 * 1000, ctx = {} } = {}) {
    if (this._timer) return this._timer;
    this._timer = setInterval(() => {
      this.tick(ctx).catch((reason) => console.error('[proactiveScheduler]', reason));
    }, intervalMs);
    return this._timer;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

function formatDueReason(items = []) {
  const first = (items ?? [])[0];
  return first?.content ? `预期记忆到期: ${first.content}` : null;
}

function formatDesireReason(urgency) {
  const reason = {
    attention: '因为一直没被好好关注，是真的有点想对方了',
    sharing: '心里攒着一件事，很想第一时间跟对方分享',
    comfort: '此刻有点需要安慰，想自然地靠近对方一点',
    security: '对这段关系有点不踏实，想得到一点温柔的确认',
  }[urgency.need];
  return reason ?? null;
}

function localHour(now, timezoneOffsetMinutes) {
  const d = shiftedDate(now, timezoneOffsetMinutes);
  return d.getUTCHours();
}

function startOfLocalDay(now, timezoneOffsetMinutes) {
  const offset = offsetMs(timezoneOffsetMinutes);
  const shifted = new Date(now + offset);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return start - offset;
}

function nextQuietEnd(now, quietHours, timezoneOffsetMinutes) {
  if (!quietHours) return null;
  const offset = offsetMs(timezoneOffsetMinutes);
  const shifted = shiftedDate(now, timezoneOffsetMinutes);
  let end = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), Number(quietHours.end), 0, 0, 0);
  if (end - offset <= now) end += DAY;
  return new Date(end - offset).toISOString();
}

function shiftedDate(now, timezoneOffsetMinutes) {
  return new Date(now + offsetMs(timezoneOffsetMinutes));
}

function offsetMs(timezoneOffsetMinutes) {
  return timezoneOffsetMinutes == null ? 0 : Number(timezoneOffsetMinutes) * 60 * 1000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
