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
  const store = {
    async claimBatch() {
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
  ok('成功的 job 被 complete(带 handler 返回值)', completed.length === 1 && completed[0].id === 'j1' && completed[0].result.echoed === 1);
  ok('抛错的 job 进 fail', failed.some((f) => f.id === 'j2' && /炸了/.test(f.msg)));
  ok('无 handler 的 job 也进 fail', failed.some((f) => f.id === 'j3' && /无 handler/.test(f.msg)));
  ok('metrics 统计正确', w.metrics.processed === 3 && w.metrics.succeeded === 1 && w.metrics.failed === 1 && w.metrics.skipped === 1);

  // 第二轮没有可取的 job
  const empty = await w.tick();
  ok('队列空时 tick 返回 0', empty.claimed === 0);
}

console.log(`\nM5 任务队列 全部 ${passed} 条断言通过`);
