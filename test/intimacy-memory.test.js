import { describe, expect, it, vi } from 'vitest';
import {
  INTIMATE_MEMORY_TYPE,
  buildIntimateMemoryRecord,
  detectIntimateMemoryTransition,
  filterIntimateMemories,
  prioritizeIntimateMemories,
  removeUnsafeIntimateEpisodes,
  storeIntimateMemory,
  toIntimateMemoryRow,
} from '../src/state/intimacyMemory.js';
import { pickDyadBackdrop, composeNarrativeInput } from '../src/narrative.js';
import { normalizeMemory } from '../src/ontology.js';
import { MemoryAdapter } from '../src/orchestrator/adapters.js';

describe('I-3 intimate memory pure contract', () => {
  it('records only an actual first transition into peak or aftercare', () => {
    expect(
      detectIntimateMemoryTransition(
        { scene_phase: 'foreplay' },
        { scene_phase: 'peak' },
      ),
    ).toEqual({ from: 'foreplay', to: 'peak' });
    expect(
      detectIntimateMemoryTransition(
        { scene_phase: 'peak' },
        { scene_phase: 'aftercare' },
      ),
    ).toEqual({ from: 'peak', to: 'aftercare' });
    expect(
      detectIntimateMemoryTransition(
        { scene_phase: 'peak' },
        { scene_phase: 'peak' },
      ),
    ).toBeNull();
    expect(
      detectIntimateMemoryTransition(
        { scene_phase: 'none' },
        { scene_phase: 'foreplay' },
      ),
    ).toBeNull();
  });

  it('builds a safe dyad payload without preserving explicit dialogue', () => {
    const explicitDialogue = '这段原始显式正文绝不能被保存';
    const record = buildIntimateMemoryRecord({
      before: { scene_phase: 'foreplay' },
      after: {
        scene_phase: 'peak',
        last_intimate_at: '2026-07-29T10:00:00.000Z',
      },
      eventId: `channel:${explicitDialogue}`,
      now: Date.parse('2026-07-29T10:00:00.000Z'),
      turns: [{ role: 'user', content: explicitDialogue }],
    });

    expect(record).toMatchObject({
      type: INTIMATE_MEMORY_TYPE,
      subject_kind: 'dyad',
      importance: 5,
      transition: { from: 'foreplay', to: 'peak' },
    });
    expect(JSON.stringify(record)).not.toContain(explicitDialogue);
    expect(record.fact_core).toBe(record.content);
    expect(record.fact_core).not.toMatch(/[「」"]/u);

    const row = toIntimateMemoryRow('u1', 'c1', record, [0.1, 0.2]);
    expect(row.source).toEqual({
      kind: INTIMATE_MEMORY_TYPE,
      version: 1,
      transition: 'foreplay->peak',
      idempotency_key: record.idempotency_key,
    });
    expect(JSON.stringify(row)).not.toContain(explicitDialogue);
  });

  it('derives a stable per-event idempotency key', () => {
    const input = {
      before: { scene_phase: 'foreplay' },
      after: { scene_phase: 'peak', last_intimate_at: '2026-07-29T10:00:00.000Z' },
      now: Date.parse('2026-07-29T10:00:00.000Z'),
    };
    const first = buildIntimateMemoryRecord({ ...input, eventId: 'evt-1' });
    const replay = buildIntimateMemoryRecord({ ...input, eventId: 'evt-1' });
    const other = buildIntimateMemoryRecord({ ...input, eventId: 'evt-2' });

    expect(replay.idempotency_key).toBe(first.idempotency_key);
    expect(other.idempotency_key).not.toBe(first.idempotency_key);
  });

  it('supports injected IO while keeping the persisted row safe', async () => {
    const record = buildIntimateMemoryRecord({
      before: { scene_phase: 'peak' },
      after: { scene_phase: 'aftercare' },
      eventId: 'evt-aftercare',
    });
    const inserted = vi.fn(async (row) => ({ id: 'm-intimate', ...row }));
    const embedFn = vi.fn(async () => [0.3, 0.4]);

    const rows = await storeIntimateMemory('u1', 'c1', record, {
      embedFn,
      insertFn: inserted,
    });

    expect(embedFn).toHaveBeenCalledWith(record.fact_core);
    expect(inserted).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'm-intimate',
      type: INTIMATE_MEMORY_TYPE,
      subject_kind: 'dyad',
      dedup_hash: record.idempotency_key,
    });
  });

  it('keeps the new type intact through ontology normalization', () => {
    expect(
      normalizeMemory({
        type: INTIMATE_MEMORY_TYPE,
        fact_core: '安全摘要',
        subject_kind: 'dyad',
      }).type,
    ).toBe(INTIMATE_MEMORY_TYPE);
  });

  it('blocks ordinary dyad episodes from bypassing a safe transition record', () => {
    const intimateRecord = buildIntimateMemoryRecord({
      before: { scene_phase: 'foreplay' },
      after: { scene_phase: 'peak' },
      eventId: 'evt-safe',
    });
    const preference = {
      type: 'preference',
      subject_kind: 'user',
      fact_core: '稳定边界',
    };
    const unsafeEpisode = {
      type: 'episode',
      subject_kind: 'dyad',
      fact_core: '包含原始场景的里程碑',
    };
    expect(
      removeUnsafeIntimateEpisodes(
        [preference, unsafeEpisode],
        intimateRecord,
      ),
    ).toEqual([preference]);
    expect(
      removeUnsafeIntimateEpisodes([preference, unsafeEpisode], null),
    ).toEqual([preference, unsafeEpisode]);
  });
});

