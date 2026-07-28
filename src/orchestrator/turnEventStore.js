import { supabase } from '../config.js';
import { randomUUID } from 'node:crypto';

/**
 * 持久化 turn 提交账本。claim 依赖数据库唯一键完成跨进程竞争仲裁。
 * processing 代表已取得写权限但投影尚未全部确认；不会被另一进程自动重放。
 */
export class SupabaseTurnEventStore {
  constructor({ client = supabase, table = 'turn_events', leaseSeconds = 120 } = {}) {
    this.client = client;
    this.table = table;
    this.leaseSeconds = Math.max(10, Number(leaseSeconds) || 120);
  }

  async claim({ userId, companionId = 'default', eventId, payload = {} } = {}) {
    requireIdentity(userId, eventId);
    const leaseToken = randomUUID();
    const { data, error } = await this.client.rpc('claim_turn_event', {
      p_user_id: String(userId),
      p_companion_id: String(companionId),
      p_event_id: String(eventId),
      p_lease_token: leaseToken,
      p_lease_seconds: this.leaseSeconds,
      p_payload: payload,
    });
    if (error) throw error;
    return {
      acquired: Boolean(data?.acquired),
      leaseToken: data?.acquired ? leaseToken : null,
      event: data?.event ?? null,
    };
  }

  async get({ userId, companionId = 'default', eventId } = {}) {
    requireIdentity(userId, eventId);
    const { data, error } = await this.client
      .from(this.table)
      .select('event_id,status,attempts,committed_at,last_error,lease_expires_at')
      .eq('user_id', String(userId))
      .eq('companion_id', String(companionId))
      .eq('event_id', String(eventId))
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }

  complete(scope = {}, result = {}) {
    return this.update(scope, {
      status: 'committed',
      result,
      committed_at: new Date().toISOString(),
      last_error: null,
    });
  }

  fail(scope = {}, error) {
    return this.update(scope, {
      status: 'failed',
      last_error: String(error?.message ?? error ?? 'unknown commit error').slice(0, 2000),
    });
  }

  async update({ userId, companionId = 'default', eventId, leaseToken } = {}, patch) {
    requireIdentity(userId, eventId);
    let query = this.client
      .from(this.table)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('user_id', String(userId))
      .eq('companion_id', String(companionId))
      .eq('event_id', String(eventId));
    if (leaseToken) query = query.eq('lease_token', String(leaseToken));
    const { data, error } = await query
      .select('event_id,status,attempts,committed_at,last_error')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const leaseError = new Error('turn event lease lost before update');
      leaseError.code = 'TURN_EVENT_LEASE_LOST';
      throw leaseError;
    }
    return data;
  }
}

/** 测试和单进程部署使用；语义与持久实现一致。 */
export class InMemoryTurnEventStore {
  constructor({ now = () => Date.now(), leaseMs = 120_000 } = {}) {
    this.events = new Map();
    this.now = now;
    this.leaseMs = leaseMs;
  }

  async claim(scope = {}) {
    requireIdentity(scope.userId, scope.eventId);
    const key = eventKey(scope);
    const existing = this.events.get(key);
    const canRecover =
      existing?.status === 'failed' ||
      (existing?.status === 'processing' && existing.lease_expires_at <= this.now());
    if (existing && !canRecover) return { acquired: false, event: { ...existing } };
    const leaseToken = randomUUID();
    const event = {
      event_id: String(scope.eventId),
      status: 'processing',
      attempts: (existing?.attempts ?? 0) + 1,
      lease_token: leaseToken,
      lease_expires_at: this.now() + this.leaseMs,
      committed_at: null,
      last_error: null,
    };
    this.events.set(key, event);
    return { acquired: true, leaseToken, event: { ...event } };
  }

  async get(scope = {}) {
    return this.events.get(eventKey(scope)) ?? null;
  }

  async complete(scope = {}, result = {}) {
    return this.patch(scope, {
      status: 'committed',
      result,
      committed_at: new Date().toISOString(),
      last_error: null,
    });
  }

  async fail(scope = {}, error) {
    return this.patch(scope, {
      status: 'failed',
      last_error: String(error?.message ?? error ?? 'unknown commit error'),
    });
  }

  patch(scope, patch) {
    const key = eventKey(scope);
    const current = this.events.get(key);
    if (scope.leaseToken && current?.lease_token !== scope.leaseToken) {
      const error = new Error('turn event lease lost before update');
      error.code = 'TURN_EVENT_LEASE_LOST';
      throw error;
    }
    const next = { ...(current ?? {}), ...patch };
    this.events.set(key, next);
    return { ...next };
  }
}

function eventKey({ userId, companionId = 'default', eventId } = {}) {
  return `${String(userId)}\u0000${String(companionId)}\u0000${String(eventId)}`;
}

function requireIdentity(userId, eventId) {
  if (!String(userId ?? '').trim()) throw new Error('turn event requires userId');
  if (!String(eventId ?? '').trim()) throw new Error('turn event requires eventId');
}
