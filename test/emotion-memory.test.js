import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEmotionMemoryRecord,
  classifySafeEmotionCause,
  emotionMemoryValence,
  storeEmotionMemory,
  toEmotionMemoryRow,
} from '../src/state/emotionMemory.js';
import { normalizeMemory } from '../src/ontology.js';
import { resonateFromMemoryHits } from '../src/state/emotionResonance.js';

vi.mock('../src/extract.js', () => ({
  extractMemories: vi.fn(async () => []),
  applyMoodShiftBoost: vi.fn((memories) => memories),
}));

vi.mock('../src/store.js', () => ({
  storeMemories: vi.fn(async () => []),
}));

vi.mock('../src/state/affect.js', () => ({
  readState: vi.fn(async () => ({
    relationship: {
      closeness: 0.7,
      trust: 0.7,
      tension: 0,
      repair_debt: 0,
    },
  })),
  updateFromTurn: vi.fn(async () => ({
    before: null,
    after: null,
    desireDeltas: null,
  })),
  decayToBaseline: vi.fn(async () => null),
  moodLabel: vi.fn(() => '平静'),
  moodShiftMagnitude: vi.fn(() => 0),
  readStateHistory: vi.fn(async () => []),
}));

const { Memory } = await import('../src/memory.js');

describe('E-5 emotion memory pure contract', () => {
  it('only creates a record at intensity >= 0.7 and keeps the ontology type', () => {
    expect(
      buildEmotionMemoryRecord({
        emotionEvent: { label: '生气', intensity: 0.69 },
        eventId: 'evt-low',
      }),
    ).toBeNull();

    const record = buildEmotionMemoryRecord({
      emotionEvent: { label: '生气', intensity: 0.7 },
      eventId: 'evt-high',
    });
    expect(record).toMatchObject({
      type: 'emotion_event',
      emotion_label: '生气',
      affect_intensity: 0.7,
      subject_kind: 'dyad',
    });
    expect(normalizeMemory(record).type).toBe('emotion_event');
  });

  it('maps neutral, positive, and negative labels to the correct valence direction', () => {
    expect(emotionMemoryValence('平静')).toBe(0);
    expect(emotionMemoryValence('开心')).toBeGreaterThan(0);
    expect(emotionMemoryValence('生气')).toBeLessThan(0);
    expect(emotionMemoryValence('失落')).toBeLessThan(0);
  });

  it('never copies cause text and uses a stricter intimate-scene summary', () => {
    const explicit = '这段原始显式对话和私人细节绝不能被保存';
    const record = buildEmotionMemoryRecord({
      emotionEvent: {
        toLabel: '害羞',
        intensity: 0.9,
        cause: explicit,
        at: '2026-07-29T10:00:00.000Z',
      },
      eventId: 'evt-private',
      sceneType: 'intimate',
    });
    const row = toEmotionMemoryRow('u1', 'c1', record, [0.1, 0.2]);

    expect(record.cause_category).toBe('一次亲密互动');
    expect(JSON.stringify(record)).not.toContain(explicit);
    expect(JSON.stringify(row)).not.toContain(explicit);
    expect(row.source).toEqual({
      kind: 'emotion_event',
      version: 1,
      emotion_label: '害羞',
      cause_category: '一次亲密互动',
      idempotency_key: record.idempotency_key,
    });
  });

  it('reduces ordinary causes to controlled categories instead of excerpts', () => {
    const cause = '你三天不回我，我真的很难受，还有私人号码 123456';
    expect(classifySafeEmotionCause(cause)).toBe('一次被冷落的感受');
    expect(classifySafeEmotionCause(cause)).not.toContain('123456');
  });

  it('derives a stable idempotency key from eventId across retries', () => {
    const first = buildEmotionMemoryRecord({
      emotionEvent: { label: '开心', intensity: 0.8, cause: '第一次内容' },
      eventId: 'turn-event-42',
      now: 1,
    });
    const replay = buildEmotionMemoryRecord({
      emotionEvent: { label: '生气', intensity: 1, cause: '重放时内容发生变化' },
      eventId: 'turn-event-42',
      now: 999999,
    });
    const other = buildEmotionMemoryRecord({
      emotionEvent: { label: '开心', intensity: 0.8 },
      eventId: 'turn-event-43',
    });

    expect(replay.idempotency_key).toBe(first.idempotency_key);
    expect(other.idempotency_key).not.toBe(first.idempotency_key);
  });

  it('writes the event key as dedup_hash through an injectable offline store', async () => {
    const record = buildEmotionMemoryRecord({
      emotionEvent: { label: '感动', intensity: 0.85 },
      eventId: 'evt-insert',
    });
    const insertFn = vi.fn(async (row) => ({ id: 'm-emotion', ...row }));
    const stored = await storeEmotionMemory('u1', 'c1', record, {
      embedFn: vi.fn(async () => [0.1, 0.2]),
      insertFn,
    });

    expect(stored).toHaveLength(1);
    expect(insertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'emotion_event',
        dedup_hash: record.idempotency_key,
      }),
    );
  });
});

