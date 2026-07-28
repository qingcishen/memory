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
  return enqueueWithClient(supabase, userId, companionId, kind, payload, opts);
}

export async function enqueueWithClient(
  client,
  userId,
  companionId = 'default',
  kind,
  payload = {},
  opts = {},
) {
  const row = {
    user_id: userId,
    companion_id: companionId,
    kind,
    payload,
    status: 'pending',
    run_after: opts.runAfter ? new Date(opts.runAfter).toISOString() : new Date().toISOString(),
    ...(opts.idempotencyKey ? { idempotency_key: String(opts.idempotencyKey) } : {}),
  };
  const write = opts.idempotencyKey
    ? client.from('jobs').upsert(row, {
        onConflict: 'user_id,companion_id,kind,idempotency_key',
        ignoreDuplicates: true,
      })
    : client.from('jobs').insert(row);
  const { data, error } = await write.select().maybeSingle();
  if (error) throw error;
  if (data) return data;
  if (!opts.idempotencyKey) return null;
  const { data: existing, error: readError } = await client
    .from('jobs')
    .select('*')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .eq('kind', kind)
    .eq('idempotency_key', String(opts.idempotencyKey))
    .single();
  if (readError) throw readError;
  return existing;
}

/**
 * 取一批到期的 pending job 并原子认领 (CAS: 把 status 从 pending 改成 running, 只有改成功的归我)。
 * 没有 SELECT ... FOR UPDATE SKIP LOCKED 也能在多进程下不抢同一条: 两个 worker 同时认领同一行,
 * 只有一个的 update(status pending→running) 影响 1 行, 另一个影响 0 行被跳过。
 */
export async function claimBatch({ limit = PARAMS.queue.batchSize, now = Date.now(), kinds = [], leaseMs = 15 * 60_000 } = {}) {
  const nowIso = new Date(now).toISOString();
  const staleBefore = new Date(now - leaseMs).toISOString();
  // 上一个 worker 崩溃后，超过租约的 running 任务重新可认领。
  let stale = supabase.from('jobs').update({ status: 'pending', locked_at: null, locked_by: null, updated_at: nowIso })
    .eq('status', 'running').or(`locked_at.is.null,locked_at.lt.${staleBefore}`);
  if (kinds.length) stale = stale.in('kind', kinds);
  await stale;

  let query = supabase
    .from('jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('run_after', nowIso)
    .order('run_after', { ascending: true })
    .limit(limit);
  if (kinds.length) query = query.in('kind', kinds);
  const { data: pend, error } = await query;
  if (error) throw error;
  if (!pend || pend.length === 0) return [];

  const claimed = [];
  for (const job of pend) {
    const { data, error: e } = await supabase
      .from('jobs')
      .update({ status: 'running', locked_at: nowIso, locked_by: `${process.pid}`, updated_at: nowIso })
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
    .update({ status: 'done', result, locked_at: null, locked_by: null, updated_at: new Date().toISOString() })
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
      locked_at: null,
      locked_by: null,
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
  constructor({
    handlers = {},
    store = null,
    batchSize = PARAMS.queue.batchSize,
    handlerTimeoutMs = PARAMS.queue.handlerTimeoutMs,
    clock = () => Date.now(),
  } = {}) {
    this.handlers = handlers;
    this.batchSize = batchSize;
    this.handlerTimeoutMs = handlerTimeoutMs;
    this.clock = clock;
    this.store = store ?? {
      claimBatch: (opts) => claimBatch(opts),
      complete: (id, result) => completeJob(id, result),
      fail: (job, msg, now) => failJob(job, msg, now),
    };
    this._timer = null;
    this._ticking = false;
    this.metrics = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  /** 跑一轮: 认领一批 → 逐个 handler → 成功 complete / 失败 fail(退避重试)。返回本轮结果摘要。 */
  async tick() {
    if (this._ticking) return { claimed: 0, results: [], skippedOverlap: true };
    this._ticking = true;
    try {
    const now = this.clock();
    const jobs = await this.store.claimBatch({ limit: this.batchSize, now, kinds: Object.keys(this.handlers) }).catch((e) => {
      console.error('[worker] claimBatch failed:', e?.message ?? e);
      return [];
    });
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
        // handler 挂起 (如 LLM 调用没有超时) 不能冻结整个 worker: 卡够 handlerTimeoutMs 就当失败进重试,
        // 原 promise 可能仍在后台跑, 但不再挡后续 job 的认领/执行。
        const result = await runWithTimeout(() => handler(job.payload ?? {}, job), this.handlerTimeoutMs, `job ${job.kind} 超时 (${this.handlerTimeoutMs}ms)`);
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
    } finally {
      this._ticking = false;
    }
  }

  start({ intervalMs = 2000 } = {}) {
    if (this._timer) return this._timer;
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[worker]', e)), intervalMs);
    this._timer.unref?.();
    return this._timer;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

/** work() 超过 ms 未完成就 reject; 原 promise 不会被真正取消, 只是不再阻塞调用方。
 *  注意: timer 不能 unref —— 卡住的 work() 没有其它 handle 撑着事件循环时, unref 会让进程在
 *  timer 触发前就退出 (Node 判定"没有更多活干"), 表现成这个 await 永远不 settle。 */
function runWithTimeout(work, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
}
