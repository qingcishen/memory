// 短期对话历史的持久化 store (见 sql/schema.sql chat_history)。
//
// Orchestrator 的短期历史默认在实例内存里 (进程重启就丢)。注入这个 store 后,
// 最近几轮对话落库, 重启 / 多实例也能 load 回来接上。
// 接口与 Orchestrator 约定一致: load / append / lastUserMessageAt
// 可选扩展: loadSessionThread / saveSessionThread（本场会话线，进程重启不丢）

import fs from 'node:fs/promises';
import path from 'node:path';
import { supabase } from '../config.js';

const SESSION_TABLE = 'chat_session_state';

export class SupabaseHistoryStore {
  constructor({ client = supabase, table = 'chat_history', sessionTable = SESSION_TABLE } = {}) {
    this.client = client;
    this.table = table;
    this.sessionTable = sessionTable;
  }

  /** 拉最近 limit 条 (升序返回, 便于直接当短期历史用)。 */
  async load({ userId, companionId = 'default', limit = 12 } = {}) {
    if (!userId) return [];
    const { data, error } = await this.client
      .from(this.table)
      .select('id, role, content')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .order('id', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data.reverse().map((r) => ({ role: r.role, content: r.content }));
  }

  /** 追加这一轮的 user/assistant 消息。 */
  async append({ userId, companionId = 'default', turns = [], eventId = null } = {}) {
    if (!userId || !turns.length) return;
    const rows = turns
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content != null)
      .map((t) => ({ user_id: userId, companion_id: companionId, role: t.role, content: String(t.content), event_id: eventId || null }));
    if (!rows.length) return;
    const query = eventId
      ? this.client.from(this.table).upsert(rows, { onConflict: 'user_id,companion_id,event_id,role', ignoreDuplicates: true })
      : this.client.from(this.table).insert(rows);
    const { error } = await query;
    if (error) throw error;
  }

  /** 对方上次说话的时间 (ISO string); 没有则 null。供 P1 分级主动性调度器判断沉默时长。 */
  async lastUserMessageAt({ userId, companionId = 'default' } = {}) {
    if (!userId) return null;
    const { data, error } = await this.client
      .from(this.table)
      .select('created_at')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('role', 'user')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data.created_at;
  }

  /** 读会话线快照；表不存在或失败 → null（调用方从 history 重建） */
  async loadSessionThread({ userId, companionId = 'default' } = {}) {
    if (!userId) return null;
    try {
      const { data, error } = await this.client
        .from(this.sessionTable)
        .select('thread, updated_at')
        .eq('user_id', userId)
        .eq('companion_id', companionId)
        .maybeSingle();
      if (error || !data?.thread) return null;
      return data.thread;
    } catch {
      return null;
    }
  }

  /** 写会话线快照（upsert）；失败静默由调用方 catch */
  async saveSessionThread({ userId, companionId = 'default', thread = null } = {}) {
    if (!userId || !thread) return null;
    const { error } = await this.client.from(this.sessionTable).upsert(
      {
        user_id: userId,
        companion_id: companionId,
        thread,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,companion_id' },
    );
    if (error) throw error;
    return true;
  }
}

/** 本地 JSON 短期历史。适合本机 Telegram bot: 不依赖 Supabase 表, 重启也能接上最近几轮。 */
export class LocalJsonHistoryStore {
  constructor({ file = 'logs/chat-history.json', maxTurnsPerChat = 80 } = {}) {
    this.file = file;
    this.maxTurnsPerChat = maxTurnsPerChat;
    this._lock = Promise.resolve();
  }

  async load({ userId, companionId = 'default', limit = 12 } = {}) {
    if (!userId) return [];
    const db = await this.read();
    const rows = db.chats?.[this.key(userId, companionId)] ?? db[this.key(userId, companionId)] ?? [];
    // 兼容旧格式：顶层 key 直接是 chat 数组
    return rows.slice(-limit).map((r) => ({ role: r.role, content: r.content }));
  }

  async append({ userId, companionId = 'default', turns = [], eventId = null } = {}) {
    if (!userId || !turns.length) return;
    const rows = turns
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content != null)
      .map((t) => ({ role: t.role, content: String(t.content), event_id: eventId || null, created_at: new Date().toISOString() }));
    if (!rows.length) return;

    // 上一次写失败不能毒化锁链: 先 catch 掉再排队, 否则一次磁盘错误后所有后续 append 永久静默失败
    const task = this._lock.catch(() => {}).then(async () => {
      const db = await this.migrateDb(await this.read());
      const key = this.key(userId, companionId);
      const existing = db.chats[key] ?? [];
      const fresh = eventId ? rows.filter((row) => !existing.some((old) => old.event_id === eventId && old.role === row.role)) : rows;
      db.chats[key] = [...existing, ...fresh].slice(-this.maxTurnsPerChat);
      await this.write(db);
    });
    this._lock = task;
    return task;
  }

  /** 对方上次说话的时间 (ISO string); 没有则 null。供 P1 分级主动性调度器判断沉默时长。 */
  async lastUserMessageAt({ userId, companionId = 'default' } = {}) {
    if (!userId) return null;
    const db = await this.read();
    const rows = db.chats?.[this.key(userId, companionId)] ?? db[this.key(userId, companionId)] ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === 'user') return rows[i].created_at ?? null;
    }
    return null;
  }

  async loadSessionThread({ userId, companionId = 'default' } = {}) {
    if (!userId) return null;
    const db = await this.migrateDb(await this.read());
    const row = db.sessions?.[this.key(userId, companionId)];
    return row?.thread ?? null;
  }

  async saveSessionThread({ userId, companionId = 'default', thread = null } = {}) {
    if (!userId || !thread) return null;
    const task = this._lock.catch(() => {}).then(async () => {
      const db = await this.migrateDb(await this.read());
      if (!db.sessions) db.sessions = {};
      db.sessions[this.key(userId, companionId)] = {
        thread,
        updated_at: new Date().toISOString(),
      };
      await this.write(db);
    });
    this._lock = task;
    return task;
  }

  key(userId, companionId) {
    return `${userId}::${companionId}`;
  }

  /** 旧文件：顶层直接是 chat key → 迁到 { chats, sessions } */
  migrateDb(raw = {}) {
    if (raw && raw.chats && typeof raw.chats === 'object') {
      return { chats: raw.chats, sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {} };
    }
    const chats = {};
    for (const [k, v] of Object.entries(raw || {})) {
      if (k === 'chats' || k === 'sessions') continue;
      if (Array.isArray(v)) chats[k] = v;
    }
    return { chats, sessions: {} };
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { chats: {}, sessions: {} };
      throw error;
    }
  }

  async write(db) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const normalized = this.migrateDb(db);
    await fs.writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`);
    await fs.rename(tmp, this.file);
  }
}
