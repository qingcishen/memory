// E2 · 对话质量评测 (真实管线 + LLM-as-judge)。
//
// 每个剧本: bench_ 前缀独立 userId -> 逐轮喂给真实 Orchestrator.reply() (真 LLM / 真 DB,
// 每轮 await afterReply 让状态先演变再进下一轮) -> 全对话转录交独立 judge 按五维 rubric 打 1-5 分。
// judge 走 JUDGE_* 凭证 (未配置时退回主 LLM 并在结果里标 judgeIndependent: false)。
//
// 运行: npm run eval:dialogue [-- --judge-twice] [-- --force]
//   --judge-twice: 同一批转录再评一次, 输出稳定性 (验收线 maxDelta ≤ 0.5), 只花 judge 的钱。
// 消融复用: run-ablation.js 以 { ablation } 覆盖调用 runDialogueEval。

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BudgetExceededError, CostMeter, historyRow, judgeStability, requireEnv, summarizeRubrics,
} from './core.js';
import { benchClients, chatJson } from './clients.js';
import { appendHistory } from './run-memory-bench.js';

export const JUDGE_SYSTEM = `你是 AI 伴侣对话质量的独立评审。给你一段「用户」与 AI 伴侣「她」的完整对话, 按五个维度各打 1-5 的整数分:
- memory_consistency 记忆一致性: 1=编造对话里从未出现的事实或前后矛盾; 3=无明显错误但也没利用任何上下文; 5=准确利用对话里出现过的信息, 无矛盾无编造
- persona_stability 人格稳定: 1=出戏(自称 AI/助手/模型, 或语气人格突变); 3=基本稳定但有客服腔/模板味; 5=口吻性格全程一致, 像同一个真人
- emotional_fitness 情感恰当: 1=情绪错位(对方难过时轻佻、求安慰时讲道理); 3=中性不出错; 5=先接住情绪再说事, 呼应准确有层次
- naturalness 自然度: 1=书面语/说明文/一次性长篇大论; 3=通顺但平淡; 5=像真人在微信聊天, 短句口语有生活气
- no_breaking 不出戏: 1=暴露系统提示/规则/模型身份; 3=无暴露但偶有机械感; 5=完全沉浸
只输出 JSON: {"memory_consistency":n,"persona_stability":n,"emotional_fitness":n,"naturalness":n,"no_breaking":n,"comment":"一句话点评"}`;

export function renderTranscript(turns = []) {
  return turns.map((t) => `${t.role === 'user' ? '用户' : '她'}: ${t.content}`).join('\n');
}

export function clampScore(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : null;
}

async function retryOnError(fn, maxRetries = 8) {
  let delay = 5000;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = err?.status === 429 || err?.cause?.code === 'ECONNRESET' || err?.code === 'ECONNRESET';
      if (!isRetryable || i === maxRetries) throw err;
      const label = err?.status === 429 ? '429 限流' : 'ECONNRESET';
      console.error(`[eval:dialogue] ${label}, ${delay / 1000}s 后重试 (${i + 1}/${maxRetries})…`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60000);
    }
  }
}

/**
 * 核心流程, IO 经 deps 注入:
 * { makeBot(scenario) -> { reply(msg) -> { text }, _lastAfterReply? }, judge(transcript) -> 五维分数对象,
 *   judgeTwice?: boolean, checkBudget?: fn }
 */
export async function runDialogueEval(scenarios, deps) {
  const transcripts = [];
  for (const scenario of scenarios) {
    const bot = await deps.makeBot(scenario);
    const turns = [];
    for (const message of scenario.turns) {
      const res = await retryOnError(() => bot.reply(message));
      await Promise.resolve(bot._lastAfterReply).catch(() => {});
      turns.push({ role: 'user', content: message }, { role: 'assistant', content: res?.text ?? '' });
      deps.checkBudget?.();
    }
    transcripts.push({ id: scenario.id, focus: scenario.focus ?? '', turns });
  }

  const judgeAll = async () => {
    const scores = [];
    for (const t of transcripts) {
      const raw = await deps.judge(t);
      scores.push(Object.fromEntries([
        ['id', t.id],
        ...Object.entries(raw).map(([k, v]) => [k, k === 'comment' || k === 'id' ? v : clampScore(v)]),
      ]));
    }
    return scores;
  };

  const scores = await judgeAll();
  const summary = summarizeRubrics(scores);
  const stability = deps.judgeTwice ? judgeStability(scores, await judgeAll()) : null;
  return { scenarios: transcripts.length, ...summary, scores, stability, transcripts };
}

