import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  activeReplyTrace,
  appendLlmCall,
  dailyCost,
  query,
  record,
  setMemoryHits,
  withReplyTrace,
  writeDailyCost,
} from '../src/trace.js';

describe('reply trace', () => {
  test('records, queries and totals costs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-trace-'));
    const dir = path.join(root, 'traces');
    const ts = '2026-07-27T10:00:00.000Z';
    record({ ts, userId: 'u1', llmCalls: [{ stage: 'reply', promptTokens: 100, completionTokens: 20, costUsd: 0.01 }] }, { dir });
    record({ ts, userId: 'u2', llmCalls: [{ stage: 'reply', promptTokens: 50, completionTokens: 10, costUsd: 0.02 }] }, { dir });
    expect(query({ day: '2026-07-27', userId: 'u1', dir })).toHaveLength(1);
    expect(dailyCost('2026-07-27', { dir })).toMatchObject({ traces: 2, calls: 2, tokens: 180, costUsd: 0.03 });
  });

  test('write failures never escape', () => {
    expect(() => record({ userId: 'u' }, { dir: '/dev/null/nope' })).not.toThrow();
    expect(record({ userId: 'u' }, { dir: '/dev/null/nope' })).toBe(false);
  });

  test('concurrent replies keep nested LLM calls and memory hits isolated', async () => {
    const run = (id) => withReplyTrace(async () => {
      await Promise.resolve();
      appendLlmCall({ stage: 'reply', model: 'mock', promptTokens: id, completionTokens: 1 });
      setMemoryHits([{ id: `m${id}`, similarity: 1 }]);
      return activeReplyTrace();
    });
    const [a, b] = await Promise.all([run(10), run(20)]);
    expect(a.llmCalls[0].promptTokens).toBe(10);
    expect(b.llmCalls[0].promptTokens).toBe(20);
    expect(a.memoryHits[0].id).toBe('m10');
    expect(b.memoryHits[0].id).toBe('m20');
  });

  test('daily report warns when injected total exceeds budget', () => {
    const warn = vi.fn();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cost-'));
    const dir = path.join(root, 'traces');
    record({ ts: '2026-07-27T00:00:00Z', totalCostUsd: 99 }, { dir });
    record({ ts: '2026-07-26T00:00:00Z', llmCalls: [{ promptTokens: 10, completionTokens: 2 }] }, { dir });
    writeDailyCost('2026-07-27', { dir: root, warn });
    writeDailyCost('2026-07-27', { dir: root, warn });
    writeDailyCost('2026-07-26', { dir: root, warn });
    expect(warn).toHaveBeenCalledTimes(2);
    const rows = fs.readFileSync(path.join(root, 'cost-daily.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ day: '2026-07-26', calls: 1, tokens: 12 });
  });
});
