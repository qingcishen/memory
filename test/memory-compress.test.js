import { describe, expect, it, vi } from 'vitest';
import { Memory } from '../src/memory.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import {
  clusterCompressionCandidates,
  compressEpisodeClusters,
  compressMemoryIfNeeded,
  shouldCompressMemoryHierarchy,
  shouldScheduleCompressionProbe,
} from '../src/memory/compress.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function memoryRow(id, daysAgo = 60, overrides = {}) {
  return {
    id,
    type: 'episode',
    fact_core: `记忆 ${id}`,
    content: `记忆 ${id}`,
    subject_kind: 'user',
    created_at: new Date(NOW - daysAgo * DAY).toISOString(),
    affect_valence: 0.2,
    affect_intensity: 0.4,
    importance: 4,
    ...overrides,
  };
}

describe('M-3 compression scheduling contract', () => {
  it('requires more than 200 active memories', () => {
    expect(
      shouldCompressMemoryHierarchy({
        activeCount: 200,
        now: NOW,
      }),
    ).toEqual({ due: false, reason: 'below_threshold' });
    expect(
      shouldCompressMemoryHierarchy({
        activeCount: 201,
        now: NOW,
      }),
    ).toEqual({ due: true, reason: 'eligible' });
  });

  it('enforces a full 24-hour cooldown after a successful compression', () => {
    const recent = shouldCompressMemoryHierarchy({
      activeCount: 300,
      lastCompressedAt: NOW - 23 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(recent.reason).toBe('cooldown');
    expect(recent.retryAfterMs).toBe(60 * 60 * 1000);
    expect(
      shouldCompressMemoryHierarchy({
        activeCount: 300,
        lastCompressedAt: NOW - DAY,
        now: NOW,
      }),
    ).toEqual({ due: true, reason: 'eligible' });
  });

  it('lets CEE probe only after 24h silence and at most once per hour', () => {
    expect(
      shouldScheduleCompressionProbe({
        now: NOW,
        lastInteractionAt: NOW - 23 * 60 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      shouldScheduleCompressionProbe({
        now: NOW,
        lastInteractionAt: NOW - DAY,
        lastProbeAt: null,
      }),
    ).toBe(true);
    expect(
      shouldScheduleCompressionProbe({
        now: NOW,
        lastInteractionAt: NOW - 2 * DAY,
        lastProbeAt: NOW - 59 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      shouldScheduleCompressionProbe({
        now: NOW,
        lastInteractionAt: NOW - 2 * DAY,
        lastProbeAt: NOW - 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it('keeps subjects and week windows in separate clusters', () => {
    const clusters = clusterCompressionCandidates([
      memoryRow('u1', 60),
      memoryRow('u2', 59),
      memoryRow('self', 60, { subject_kind: 'self' }),
      memoryRow('later', 40),
      { id: 'bad-time', created_at: 'invalid' },
    ]);
    expect(clusters.map((cluster) => cluster.map((row) => row.id))).toEqual(
      expect.arrayContaining([
        ['u1', 'u2'],
        ['self'],
        ['later'],
      ]),
    );
    expect(clusters.flat().some((row) => row.id === 'bad-time')).toBe(false);
  });

  it('does not invoke the compressor below threshold and runs once when due', async () => {
    const compress = vi.fn(async () => ({ compressed: 12, clusters: 2 }));
    await expect(
      compressMemoryIfNeeded('u1', 'c1', {
        now: NOW,
        inspect: async () => ({ activeCount: 180, lastCompressedAt: null }),
        compress,
      }),
    ).resolves.toMatchObject({
      ran: false,
      reason: 'below_threshold',
      compressed: 0,
    });
    expect(compress).not.toHaveBeenCalled();

    await expect(
      compressMemoryIfNeeded('u1', 'c1', {
        now: NOW,
        inspect: async () => ({
          activeCount: 300,
          lastCompressedAt: NOW - 2 * DAY,
        }),
        compress,
      }),
    ).resolves.toEqual({
      ran: true,
      reason: 'eligible',
      compressed: 12,
      clusters: 2,
    });
    expect(compress).toHaveBeenCalledTimes(1);
  });
});

describe('M-3 hierarchy write contract', () => {
  it('uses one atomic commit for a production cluster', async () => {
    const rows = [memoryRow('m1'), memoryRow('m2'), memoryRow('m3')];
    const commits = [];
    const result = await compressEpisodeClusters('u1', 'c1', {
      now: NOW,
      loadCandidates: async () => rows,
      summarize: async () => '原子摘要',
      embedFn: async () => null,
      commitCluster: async (record, sourceIds) => {
        commits.push({ record, sourceIds });
        return { id: 'summary-atomic', linkedCount: sourceIds.length };
      },
    });
    expect(result).toEqual({ compressed: 3, clusters: 1 });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      sourceIds: ['m1', 'm2', 'm3'],
      record: { type: 'reflection', fact_core: '原子摘要' },
    });
  });

  it('inserts one reflection and links old rows without deleting them', async () => {
    const rows = [
      memoryRow('m1'),
      memoryRow('m2'),
      memoryRow('m3'),
    ];
    const inserted = [];
    const linked = [];
    const result = await compressEpisodeClusters('u1', 'c1', {
      now: NOW,
      minCluster: 3,
      loadCandidates: async () => rows,
      summarize: async () => '那一周，我们一起处理了三件重要的事。',
      embedFn: async () => [0.1, 0.2],
      insertSummary: async (record) => {
        inserted.push(record);
        return { id: 'summary-1' };
      },
      linkCluster: async (ids, summaryId) => {
        linked.push({ ids, summaryId });
        return true;
      },
    });

    expect(result).toEqual({ compressed: 3, clusters: 1 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      type: 'reflection',
      subject_kind: 'user',
      fact_core: '那一周，我们一起处理了三件重要的事。',
      source: {
        kind: 'memory_compression',
        version: 1,
        source_ids: ['m1', 'm2', 'm3'],
      },
    });
    expect(inserted[0].dedup_hash).toBeTruthy();
    expect(linked).toEqual([
      { ids: ['m1', 'm2', 'm3'], summaryId: 'summary-1' },
    ]);
    // 压缩器没有 delete 协议；旧行只会由 linkCluster 标记 superseded_by。
    expect(rows).toHaveLength(3);
  });

  it('isolates one failed cluster and continues with the next', async () => {
    const firstWeek = [
      memoryRow('a1', 90),
      memoryRow('a2', 90),
      memoryRow('a3', 90),
    ];
    const secondWeek = [
      memoryRow('b1', 60),
      memoryRow('b2', 60),
      memoryRow('b3', 60),
    ];
    const summarize = vi.fn(async (cluster) => {
      if (cluster[0].id.startsWith('a')) throw new Error('model failed');
      return '第二组摘要';
    });
    const result = await compressEpisodeClusters('u1', 'c1', {
      now: NOW,
      loadCandidates: async () => [...firstWeek, ...secondWeek],
      summarize,
      embedFn: async () => null,
      insertSummary: async () => ({ id: 'summary-b' }),
      linkCluster: async () => true,
    });
    expect(result).toEqual({ compressed: 3, clusters: 1 });
    expect(summarize).toHaveBeenCalledTimes(2);
  });
});

describe('M-3 production facade wiring', () => {
  it('Memory isolates compressor failures', async () => {
    const result = await Memory.prototype.compressIfNeeded.call(
      {
        userId: 'u1',
        companionId: 'c1',
        memoryCompressor: async () => {
          throw new Error('database unavailable');
        },
      },
      { now: NOW },
    );
    expect(result).toEqual({
      ran: false,
      reason: 'compression_failed',
      compressed: 0,
      clusters: 0,
    });
  });

  it('nightly maintenance schedules compression while ordinary maintenance does not', async () => {
    const compressIfNeeded = vi.fn(async () => ({
      ran: false,
      reason: 'below_threshold',
      compressed: 0,
      clusters: 0,
    }));
    const fake = {
      memory: {
        settle: vi.fn(async () => null),
        compressIfNeeded,
      },
      stateLayer: { tickActivity: vi.fn(async () => null) },
      story: null,
      synthesizeEpisodesNightly: vi.fn(async () => null),
      refreshRelationshipNarrativeNightly: vi.fn(async () => null),
      loadResidentSlots: vi.fn(async () => null),
    };

    await Orchestrator.prototype.maintain.call(fake, {
      now: NOW,
      nightly: false,
    });
    expect(compressIfNeeded).not.toHaveBeenCalled();

    await Orchestrator.prototype.maintain.call(fake, {
      now: NOW,
      nightly: true,
    });
    expect(compressIfNeeded).toHaveBeenCalledWith({ now: NOW });
  });
});
