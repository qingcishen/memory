// M5 扛量 · 持久化任务队列。
//
// 回复后的后台活 (observe / evolve / 主动性 / reflect / dedupe) 原本是 fire-and-forget,
// 进程重启就丢。这里把它们落成 jobs 表里的任务: worker 轮询 claim → 跑 handler → done;
// 失败按指数退避重试, 超次数进 failed。单进程起步, 多进程靠 CAS claim 不抢同一条。
//
// 上半部纯逻辑 (退避/重试决策, 离线可测), 下半部碰 IO (supabase), Worker 可注入 store 离线测。

import { supabase, PARAMS } from '../config.js';

// ============================================================
//  纯逻辑
// ============================================================

/** 第 n 次重试的退避时长 (指数, 有上限)。attempts 从 0 起。 */
export function nextBackoffMs(attempts, { base = PARAMS.queue.baseBackoffMs, cap = PARAMS.queue.maxBackoffMs } = {}) {
  const ms = base * Math.pow(2, Math.max(0, attempts));
  return Math.min(cap, ms);
}

/**
 * 一个 job 跑失败后该怎么办: 还能重试就回 pending 并把 run_after 推到退避之后; 超次数则 failed。
 * @returns { status:'pending'|'failed', run_after:string, attempts:number }
 */
export function decideAfterFailure(job, now = Date.now(), opts = {}) {
  const maxAttempts = opts.maxAttempts ?? PARAMS.queue.maxAttempts;
  const attempts = (job.attempts ?? 0) + 1;
  if (attempts >= maxAttempts) {
    return { status: 'failed', attempts, run_after: new Date(now).toISOString() };
  }
  return { status: 'pending', attempts, run_after: new Date(now + nextBackoffMs(attempts, opts)).toISOString() };
}

/** 此刻这个 job 是否可被取走 (pending 且 run_after 已到)。 */
export function isClaimable(job, now = Date.now()) {
  return job?.status === 'pending' && new Date(job.run_after ?? 0).getTime() <= now;
}

// ============================================================
//  IO 层 (supabase)
// ============================================================

/** 入队一个 job。runAfter 可延迟执行 (如定时任务)。 */
export async function enqueue(userId, companionId = 'default', kind, payload = {}, opts = {}) {
  const row = {
    user_id: userId,
    companion_id: companionId,
    kind,
    payload,
    status: 'pending',
    run_after: opts.runAfter ? new Date(opts.runAfter).toISOString() : new Date().toISOString(),
  };
  const { data, error } = await supabase.from('jobs').insert(row).select().single();
  if (error) throw error;
  return data;
}

/**
 * 取一批到期的 pending job 并原子认领 (CAS: 把 status 从 pending 改成 running, 只有改成功的归我)。
 * 没有 SELECT ... FOR UPDATE SKIP LOCKED 也能在多进程下不抢同一条: 两个 worker 同时认领同一行,
 * 只有一个的 update(status pending→running) 影响 1 行, 另一个影响 0 行被跳过。
 */
export async function claimBatch({ limit = PARAMS.queue.batchSize, now = Date.now() } = {}) {
  const { data: pend, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('run_after', new Date(now).toISOString())
    .order('run_after', { ascending: true })
    .limit(limit);
  if (error) throw error;
  if (!pend || pend.length === 0) return [];

  const claimed = [];
  for (const job of pend) {
    const { data, error: e } = await supabase
      .from('jobs')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'pending') // CAS: 只认领仍是 pending 的
      .select()
      .maybeSingle();
    if (!e && data) claimed.push(data);
  }
  return claimed;
}

/** 标记 job 完成。 */
export async function completeJob(id, result = null) {
  const { error } = await supabase
    .from('jobs')
    .update({ status: 'done', result, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** 标记 job 失败 (内部按退避决定回 pending 重试还是 failed)。 */
export async function failJob(job, errMessage, now = Date.now(), opts = {}) {
  const next = decideAfterFailure(job, now, opts);
  const { error } = await supabase
    .from('jobs')
    .update({
      status: next.status,
      attempts: next.attempts,
      run_after: next.run_after,
      last_error: String(errMessage ?? '').slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
  if (error) throw error;
  return next;
}

/** 监控: 队列各状态计数 (+ 最老 pending 的年龄秒数), 可按 user/companion 过滤。 */
export async function queueStats(filter = {}) {
  let base = supabase.from('jobs').select('status', { count: 'exact', head: true });
  if (filter.userId) base = base.eq('user_id', filter.userId);
  if (filter.companionId) base = base.eq('companion_id', filter.companionId);
  const statuses = ['pending', 'running', 'done', 'failed'];
  const counts = {};
  await Promise.all(
    statuses.map(async (s) => {
      let q = supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('status', s);
      if (filter.userId) q = q.eq('user_id', filter.userId);
      if (filter.companionId) q = q.eq('companion_id', filter.companionId);
      counts[s] = (await q).count ?? 0;
    })
  );
  // 最老的待办年龄 (积压告警用)
  let oq = supabase.from('jobs').select('created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(1);
  if (filter.userId) oq = oq.eq('user_id', filter.userId);
  const { data: oldest } = await oq;
  const oldestPendingAgeSec = oldest?.[0] ? Math.round((Date.now() - new Date(oldest[0].created_at).getTime()) / 1000) : 0;
  return { ...counts, oldestPendingAgeSec };
}

// ============================================================
//  Worker (轮询 claim → 跑 handler → done/重试)
// ============================================================

export class Worker {
  /**
   * @param handlers { [kind]: async (payload, job) => result } —— 按 kind 分发
   * @param store    可注入 { claimBatch, complete, fail } (默认走上面的 supabase 实现; 测试可全 mock 离线)
   */
  constructor({ handlers = {}, store = null, batchSize = PARAMS.queue.batchSize, clock = () => Date.now() } = {}) {
    this.handlers = handlers;
    this.batchSize = batchSize;
    this.clock = clock;
    this.store = store ?? {
      claimBatch: (opts) => claimBatch(opts),
      complete: (id, result) => completeJob(id, result),
      fail: (job, msg, now) => failJob(job, msg, now),
    };
    this._timer = null;
    this.metrics = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  /** 跑一轮: 认领一批 → 逐个 handler → 成功 complete / 失败 fail(退避重试)。返回本轮结果摘要。 */
  async tick() {
    const now = this.clock();
    const jobs = await this.store.claimBatch({ limit: this.batchSize, now }).catch(() => []);
    const results = [];
    for (const job of jobs) {
      const handler = this.handlers[job.kind];
      this.metrics.processed++;
      if (!handler) {
        this.metrics.skipped++;
        await this.store.fail(job, `无 handler: ${job.kind}`, now).catch(() => {});
        results.push({ id: job.id, ok: false, reason: 'no_handler' });
        continue;
      }
      try {
        const result = await handler(job.payload ?? {}, job);
        await this.store.complete(job.id, result ?? null);
        this.metrics.succeeded++;
        results.push({ id: job.id, ok: true });
      } catch (e) {
        this.metrics.failed++;
        await this.store.fail(job, e?.message ?? String(e), now).catch(() => {});
        results.push({ id: job.id, ok: false, reason: e?.message ?? 'error' });
      }
    }
    return { claimed: jobs.length, results };
  }

  start({ intervalMs = 2000 } = {}) {
    if (this._timer) return this._timer;
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[worker]', e)), intervalMs);
    return this._timer;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