describe('I-3 intimate recall isolation', () => {
  const ordinary = { id: 'd1', type: 'episode', subject_kind: 'dyad', importance: 5 };
  const intimate = {
    id: 'i1',
    type: INTIMATE_MEMORY_TYPE,
    subject_kind: 'dyad',
    importance: 5,
  };

  it('filters intimate memories from daily and generic recall', () => {
    expect(filterIntimateMemories([ordinary, intimate], {})).toEqual([ordinary]);
    expect(
      filterIntimateMemories([ordinary, intimate], { sceneType: 'daily' }),
    ).toEqual([ordinary]);
    expect(
      filterIntimateMemories([ordinary, intimate], { sceneType: 'romantic' }),
    ).toEqual([ordinary]);
  });

  it('allows and prioritizes them only in an intimate context', () => {
    expect(
      prioritizeIntimateMemories(
        [ordinary, intimate],
        { sceneType: 'intimate' },
      ).map((memory) => memory.id),
    ).toEqual(['i1', 'd1']);
    expect(
      prioritizeIntimateMemories(
        [ordinary, intimate],
        { intimacyPhase: 'foreplay' },
      ).map((memory) => memory.id),
    ).toEqual(['i1', 'd1']);
  });

  it('excludes intimate memories from dyad backdrop and relationship narrative input', () => {
    expect(pickDyadBackdrop([intimate, ordinary], 2)).toEqual([ordinary]);
    const prompt = composeNarrativeInput(
      [
        { ...intimate, fact_core: '私密摘要不应进入故事' },
        { ...ordinary, fact_core: '一起看过电影' },
      ],
      { relationship: {} },
    );
    expect(prompt).not.toContain('私密摘要');
    expect(prompt).toContain('一起看过电影');
  });
});

describe('MemoryAdapter.observe contract', () => {
  it('returns the Memory result and forwards caller opts with subsystem defaults', async () => {
    const adapter = new MemoryAdapter({ userId: 'u1' });
    const observe = vi.fn(async (_turns, opts) => ({ ok: true, opts }));
    adapter._mem = { observe };
    adapter._life = { id: 'life' };
    adapter._desire = { id: 'desire' };
    adapter._intimacy = { id: 'intimacy' };
    adapter._outfit = { id: 'outfit' };
    adapter.setSceneType('intimate');

    const result = await adapter.observe(
      [{ role: 'user', content: 'hello' }],
      { eventId: 'evt-1', now: 123, useLLM: false },
    );

    expect(result.ok).toBe(true);
    expect(observe).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hello' }],
      expect.objectContaining({
        eventId: 'evt-1',
        now: 123,
        useLLM: false,
        sceneType: 'intimate',
        life: adapter._life,
        desire: adapter._desire,
        intimacy: adapter._intimacy,
        outfit: adapter._outfit,
      }),
    );
  });

  it('does not persist heuristic relationship episodes that contain intimate dialogue', async () => {
    const adapter = new MemoryAdapter({ userId: 'u1' });
    await expect(
      adapter.recordEpisode({
        type: 'episode',
        subject_kind: 'dyad',
        topics: ['亲密'],
        content: '对方提到：原始显式正文',
      }),
    ).resolves.toEqual([]);
  });
});
