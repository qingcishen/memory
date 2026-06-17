// 短期对话历史的持久化 store (见 sql/schema.sql chat_history)。
//
// Orchestrator 的短期历史默认在实例内存里 (进程重启就丢)。注入这个 store 后,
// 最近几轮对话落库, 重启 / 多实例也能 load 回来接上。
// 接口与 Orchestrator 约定一致: load({userId, companionId, limit}) / append({userId, companionId, turns})。

import fs from 'node:fs/promises';
import path from 'node:path';
import { supabase } from '../config.js';

export class SupabaseHistoryStore {
  constructor({ client = supabase, table = 'chat_history' } = {}) {
    this.client = client;
    this.table = table;
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
  async append({ userId, companionId = 'default', turns = [] } = {}) {
    if (!userId || !turns.length) return;
    const rows = turns
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content != null)
      .map((t) => ({ user_id: userId, companion_id: companionId, role: t.role, content: String(t.content) }));
    if (!rows.length) return;
    const { error } = await this.client.from(this.table).insert(rows);
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
    const rows = db[this.key(userId, companionId)] ?? [];
    return rows.slice(-limit).map((r) => ({ role: r.role, content: r.content }));
  }

  async append({ userId, companionId = 'default', turns = [] } = {}) {
    if (!userId || !turns.length) return;
    const rows = turns
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content != null)
      .map((t) => ({ role: t.role, content: String(t.content), created_at: new Date().toISOString() }));
    if (!rows.length) return;

    this._lock = this._lock.then(async () => {
      const db = await this.read();
      const key = this.key(userId, companionId);
      db[key] = [...(db[key] ?? []), ...rows].slice(-this.maxTurnsPerChat);
      await this.write(db);
    });
    return this._lock;
  }

  /** 对方上次说话的时间 (ISO string); 没有则 null。供 P1 分级主动性调度器判断沉默时长。 */
  async lastUserMessageAt({ userId, companionId = 'default' } = {}) {
    if (!userId) return null;
    const db = await this.read();
    const rows = db[this.key(userId, companionId)] ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === 'user') return rows[i].created_at ?? null;
    }
    return null;
  }

  key(userId, companionId) {
    return `${userId}::${companionId}`;
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  }

  async write(db) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(db, null, 2)}\n`);
    await fs.rename(tmp, this.file);
  }
}
