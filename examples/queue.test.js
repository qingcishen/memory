// M5 纯逻辑测试: 持久化任务队列 (退避/重试决策 + Worker 分发)。不连网, Worker 注入 mock store。
import assert from 'node:assert';
import { nextBackoffMs, decideAfterFailure, isClaimable, Worker } from '../src/queue/jobs.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('退避 / 重试决策 (纯逻辑)');
{
  ok('退避指数增长', nextBackoffMs(0) < nextBackoffMs(1) && nextBackoffMs(1) < nextBackoffMs(2));
  ok('退避有上限', nextBackoffMs(100) === PARAMS.queue.maxBackoffMs);

  const now = Date.now();
  const retry = decideAfterFailure({ attempts: 0 }, now);
  ok('未超次数 → 回 pending 重试', retry.status === 'pending' && retry.attempts === 1);
  ok('重试把 run_after 推到未来', new Date(retry.run_after).getTime() > now);

  const dead = decideAfterFailure({ attempts: PARAMS.queue.maxAttempts - 1 }, now);
  ok('达到最大次数 → failed', dead.status === 'failed');
}

console.log('isClaimable');
{
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60000).toISOString();
  ok('pending 且到期 → 可取', isClaimable({ status: 'pending', run_after: past }) === true);
  ok('pending 但未到期 → 不可取', isClaimable({ status: 'pending', run_after: future }) === false);
  ok('running → 不可取', isClaimable({ status: 'running', run_after: past }) === false);
}

console.log('Worker.tick (注入 mock store + handlers, 离线)');
{
  const completed = [];
  const failed = [];
  const batch = [
    { id: 'j1', kind: 'observe', payload: { n: 1 } },
    { id: 'j2', kind: 'boom', payload: {} },
    { id: 'j3', kind: 'unknown', payload: {} },
  ];
  let served = false;
  let claimOpts = null;
  const store = {
    async claimBatch(opts) {
      claimOpts = opts;
      if (served) return [];
      served = true;
      return batch;
    },
    async complete(id, result) {
      completed.push({ id, result });
    },
    async fail(job, msg) {
      failed.push({ id: job.id, msg });
    },
  };
  const handlers = {
    observe: async (payload) => ({ echoed: payload.n }),
    boom: async () => {
      throw new Error('炸了');
    },
    // 没有 'unknown' handler
  };
  const w = new Worker({ handlers, store });
  const summary = await w.tick();

  ok('认领到 3 个 job', summary.claimed === 3);
  ok('Worker 只认领自己有 handler 的任务类型', claimOpts.kinds.includes('observe') && claimOpts.kinds.includes('boom') && !claimOpts.kinds.includes('unknown'));
  ok('成功的 job 被 complete(带 handler 返回值)', completed.length === 1 && completed[0].id === 'j1' && completed[0].result.echoed === 1);
  ok('抛错的 job 进 fail', failed.some((f) => f.id === 'j2' && /炸了/.test(f.msg)));
  ok('无 handler 的 job 也进 fail', failed.some((f) => f.id === 'j3' && /无 handler/.test(f.msg)));
  ok('metrics 统计正确', w.metrics.processed === 3 && w.metrics.succeeded === 1 && w.metrics.failed === 1 && w.metrics.skipped === 1);

  // 第二轮没有可取的 job
  const empty = await w.tick();
  ok('队列空时 tick 返回 0', empty.claimed === 0);
}

console.log('Worker.tick 卡死的 handler 不冻结整个 worker (超时后当失败处理)');
{
  const failed = [];
  const store = {
    async claimBatch() {
      return [{ id: 'stuck', kind: 'hang', payload: {} }];
    },
    async complete() {},
    async fail(job, msg) {
      failed.push({ id: job.id, msg });
    },
  };
  const handlers = { hang: () => new Promise(() => {}) }; // 永不 resolve, 模拟挂起的 LLM 调用
  const w = new Worker({ handlers, store, handlerTimeoutMs: 20 });
  const summary = await w.tick();

  ok('tick 没有被卡死的 handler 挂住 (按时返回)', summary.claimed === 1);
  ok('超时的 job 进 fail 而不是永久 running', failed.some((f) => f.id === 'stuck' && /超时/.test(f.msg)));
  ok('_ticking 复位, 下一轮还能继续认领', w._ticking === false);
}

console.log('Worker.tick claimBatch 报错时不吞掉 (返回空批次而不是抛出/挂起)');
{
  const store = {
    async claimBatch() {
      throw new Error('schema cache 里没有这一列');
    },
  };
  const w = new Worker({ handlers: { x: async () => {} }, store });
  const summary = await w.tick();
  ok('claimBatch 抛错时 tick 仍正常返回', summary.claimed === 0);
}

console.log(`\nM5 任务队列 全部 ${passed} 条断言通过`);
