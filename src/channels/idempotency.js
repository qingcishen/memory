import { supabase } from '../config.js';

/** 渠道事件幂等：内存 TTL 快速挡重，Supabase 唯一键跨进程挡重。 */
export class ChannelEventStore {
  constructor({ client = supabase, table = 'channel_events', ttlMs = 24 * 3600_000, now = () => Date.now() } = {}) {
    this.client = client;
    this.table = table;
    this.ttlMs = ttlMs;
    this.now = now;
    this.seen = new Map();
    this.lastPersistentPruneAt = 0;
  }

  async claim(channel, eventId) {
    const id = String(eventId || '').trim();
    if (!id) return true; // 没有稳定 ID 时 fail-open，不误丢用户消息。
    this.prune();
    const key = `${channel}:${id}`;
    if (this.seen.has(key)) return false;
    const { error } = await this.client.from(this.table).insert({ channel, event_id: id });
    this.prunePersistent();
    if (error?.code === '23505') {
      this.seen.set(key, this.now());
      return false;
    }
    // 数据库未迁移/短暂不可用时仍用本进程 TTL 保护，不让渠道整体停摆。
    this.seen.set(key, this.now());
    return true;
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
  }

  prunePersistent() {
    const now = this.now();
    if (now - this.lastPersistentPruneAt < 3600_000) return;
    this.lastPersistentPruneAt = now;
    const cutoff = new Date(now - 7 * 24 * 3600_000).toISOString();
    try {
      const table = this.client.from(this.table);
      if (typeof table.delete === 'function') Promise.resolve(table.delete().lt('created_at', cutoff)).catch(() => {});
    } catch {}
  }
}