describe('E-5 Memory.observe integration', () => {
  let emotionMemoryStore;

  beforeEach(() => {
    emotionMemoryStore = vi.fn(async (_userId, _companionId, record) => [
      { id: 'm-emotion', ...record },
    ]);
  });

  it('stores one safe high-intensity event and reports the write result', async () => {
    const explicit = '原始用户私密正文不能落库';
    const memory = new Memory({
      userId: 'u1',
      companionId: 'c1',
      emotionMemoryStore,
    });

    const result = await memory.observe(
      [
        { role: 'user', content: explicit },
        { role: 'assistant', content: '回复正文也不应进入情绪事件记录' },
      ],
      {
        eventId: 'evt-observe',
        sceneType: 'intimate',
        emotionEvent: {
          label: '害羞',
          intensity: 0.82,
          cause: explicit,
        },
        prospective: false,
        knowledge: false,
        useLLM: false,
      },
    );

    expect(emotionMemoryStore).toHaveBeenCalledTimes(1);
    const record = emotionMemoryStore.mock.calls[0][2];
    expect(record).toMatchObject({
      type: 'emotion_event',
      emotion_label: '害羞',
      cause_category: '一次亲密互动',
    });
    expect(JSON.stringify(record)).not.toContain(explicit);
    expect(result.emotionMemory).toEqual({
      label: '害羞',
      stored: true,
      deduplicated: false,
      failed: false,
    });
    expect(result.stored).toEqual([
      expect.objectContaining({ id: 'm-emotion', type: 'emotion_event' }),
    ]);
  });

  it('does not call the writer for a low-intensity or missing event', async () => {
    const memory = new Memory({ userId: 'u1', emotionMemoryStore });

    const low = await memory.observe([], {
      eventId: 'evt-low',
      emotionEvent: { label: '失落', intensity: 0.69 },
      prospective: false,
      knowledge: false,
      useLLM: false,
    });
    const absent = await memory.observe([], {
      eventId: 'evt-absent',
      prospective: false,
      knowledge: false,
      useLLM: false,
    });

    expect(emotionMemoryStore).not.toHaveBeenCalled();
    expect(low.emotionMemory).toBeNull();
    expect(absent.emotionMemory).toBeNull();
  });
});

describe('E-5 emotion_event participates in emotion resonance', () => {
  it('pulls valence down for a recalled negative event', () => {
    const result = resonateFromMemoryHits(
      [
        {
          type: 'emotion_event',
          affect_valence: -0.8,
          affect_intensity: 0.9,
          source: { emotion_label: '生气' },
        },
      ],
      { valence: 0.2, warmth: 0.6 },
    );

    expect(result?.valenceDelta).toBeLessThan(0);
    expect(result?.reasons).toContain('情绪事件：生气');
  });

  it('can recover valence from the structured label when an old row lacks affect_valence', () => {
    const negative = resonateFromMemoryHits(
      [
        {
          type: 'emotion_event',
          affect_intensity: 0.8,
          source: { emotion_label: '失落' },
        },
      ],
      { valence: 0.1, warmth: 0.5 },
    );
    const positive = resonateFromMemoryHits(
      [
        {
          type: 'emotion_event',
          affect_intensity: 0.8,
          source: { emotion_label: '开心' },
        },
      ],
      { valence: 0, warmth: 0.5 },
    );

    expect(negative?.valenceDelta).toBeLessThan(0);
    expect(positive?.valenceDelta).toBeGreaterThan(0);
  });
});
