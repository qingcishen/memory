import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { Orchestrator } from '../src/orchestrator/index.js';
import { appendLlmCall, setMemoryHits, traceDay } from '../src/trace.js';

function dependencies() {
  return {
    memory: {
      async recall() {
        const hits = [{ id: 'm1', type: 'preference', similarity: 0.9, _score: 0.8 }];
        setMemoryHits(hits);
        return { block: '你记得：对方不吃香菜', hits };
      },
      async observe() {},
    },
    stateLayer: {
      async snapshot() {
        return {
          emotion: { valence: 0.1, warmth: 0.6 },
          mood: { valence: 0.1, arousal: 0.3 },
          relationship: { closeness: 0.6, tension: 0, trust: 0.6 },
          life: { energy: 0.7, health: 1, satiety: 0.5 },
          desires: { attention: 0.2 },
        };
      },
      async evolve() {},
      toPrompt() { return '状态稳定'; },
      samplingHints() { return { maxTokens: 100 }; },
    },
    relationship: {
      async current() { return { relationship: { closeness: 0.6, tension: 0, trust: 0.6 } }; },
      async bump() {},
      toPrompt() { return '关系亲近'; },
    },
    persona: {
      async load() {},
      toPrompt() { return '自然、诚实'; },
    },
    llm: {
      async generateReply() {
        appendLlmCall({
          stage: 'reply',
          model: 'mock-model',
          promptTokens: 120,
          completionTokens: 12,
          latencyMs: 5,
        });
        return '记得，你不吃香菜。';
      },
    },
  };
}

describe('orchestrator trace integration', () => {
  test('three replies produce three complete correlated traces', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-orchestrator-trace-'));
    const previous = { dir: process.env.TRACE_DIR, enabled: process.env.TRACE_IN_TESTS };
    process.env.TRACE_DIR = root;
    process.env.TRACE_IN_TESTS = '1';
    try {
      const orchestrator = new Orchestrator({
        userId: 'trace-user',
        deps: dependencies(),
        options: { useMonologue: false },
      });
      for (const message of ['你好', '还记得我的忌口吗', '那就好']) {
        await orchestrator.reply(message);
        await Promise.resolve(orchestrator._lastAfterReply);
      }
      const rows = fs.readFileSync(path.join(root, `${traceDay()}.jsonl`), 'utf8')
        .split('\n').filter(Boolean).map(JSON.parse);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.memoryHits[0]).toMatchObject({ id: 'm1', type: 'preference' });
        expect(row.llmCalls[0]).toMatchObject({
          stage: 'reply',
          model: 'mock-model',
          promptTokens: 120,
          completionTokens: 12,
        });
        expect(row.promptBytes.total).toBeGreaterThan(0);
        expect(row.totalCostUsd).toBeGreaterThan(0);
        expect(row.totalLatencyMs).toBeGreaterThanOrEqual(0);
        expect(row.pipelineVersion).toBe(1);
        expect(row.stages.find((stage) => stage.stage === 'perceive')?.status).toBe('ok');
        expect(row.stages.find((stage) => stage.stage === 'interpret')?.status).toBe('ok');
        expect(row.stages.find((stage) => stage.stage === 'retrieve')?.status).toBe('ok');
        expect(row.stages.find((stage) => stage.stage === 'deliberate')?.status).toBe('ok');
        expect(row.stages.find((stage) => stage.stage === 'compose')?.status).toBe('ok');
        expect(row.stages.find((stage) => stage.stage === 'validate')?.status).toBe('ok');
        expect(row.commitStatus).toBe('ok');
      }
    } finally {
      if (previous.dir == null) delete process.env.TRACE_DIR;
      else process.env.TRACE_DIR = previous.dir;
      if (previous.enabled == null) delete process.env.TRACE_IN_TESTS;
      else process.env.TRACE_IN_TESTS = previous.enabled;
    }
  });
});
