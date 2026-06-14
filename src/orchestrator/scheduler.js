// 主动性调度与限流。
//
// Orchestrator.proactiveTick() 只负责"生成一句主动消息"; 本模块负责"现在能不能发"、
// "用什么理由发"、"发完如何记录频率"。它不依赖具体 cron/队列服务, 外部定时调用 tick() 即可。

import { supabase } from '../config.js';

const DAY = 24 * 60 * 60 * 1000;

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
    this._timer = null;
  }

  async tick(ctx = {}) {
    const now = ctx.now ?? this.clock();
    const userId = this.orchestrator.userId;
    const companionId = this.orchestrator.companionId ?? 'default';
    const state = normalizeRateLimitState(await this.stateStore.load({ userId, companionId }).catch(() => defaultRateLimitState()));
    const allowed = canSendProactive(state, now, { ...this.policy, ...(ctx.policy ?? {}) });
    if (!allowed.ok) return { sent: false, reason: allowed.reason, nextAt: allowed.nextAt };

    const dueItems = await this.getDueItems({ userId, companionId, now, ctx }).catch(() => []);
    const reason = ctx.reason ?? formatDueReason(dueItems) ?? this.defaultReason;
    const message = await this.orchestrator.proactiveTick({
      ...ctx,
      reason,
      shouldSend: true,
    });
    if (!message) return { sent: false, reason: 'orchestrator_skipped' };

    await this.deliver({ userId, companionId, message, reason, dueItems, now });
    const nextState = markProactiveSent(state, now, { ...this.policy, ...(ctx.policy ?? {}) });
    await this.stateStore.save(nextState, { userId, companionId });

    const firedIds = dueItems.map((item) => item?.id).filter(Boolean);
    if (firedIds.length > 0) await this.markFired(firedIds).catch(() => {});

    return { sent: true, message, reason, dueItems, state: nextState };
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
