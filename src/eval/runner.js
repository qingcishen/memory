// Probe runner — 对目标模型跑测试集，缓存原始回复，记录延迟
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, buildMessages } from './testSuite.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULTS_DIR = path.join(ROOT, 'bench', 'results');

// 简单并发限流器（无外部依赖）
function makeLimiter(concurrency) {
  let running = 0;
  const queue = [];
  return async function limit(fn) {
    while (running >= concurrency) {
      await new Promise((r) => queue.push(r));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      if (queue.length > 0) queue.shift()();
    }
  };
}

function cacheKey(scenarioType, promptId, personaId, params) {
  const p = `t${params.temperature}_p${params.top_p}`;
  return `${scenarioType}:${promptId}:${personaId}:${p}`;
}

function loadCache(cacheFile) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return { meta: {}, results: {} };
  }
}

function saveCache(cacheFile, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
}

/**
 * 对所有场景 × persona 跑一次 probe，结果写入缓存文件。
 *
 * @param {object} config
 *   - model: string
 *   - apiKey: string
 *   - baseURL: string
 *   - persona: { id, name, systemPrompt }
 *   - params: { temperature, top_p }
 *   - maxConcurrency: number (default 5)
 *   - scenarios: string[] (default all, e.g. ['casual','affectionate'])
 * @returns {{ cacheFile: string, results: object }}
 */
export async function runProbe(config) {
  const {
    model,
    apiKey,
    baseURL = 'https://api.deepseek.com',
    persona,
    params = { temperature: 0.78, top_p: 0.95 },
    maxConcurrency = 5,
    scenarios = Object.keys(SCENARIOS),
    verbose = true,
  } = config;

  const client = new OpenAI({ apiKey, baseURL });
  const limit = makeLimiter(maxConcurrency);

  const dateStr = new Date().toISOString().slice(0, 10);
  const cacheFile = path.join(RESULTS_DIR, `probe-${model.replace(/[^a-z0-9-]/gi, '_')}-${dateStr}.json`);
  const cache = loadCache(cacheFile);

  if (!cache.meta.model) {
    cache.meta = { model, baseURL, date: dateStr, version: 1 };
  }

  const tasks = [];

  for (const scenarioType of scenarios) {
    const scenario = SCENARIOS[scenarioType];
    if (!scenario) continue;

    if (scenarioType === 'stability') {
      // 多轮对话：顺序执行，历史累积
      tasks.push(async () => {
        const key = `stability:full:${persona.id}:t${params.temperature}_p${params.top_p}`;
        if (cache.results[key]) {
          if (verbose) console.log(`  [skip] ${key}`);
          return;
        }
        const history = [];
        const turnResults = [];
        for (const userMsg of scenario.turns) {
          const msgs = [
            { role: 'system', content: persona.systemPrompt },
            ...history,
            { role: 'user', content: userMsg },
          ];
          const t0 = Date.now();
          const res = await client.chat.completions.create({
            model,
            messages: msgs,
            temperature: params.temperature,
            top_p: params.top_p,
            max_tokens: 200,
          });
          const latencyMs = Date.now() - t0;
          const reply = res.choices[0].message.content;
          history.push({ role: 'user', content: userMsg });
          history.push({ role: 'assistant', content: reply });
          turnResults.push({ user: userMsg, assistant: reply, latencyMs });
        }
        cache.results[key] = { turns: turnResults, personaId: persona.id };
        saveCache(cacheFile, cache);
        if (verbose) console.log(`  [done] ${key}`);
      });
    } else {
      for (const prompt of scenario.prompts) {
        const key = cacheKey(scenarioType, prompt.id, persona.id, params);
        tasks.push(async () => {
          if (cache.results[key]) {
            if (verbose) console.log(`  [skip] ${key}`);
            return;
          }
          const msgs = buildMessages(prompt, persona.systemPrompt, scenarioType);
          const t0 = Date.now();
          const res = await client.chat.completions.create({
            model,
            messages: msgs,
            temperature: params.temperature,
            top_p: params.top_p,
            max_tokens: 200,
          });
          const latencyMs = Date.now() - t0;
          cache.results[key] = {
            response: res.choices[0].message.content,
            latencyMs,
            promptTokens: res.usage?.prompt_tokens ?? 0,
            completionTokens: res.usage?.completion_tokens ?? 0,
            scenarioType,
            promptId: prompt.id,
            personaId: persona.id,
            intimacyLevel: prompt.intimacyLevel ?? null,
          };
          saveCache(cacheFile, cache);
          if (verbose) console.log(`  [done] ${key} (${latencyMs}ms)`);
        });
      }
    }
  }

  // stability 任务需要顺序，其余并发
  const stabilityTasks = tasks.filter((_, i) =>
    scenarios.includes('stability') && i === tasks.length - (scenarios.includes('stability') ? 1 : 0)
  );
  const parallelTasks = tasks.filter((t) => !stabilityTasks.includes(t));

  await Promise.all(parallelTasks.map((fn) => limit(fn)));
  for (const fn of stabilityTasks) await fn();

  const latencies = Object.values(cache.results)
    .map((r) => r.latencyMs)
    .filter(Boolean)
    .sort((a, b) => a - b);

  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  cache.meta.latency = { p50, p95, count: latencies.length };

  saveCache(cacheFile, cache);
  if (verbose) console.log(`\n[probe] done — ${Object.keys(cache.results).length} entries, p50=${p50}ms p95=${p95}ms`);

  return { cacheFile, results: cache.results, latency: { p50, p95 } };
}
