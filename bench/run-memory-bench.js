// E1 · 长程记忆基准 (真实管线)。
//
// 每题: bench_ 前缀的独立 userId -> 按 daysAgo 时序把 sessions 灌进真实 Memory.observe
// (走真实提取 LLM + Supabase 落库, 落库后把 created_at/last_accessed/access_log 回拨到模拟日期)
// -> 用生产 recall 路径检索 -> 金标记忆算 recall@k / MRR -> 回复模型只凭记忆块作答
// -> 规则判卷, 不过再交 judge 仲裁 (照顾"我没听说过"这类同义表达)。
//
// 运行: npm run bench:memory   (需要 .env 里的 Supabase / LLM / Embedding 凭证)
// 数据隔离: 只写 bench_ 用户; npm run bench:clean 一键清除。

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BudgetExceededError, CostMeter, goldRank, historyRow, requireEnv, retrievalMetrics, ruleJudge,
} from './core.js';
import { benchClients, chatJson, chatText } from './clients.js';

const ANSWER_SYSTEM = `你是一个 AI 伴侣, 下面「记忆」小节是你关于对方仅有的记忆。
只依据这些记忆回答对方的问题; 记忆里没有的信息必须直说不知道/你没告诉过我, 严禁编造。
涉及先后顺序时按记忆内容判断。用一两句中文自然回答, 不要提"记忆"这个系统词。`;

const ARBITER_SYSTEM = `你是记忆问答的判卷员。根据「判定标准」判断「回答」是否合格, 只输出 JSON: {"correct": true/false, "reason": "一句话"}。
- kind=abstention: 合格 = 明确承认不知道/没听说过, 且没有编造任何具体内容; 任何编造 = 不合格
- kind=update: 合格 = 以最新的偏好/事实为准作答; 把过时事实当现状 = 不合格
- 其他: 合格 = 表达出了 mustMention 的事实要点 (同义改写算合格), 且没有把 mustNotMention 的内容当成事实说出来`;

/**
 * 核心流程, IO 全部经 deps 注入以便离线单测:
 * { userId(item), makeMemory(userId), ingest(mem, turns) -> stored[], backdate(ids, iso),
 *   recall(mem, q) -> hits[], format(hits) -> block, answer(block, q), arbitrate(item, q, answer), now() }
 */
export async function runMemoryBench(cases, deps) {
  const rows = [];
  for (const item of cases) {
    const mem = await deps.makeMemory(deps.userId(item));
    const sessions = [...item.sessions].sort((a, b) => b.daysAgo - a.daysAgo);
    const explicitGold = new Set(
      (item.goldSessionIndexes ?? []).map((index) => item.sessions[index]).filter(Boolean),
    );
    // 兼容旧 fixture：update 只取最新事实；abstention 无 gold；其它取全部。
    const goldSessions = item.goldSessionIndexes
      ? explicitGold
      : item.kind === 'abstention'
        ? new Set()
        : item.kind === 'update'
          ? new Set([sessions.at(-1)])
          : new Set(sessions);
    const goldIds = [];
    for (const session of sessions) {
      const stored = await deps.ingest(mem, session.turns);
      const ids = stored.map((m) => m.id).filter(Boolean);
      if (ids.length) await deps.backdate(ids, new Date(deps.now() - session.daysAgo * 86400000).toISOString());
      if (goldSessions.has(session)) goldIds.push(...ids);
    }
    for (const question of item.questions ?? [item.question]) {
      const hits = await deps.recall(mem, question);
      const rank = goldRank(hits, goldIds);
      const answer = await deps.answer(deps.format(hits), question);
      let correct = ruleJudge(answer, item.expect);
      let arbitrated = false;
      if (!correct && deps.arbitrate) {
        correct = Boolean(await deps.arbitrate(item, question, answer));
        arbitrated = true;
      }
      rows.push({
        id: item.id, kind: item.kind, question, answer, correct, arbitrated,
        goldRank: rank, goldCount: goldIds.length, hits: hits.length,
        retrievalLatencyMs: hits._bench?.latencyMs ?? null,
        rerankCostUsd: hits._bench?.rerankCostUsd ?? 0,
      });
    }
  }
  return summarize(rows);
}

