import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PARAMS } from './params.js';

const defaultDir = () => path.resolve(process.env.TRACE_DIR || 'logs/traces');
const activeReply = new AsyncLocalStorage();

/** Correlates nested LLM/retrieval calls with one reply, including concurrent replies. */
export function withReplyTrace(fn) {
  return activeReply.run({ llmCalls: [], memoryHits: [] }, fn);
}

export function appendLlmCall(call) {
  const context = activeReply.getStore();
  if (context) context.llmCalls.push({ ...call });
}

export function setMemoryHits(hits = []) {
  const context = activeReply.getStore();
  if (context) context.memoryHits = hits.map((hit) => ({ ...hit }));
}

export function activeReplyTrace() {
  const context = activeReply.getStore();
  return context
    ? { llmCalls: context.llmCalls.map((call) => ({ ...call })), memoryHits: context.memoryHits.map((hit) => ({ ...hit })) }
    : null;
}

export function traceDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function priceLlmCall(call = {}, pricing = PARAMS.trace?.pricing ?? {}) {
  const modelPrice = pricing[call.model] ?? pricing.default ?? { inputPerMillion: 0, outputPerMillion: 0 };
  const promptTokens = Number(call.promptTokens ?? call.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(call.completionTokens ?? call.completion_tokens ?? 0) || 0;
  return (promptTokens * (Number(modelPrice.inputPerMillion) || 0)
    + completionTokens * (Number(modelPrice.outputPerMillion) || 0)) / 1_000_000;
}

export function normalizeReplyTrace(input = {}) {
  const llmCalls = (input.llmCalls ?? []).map((call) => ({
    stage: call.stage ?? 'reply',
    model: call.model ?? 'unknown',
    promptTokens: Number(call.promptTokens ?? call.prompt_tokens ?? 0) || 0,
    completionTokens: Number(call.completionTokens ?? call.completion_tokens ?? 0) || 0,
    costUsd: Number(call.costUsd ?? priceLlmCall(call)) || 0,
    latencyMs: Number(call.latencyMs ?? 0) || 0,
    calls: Math.max(1, Number(call.calls) || 1),
  }));
  return {
    ts: input.ts ?? new Date().toISOString(),
    userId: String(input.userId ?? ''),
    companionId: String(input.companionId ?? 'default'),
    eventId: input.eventId ?? null,
    userMessage: String(input.userMessage ?? ''),
    reply: String(input.reply ?? ''),
    memoryHits: (input.memoryHits ?? []).map((hit) => ({
      id: hit.id ?? null,
      type: hit.type ?? null,
      score: Number(hit._score ?? hit.score ?? hit.activation ?? 0) || 0,
      similarity: Number(hit.similarity ?? 0) || 0,
    })),
    promptBytes: input.promptBytes ?? { persona: 0, state: 0, memory: 0, history: 0, total: 0 },
    llmCalls,
    emotionLabel: input.emotionLabel ?? null,
    behaviorPolicy: input.behaviorPolicy ?? null,
    sceneType: input.sceneType ?? null,
    stateSnapshot: input.stateSnapshot ?? null,
    lastTurns: Array.isArray(input.lastTurns) ? input.lastTurns.slice(-4) : [],
    totalLatencyMs: Number(input.totalLatencyMs ?? 0) || 0,
    totalCostUsd: Number(input.totalCostUsd ?? llmCalls.reduce((sum, call) => sum + call.costUsd, 0)) || 0,
    pipelineVersion: input.pipelineVersion ?? null,
    turnId: input.turnId ?? null,
    stages: (input.stages ?? []).map((stage) => ({
      stage: String(stage.stage ?? ''),
      status: String(stage.status ?? 'skipped'),
      latencyMs: Number(stage.latencyMs ?? 0) || 0,
      warningCodes: Array.isArray(stage.warningCodes) ? stage.warningCodes.map(String) : [],
      errorCode: stage.errorCode == null ? null : String(stage.errorCode),
    })),
    commitStatus: input.commitStatus ?? null,
    executionOrder: Array.isArray(input.executionOrder)
      ? input.executionOrder.map(String)
      : [],
    interpretEmotion: {
      label: input.interpretEmotion?.label ?? null,
      confidence: input.interpretEmotion?.confidence != null &&
        Number.isFinite(Number(input.interpretEmotion.confidence))
        ? Number(input.interpretEmotion.confidence)
        : null,
    },
    evidenceSummary: {
      memoryHitCount: Number(input.evidenceSummary?.memoryHitCount ?? 0) || 0,
      beliefCount: Number(input.evidenceSummary?.beliefCount ?? 0) || 0,
    },
    deliberateRationaleCodes: Array.isArray(input.deliberateRationaleCodes)
      ? input.deliberateRationaleCodes.map(String)
      : [],
    ablationFlags: { ...(input.ablationFlags ?? {}) },
  };
}

/** Fire-and-forget safe: never throws, including read-only/missing directories. */
export function record(input, { dir = defaultDir(), appendFile = fs.appendFileSync } = {}) {
  try {
    const trace = normalizeReplyTrace(input);
    fs.mkdirSync(dir, { recursive: true });
    appendFile(path.join(dir, `${traceDay(trace.ts)}.jsonl`), `${JSON.stringify(trace)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function query({ day = traceDay(), userId, dir = defaultDir() } = {}) {
  try {
    const file = path.join(dir, `${day}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        const item = JSON.parse(line);
        return !userId || item.userId === userId ? [item] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function dailyCost(day = traceDay(), options = {}) {
  const traces = query({ ...options, day });
  return traces.reduce((summary, trace) => {
    summary.traces += 1;
    summary.calls += (trace.llmCalls ?? []).reduce((n, call) => n + (Number(call.calls) || 1), 0);
    summary.promptTokens += (trace.llmCalls ?? []).reduce((n, call) => n + (Number(call.promptTokens) || 0), 0);
    summary.completionTokens += (trace.llmCalls ?? []).reduce((n, call) => n + (Number(call.completionTokens) || 0), 0);
    summary.tokens = summary.promptTokens + summary.completionTokens;
    summary.costUsd += Number(trace.totalCostUsd) || 0;
    return summary;
  }, { day, traces: 0, calls: 0, promptTokens: 0, completionTokens: 0, tokens: 0, costUsd: 0 });
}

export function writeDailyCost(day, { dir = path.resolve('logs'), warn = console.warn } = {}) {
  const summary = dailyCost(day, { dir: path.join(dir, 'traces') });
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'cost-daily.jsonl');
    const previous = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
          try {
            const row = JSON.parse(line);
            return row.day === day ? [] : [row];
          } catch {
            return [];
          }
        })
      : [];
    fs.writeFileSync(file, [...previous, summary].map((row) => JSON.stringify(row)).join('\n') + '\n');
  } catch {}
  if (summary.costUsd > (PARAMS.trace?.dailyBudgetUsd ?? Infinity)) {
    warn(`[trace] daily budget exceeded: $${summary.costUsd.toFixed(4)}`);
  }
  return summary;
}
