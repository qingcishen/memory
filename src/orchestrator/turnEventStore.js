import { supabase } from '../config.js';

/**
 * 持久化 turn 提交账本。claim 依赖数据库唯一键完成跨进程竞争仲裁。
 * processing 代表已取得写权限但投影尚未全部确认；不会被另一进程自动重放。
 */
export class SupabaseTurnEventStore {
  constructor({ client = supabase, table = 'turn_events' } = {}) {
    this.client = client;
    this.table = table;
  }

  async claim({ userId, companionId = 'default', eventId, payload = {} } = {}) {
    requireIdentity(userId, eventId);
    const row = {
      user_id: String(userId),
      companion_id: String(companionId),
      event_id: String(eventId),
      event_type: 'reply.commit',
      status: 'processing',
      payload,
      attempts: 1,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await this.client
      .from(this.table)
      .insert(row)
      .select('event_id,status,attempts,committed_at,last_error')
      .single();
    if (!error) return { acquired: true, event: data ?? row };
    if (String(error.code) !== '23505') throw error;
    return {
      acquired: false,
      event: await this.get({ userId, companionId, eventId }),
    };
  }

  async get({ userId, companionId = 'default', eventId } = {}) {
    requireIdentity(userId, eventId);
    const { data, error } = await this.client
      .from(this.table)
      .select('event_id,status,attempts,committed_at,last_error')
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

  async update({ userId, companionId = 'default', eventId } = {}, patch) {
    requireIdentity(userId, eventId);
    const { data, error } = await this.client
      .from(this.table)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('user_id', String(userId))
      .eq('companion_id', String(companionId))
      .eq('event_id', String(eventId))
      .select('event_id,status,attempts,committed_at,last_error')
      .single();
    if (error) throw error;
    return data;
  }
}

/** 测试和单进程部署使用；语义与持久实现一致。 */
export class InMemoryTurnEventStore {
  constructor() {
    this.events = new Map();
  }

  async claim(scope = {}) {
    requireIdentity(scope.userId, scope.eventId);
    const key = eventKey(scope);
    const existing = this.events.get(key);
    if (existing) return { acquired: false, event: { ...existing } };
    const event = {
      event_id: String(scope.eventId),
      status: 'processing',
      attempts: 1,
      committed_at: null,
      last_error: null,
    };
    this.events.set(key, event);
    return { acquired: true, event: { ...event } };
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
    const next = { ...(this.events.get(key) ?? {}), ...patch };
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