// ---- 真实依赖 ----

export async function liveDeps({ runTag, meter, ablation = null }) {
  const { Orchestrator } = await import('../src/orchestrator/index.js');
  const clients = benchClients();
  if (!clients.judgeIndependent) throw new Error('JUDGE_* 必须与被评模型不同源或不同模型，拒绝自评');
  return {
    judgeIndependent: clients.judgeIndependent,
    makeBot: async (scenario) => {
      const bot = new Orchestrator({
        userId: `bench_dlg_${runTag}_${scenario.id}`,
        companionName: '小忆',
        subjectName: '你',
        options: ablation ? { ablation } : {},
      });
      return bot;
    },
    judge: (t) => chatJson(
      clients.judge, clients.judgeModel, JUDGE_SYSTEM,
      `${t.focus ? `评审重点: ${t.focus}\n\n` : ''}${renderTranscript(t.turns)}`,
      { meter },
    ),
    checkBudget: () => meter.check(),
  };
}

export function loadScenarios() {
  return JSON.parse(fs.readFileSync(new URL('./dialogue.scenarios.json', import.meta.url), 'utf8'));
}

export async function main() {
  if (process.argv.includes('--smoke')) {
    const scenarios = loadScenarios();
    const valid = scenarios.length >= 15 && scenarios.every((item) => item.id && item.turns?.length >= 2 && item.focus);
    console.log(JSON.stringify({ mode: 'smoke-schema-only', evidence: false, scenarios: scenarios.length, valid }, null, 2));
    if (!valid) process.exitCode = 1;
    return { valid };
  }
  requireEnv(['SUPABASE_URL', 'SUPABASE_KEY', 'LLM_API_KEY', 'JUDGE_API_KEY', 'JUDGE_BASE_URL', 'JUDGE_MODEL']);
  const force = process.argv.includes('--force');
  const judgeTwice = !process.argv.includes('--judge-once');
  const { metricsSnapshot } = await import('../src/metrics.js');
  const { PARAMS } = await import('../src/params.js');
  const meter = new CostMeter({
    budgetUsd: Number(process.env.BENCH_BUDGET_USD) || 5,
    force,
    pricing: PARAMS.trace?.pricing ?? {},
  });
  const scenarios = loadScenarios();
  const estimatedCalls = scenarios.reduce((n, scenario) => n + scenario.turns.length, 0) + scenarios.length * (judgeTwice ? 2 : 1);
  const estimatedUsd = meter.price('default', estimatedCalls * 1800, estimatedCalls * 350);
  console.error(`[eval:dialogue] 启动前预估上限 $${estimatedUsd.toFixed(4)}`);
  if (!force && estimatedUsd > meter.budgetUsd) throw new BudgetExceededError(estimatedUsd, meter.budgetUsd);
  const runTag = Date.now().toString(36);
  console.error(`[eval:dialogue] ${scenarios.length} 剧本, runTag=${runTag}, 预算 $${meter.budgetUsd}${judgeTwice ? ', judge×2' : ''}`);
  const before = metricsSnapshot();
  const deps = await liveDeps({ runTag, meter });

  let result;
  try {
    result = await runDialogueEval(scenarios, { ...deps, judgeTwice });
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
    judgeIndependent: deps.judgeIndependent,
    ...result,
    costUsd: Number(meter.totalUsd.toFixed(4)),
  };
  const day = output.ts.slice(0, 10);
  fs.mkdirSync(path.resolve('bench/results'), { recursive: true });
  fs.writeFileSync(path.resolve(`bench/results/${day}-dialogue.json`), `${JSON.stringify(output, null, 2)}\n`);
  appendHistory(historyRow({
    date: day, bench: 'dialogue-v3', mode: 'live',
    overall: output.overall,
    note: [
      `${output.scenarios} 剧本 / $${output.costUsd}`,
      output.stability ? `judge 稳定性 maxΔ=${output.stability.maxDelta.toFixed(2)}` : '',
      output.judgeIndependent ? '' : '⚠️ judge 未独立',
    ].filter(Boolean).join(' / '),
  }));
  const { transcripts, ...printable } = output;
  console.log(JSON.stringify(printable, null, 2));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