export function summarize(rows) {
  const kinds = [...new Set(rows.map((row) => row.kind))];
  const perKind = Object.fromEntries(kinds.map((kind) => {
    const group = rows.filter((row) => row.kind === kind);
    return [kind, { cases: group.length, accuracy: group.filter((row) => row.correct).length / (group.length || 1) }];
  }));
  // abstention 无金标 (甚至可能什么都没存), 不计入检索指标; 提取没落库的题也剔除 (goldCount=0)。
  const retrievalRows = rows.filter((row) => row.kind !== 'abstention' && row.goldCount > 0);
  const latencies = rows.map((row) => Number(row.retrievalLatencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    cases: rows.length,
    perKind,
    retrieval: {
      ...retrievalMetrics(retrievalRows),
      p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : null,
      avgRerankCostUsd: rows.reduce((sum, row) => sum + (Number(row.rerankCostUsd) || 0), 0) / (rows.length || 1),
    },
    overall: rows.filter((row) => row.correct).length / (rows.length || 1),
    rows,
  };
}

// ---- 真实依赖 (仅 CLI 路径 import src/*, 保证单测零 DB/LLM 依赖) ----

export async function liveDeps({ runTag, meter, reranker = 'activation', hybrid = false }) {
  const [{ Memory }, { supabase }, { formatForPrompt }] = await Promise.all([
    import('../src/memory.js'),
    import('../src/config.js'),
    import('../src/retrieve.js'),
  ]);
  const clients = benchClients();
  if (!clients.judgeIndependent) throw new Error('JUDGE_* 必须与被评回复模型不同源，拒绝自评');
  return {
    userId: (item) => `bench_mem_${runTag}_${item.id}`,
    makeMemory: (userId) => new Memory({ userId, subjectName: '对方', companionName: '她' }),
    ingest: async (mem, turns) => (await mem.observe(turns)).stored ?? [],
    backdate: async (ids, iso) => {
      const { error } = await supabase.from('memories')
        .update({ created_at: iso, last_accessed: iso, access_log: [iso] })
        .in('id', ids);
      if (error) throw error;
    },
    recall: async (mem, question) => {
      const { metricsSnapshot } = await import('../src/metrics.js');
      const before = metricsSnapshot();
      const startedAt = Date.now();
      const hits = await mem.recall(question, {
        reranker,
        hybrid,
        reconsolidate: false,
        includeDyad: 0,
        topK: 10,
      });
      const after = metricsSnapshot();
      const prompt = (after['llm.prompt_tokens.rerank'] ?? 0) - (before['llm.prompt_tokens.rerank'] ?? 0);
      const completion = (after['llm.completion_tokens.rerank'] ?? 0) - (before['llm.completion_tokens.rerank'] ?? 0);
      hits._bench = {
        latencyMs: Date.now() - startedAt,
        rerankCostUsd: meter.price(process.env.LLM_MODEL || 'default', prompt, completion),
      };
      return hits;
    },
    format: (hits) => formatForPrompt(hits, '对方'),
    answer: (block, question) => chatText(
      clients.answer, clients.answerModel,
      `${ANSWER_SYSTEM}\n\n【记忆】\n${block || '(你对对方还没有任何记忆)'}`,
      question,
      { meter },
    ),
    arbitrate: async (item, question, answer) => {
      const verdict = await chatJson(clients.judge, clients.judgeModel, ARBITER_SYSTEM, JSON.stringify({
        kind: item.kind, question, answer, 判定标准: item.expect,
      }), { meter });
      return verdict.correct === true;
    },
    now: () => Date.now(),
  };
}

export async function main() {
  if (process.argv.includes('--smoke')) {
    const items = JSON.parse(fs.readFileSync(new URL('./memory-bench.cases.json', import.meta.url), 'utf8'));
    const counts = items.reduce((out, item) => ({ ...out, [item.kind]: (out[item.kind] ?? 0) + 1 }), {});
    const valid = ['fact', 'update', 'temporal', 'multi-session', 'abstention'].every((kind) => (counts[kind] ?? 0) >= 10);
    console.log(JSON.stringify({ mode: 'smoke-schema-only', evidence: false, cases: items.length, perKind: counts, valid }, null, 2));
    if (!valid) process.exitCode = 1;
    return { valid };
  }
  requireEnv(['SUPABASE_URL', 'SUPABASE_KEY', 'LLM_API_KEY', 'JUDGE_API_KEY', 'JUDGE_BASE_URL', 'JUDGE_MODEL']);
  const force = process.argv.includes('--force');
  const { metricsSnapshot } = await import('../src/metrics.js');
  const { PARAMS } = await import('../src/params.js');
  const meter = new CostMeter({
    budgetUsd: Number(process.env.BENCH_BUDGET_USD) || 5,
    force,
    pricing: PARAMS.trace?.pricing ?? {},
  });
  const cases = JSON.parse(fs.readFileSync(new URL('./memory-bench.cases.json', import.meta.url), 'utf8'));
  const reranker = process.argv.find((arg) => arg.startsWith('--reranker='))?.split('=')[1] || 'activation';
  const hybrid = process.argv.includes('--hybrid');
  const runTag = Date.now().toString(36);
  console.error(`[bench:memory] ${cases.length} 题, reranker=${reranker}, hybrid=${hybrid}, runTag=${runTag}, 预算 $${meter.budgetUsd}`);
  const before = metricsSnapshot();
  const deps = await liveDeps({ runTag, meter, reranker, hybrid });

  let result;
  try {
    result = await runMemoryBench(cases, deps);
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      console.error(error.message);
      process.exitCode = 1;
      return null;
    }
    throw error;
  }
  meter.settleMetricsDiff(before, metricsSnapshot());

  const output = {
    ts: new Date().toISOString(),
    mode: 'live',
    runTag,
    reranker,
    hybrid,
    ...result,
    costUsd: Number(meter.totalUsd.toFixed(4)),
    llmCallsDirect: meter.calls,
  };
  const day = output.ts.slice(0, 10);
  fs.mkdirSync(path.resolve('bench/results'), { recursive: true });
  fs.writeFileSync(path.resolve(`bench/results/${day}-memory-${reranker}${hybrid ? '-hybrid' : ''}.json`), `${JSON.stringify(output, null, 2)}\n`);
  appendHistory(historyRow({
    date: day, bench: 'memory-v3', mode: 'live',
    overall: output.overall, recallAt5: output.retrieval.recallAt5, mrr: output.retrieval.mrr,
    note: `${output.cases} 问 / $${output.costUsd} / runTag=${runTag}`,
  }));
  const { rows, ...printable } = output;
  console.log(JSON.stringify(printable, null, 2));
  return output;
}

export function appendHistory(row, file = path.resolve('docs/bench-history.md')) {
  try {
    fs.appendFileSync(file, `${row}\n`);
  } catch {}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
