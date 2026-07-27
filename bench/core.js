// E 线评测公共件: 纯逻辑, 离线可测。IO(LLM/DB)全部由调用方注入。

export const RUBRICS = ['memory_consistency', 'persona_stability', 'emotional_fitness', 'naturalness', 'no_breaking'];

/** 规则判卷: mustMention 全含且 mustNotMention 全不含。 */
export function ruleJudge(answer = '', expect = {}) {
  const text = String(answer);
  const must = expect.mustMention ?? [];
  const mustNot = expect.mustNotMention ?? [];
  return must.every((term) => text.includes(term)) && mustNot.every((term) => !text.includes(term));
}

/** 金标记忆在检索结果里的名次 (1-based); 未命中返回 Infinity。 */
export function goldRank(hits = [], goldIds = []) {
  const gold = new Set(goldIds);
  const index = hits.findIndex((hit) => gold.has(hit?.id));
  return index === -1 ? Infinity : index + 1;
}

export function retrievalMetrics(rows = []) {
  let at5 = 0, at10 = 0, reciprocal = 0;
  for (const row of rows) {
    const rank = Number(row.goldRank) || Infinity;
    if (rank <= 5) at5 += 1;
    if (rank <= 10) at10 += 1;
    if (Number.isFinite(rank)) reciprocal += 1 / rank;
  }
  const n = rows.length || 1;
  return { cases: rows.length, recallAt5: at5 / n, recallAt10: at10 / n, mrr: reciprocal / n };
}

export function summarizeRubrics(scores = []) {
  const perRubric = Object.fromEntries(RUBRICS.map((rubric) => {
    const values = scores.map((row) => Number(row[rubric])).filter(Number.isFinite);
    return [rubric, values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0];
  }));
  return { perRubric, overall: Object.values(perRubric).reduce((a, b) => a + b, 0) / RUBRICS.length };
}

/** judge 稳定性: 同一批转录两次评分的每维均分差。验收线: maxDelta ≤ 0.5。 */
export function judgeStability(first = [], second = []) {
  const a = summarizeRubrics(first).perRubric;
  const b = summarizeRubrics(second).perRubric;
  const perRubric = Object.fromEntries(RUBRICS.map((r) => [r, Math.abs((a[r] ?? 0) - (b[r] ?? 0))]));
  return { perRubric, maxDelta: Math.max(...Object.values(perRubric)) };
}

export function ablationConclusion(delta, noise = 0.5) {
  return Math.abs(delta) <= noise ? '无法证明增益' : delta > 0 ? '保留' : '有害,删除';
}

/** 运行前置检查: 缺哪个环境变量直接说清楚, 不烧一分钱。 */
export function requireEnv(names, env = process.env) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`缺少环境变量: ${missing.join(', ')} —— 在 .env 里补齐 (参考 .env.example) 后再跑。`);
  }
}

export class BudgetExceededError extends Error {
  constructor(spent, budget) {
    super(`评测成本 $${spent.toFixed(4)} 超过预算 $${budget} —— 用 --force 强行继续, 或调 BENCH_BUDGET_USD。`);
    this.name = 'BudgetExceededError';
  }
}

/** 成本表: 自己发起的调用逐笔记账, 库内部调用用 metrics 快照差补账。 */
export class CostMeter {
  constructor({ budgetUsd = 5, force = false, pricing = {} } = {}) {
    this.budgetUsd = budgetUsd;
    this.force = force;
    this.pricing = pricing;
    this.direct = 0;
    this.indirect = 0;
    this.calls = 0;
  }

  price(model, promptTokens = 0, completionTokens = 0) {
    const p = this.pricing[model] ?? this.pricing.default ?? { inputPerMillion: 0, outputPerMillion: 0 };
    return (promptTokens * (Number(p.inputPerMillion) || 0) + completionTokens * (Number(p.outputPerMillion) || 0)) / 1_000_000;
  }

  addUsage(model, usage = {}) {
    this.calls += 1;
    this.direct += this.price(model, usage.prompt_tokens ?? usage.input_tokens ?? 0, usage.completion_tokens ?? usage.output_tokens ?? 0);
    this.check();
  }

  /** metrics.metricsSnapshot() 前后差 -> 库内部 (extract/think/reply/...) 的 token 账。 */
  settleMetricsDiff(before = {}, after = {}) {
    let prompt = 0, completion = 0;
    for (const [key, value] of Object.entries(after)) {
      const delta = value - (before[key] ?? 0);
      if (delta <= 0) continue;
      if (key.startsWith('llm.prompt_tokens.')) prompt += delta;
      if (key.startsWith('llm.completion_tokens.')) completion += delta;
    }
    this.indirect += this.price('default', prompt, completion);
    this.check();
  }

  get totalUsd() {
    return this.direct + this.indirect;
  }

  check() {
    if (!this.force && this.totalUsd > this.budgetUsd) throw new BudgetExceededError(this.totalUsd, this.budgetUsd);
  }
}

/** bench-history 表格行。 */
export function historyRow({ date, bench, mode, overall, recallAt5 = null, mrr = null, note = '' }) {
  const fmt = (x) => (x == null ? '—' : typeof x === 'number' ? x.toFixed(2) : String(x));
  return `| ${date} | ${bench} | ${mode} | ${fmt(overall)} | ${fmt(recallAt5)} | ${fmt(mrr)} | ${note} |`;
}
