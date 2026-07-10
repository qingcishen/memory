// 轻量进程内监控 (无依赖)。
//
// 不引外部监控栈, 只在进程里累加几个关键计数 (LLM 调用次数 / token 估算 / 各类错误),
// 给 /status 或日志暴露一个快照, 看清"她最近忙不忙、花了多少"。重启清零 (够单进程用)。

const counters = new Map();

/** 计数 +n (默认 1)。 */
export function incr(name, n = 1) {
  counters.set(name, (counters.get(name) ?? 0) + n);
}

/** 读单个计数。 */
export function get(name) {
  return counters.get(name) ?? 0;
}

/** 当前所有计数的快照 (普通对象)。 */
export function metricsSnapshot() {
  return Object.fromEntries(counters);
}

/** 清零 (测试 / 周期归档用)。 */
export function resetMetrics() {
  counters.clear();
}

/** 记一次 LLM 调用: 次数 + (有 usage 时) token 估算。kind: reply / think / extract ... */
export function recordLlmCall(kind, usage = null) {
  incr('llm.calls');
  incr(`llm.calls.${kind}`);
  const total = usage?.total_tokens;
  if (typeof total === 'number') {
    incr('llm.tokens', total);
    incr(`llm.tokens.${kind}`, total);
  }
}
