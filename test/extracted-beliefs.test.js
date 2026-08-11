import { describe, expect, it, vi } from 'vitest';
import {
  normalizeStableExtractedBelief,
  parseMemoryExtraction,
} from '../src/extract.js';
import { toMemoryInsertRow } from '../src/store.js';
import { BeliefEngine } from '../src/belief/index.js';

function preferencePayload(overrides = {}) {
  return {
    type: 'preference',
    fact_core: '清词不喜欢香菜',
    narrative: null,
    subject_kind: 'user',
    importance: 6,
    fact_locked: false,
    affect: { valence: -0.4, intensity: 0.5 },
    belief: {
      subject: 'user',
      asserted_by: 'user',
      predicate: 'dislikes',
      object: '香菜',
      evidence_quote: '我一直不喜欢香菜',
    },
    ...overrides,
  };
}

describe('stable beliefs extracted with memory provenance', () => {
  it('accepts a whitelisted user preference backed by an exact quote', () => {
    const [memory] = parseMemoryExtraction(
      { memories: [preferencePayload()] },
      '清词',
      '小忆',
      {
        eventId: 'evt-pref',
        turns: [{ role: 'user', content: '我一直不喜欢香菜，味道受不了' }],
      },
    );

    expect(memory.source).toMatchObject({
      kind: 'conversation_extract',
      version: 1,
      speaker: 'user',
      eventId: 'evt-pref',
      beliefs: [{
        subject_key: 'user',
        subject_label: '清词',
        predicate: 'dislikes',
        object_value: '香菜',
        belief_kind: 'preference',
        epistemic_status: 'asserted',
        slot_key: 'user:preference:香菜',
      }],
    });
  });

  it('uses the same preference slot for a later opposite preference', () => {
    const memory = {
      type: 'preference',
      subject_kind: 'user',
      fact_locked: false,
    };
    const first = normalizeStableExtractedBelief(
      preferencePayload().belief,
      memory,
      { subjectName: '清词', userEvidence: ['我一直不喜欢香菜'] },
    );
    const second = normalizeStableExtractedBelief(
      { ...preferencePayload().belief, predicate: 'likes' },
      memory,
      { subjectName: '清词', userEvidence: ['我一直不喜欢香菜'] },
    );
    expect(first.slot_key).toBe('user:preference:香菜');
    expect(second.slot_key).toBe(first.slot_key);
    expect(second.belief_key).not.toBe(first.belief_key);
  });

  it('accepts locked identity facts and gives them a predicate slot', () => {
    const [memory] = parseMemoryExtraction(
      { memories: [{
        type: 'fact',
        fact_core: '清词的生日是3月1日',
        subject_kind: 'user',
        importance: 9,
        fact_locked: true,
        belief: {
          subject: 'user',
          asserted_by: 'user',
          predicate: 'birth_date',
          object: '3月1日',
          evidence_quote: '我的生日是3月1日',
        },
      }] },
      '清词',
      '小忆',
      { turns: [{ role: 'user', content: '我的生日是3月1日，记住啦' }] },
    );
    expect(memory.source.beliefs[0]).toMatchObject({
      belief_kind: 'identity',
      predicate: 'birth_date',
      slot_key: 'user:identity:birth_date',
    });
  });

  it.each([
    ['quote not in user message', preferencePayload({ belief: { ...preferencePayload().belief, evidence_quote: '模型编造的原话' } })],
    ['unsupported predicate', preferencePayload({ belief: { ...preferencePayload().belief, predicate: 'secret_score' } })],
    ['assistant attribution', preferencePayload({ belief: { ...preferencePayload().belief, asserted_by: 'assistant' } })],
    ['wrong memory subject', preferencePayload({ subject_kind: 'self' })],
  ])('keeps the memory but strips an unsafe belief: %s', (_name, raw) => {
    const [memory] = parseMemoryExtraction(
      { memories: [raw] },
      '清词',
      '小忆',
      { turns: [{ role: 'user', content: '我一直不喜欢香菜' }] },
    );
    expect(memory.fact_core).toBeTruthy();
    expect(memory.source).toBeUndefined();
  });

  it('does not create a parallel belief path for intimate extraction', () => {
    const [memory] = parseMemoryExtraction(
      { memories: [preferencePayload()] },
      '清词',
      '小忆',
      {
        intimate: true,
        turns: [{ role: 'user', content: '我一直不喜欢香菜' }],
      },
    );
    expect(memory.source).toBeUndefined();
  });

  it('persists only the sanitized source object in the memory insert row', () => {
    const source = {
      kind: 'conversation_extract',
      speaker: 'user',
      beliefs: [{ predicate: 'dislikes', object_value: '香菜' }],
    };
    const row = toMemoryInsertRow('u1', 'c1', {
      type: 'preference',
      fact_core: '清词不喜欢香菜',
      importance: 6,
      source,
    }, [0.1, 0.2]);
    expect(row.source).toBe(source);
    expect(toMemoryInsertRow('u1', 'c1', { fact_core: '普通记忆' }, []).source).toEqual({});
  });

  it('projects the stored memory id and event id as belief provenance', async () => {
    const project = vi.fn(async (...args) => ({ belief: args[2], created: true }));
    const engine = new BeliefEngine({
      userId: 'u1',
      companionId: 'c1',
      repository: { project },
    });
    const [memory] = parseMemoryExtraction(
      { memories: [preferencePayload()] },
      '清词',
      '小忆',
      {
        eventId: 'evt-pref',
        turns: [{ role: 'user', content: '我一直不喜欢香菜' }],
      },
    );
    await engine.projectMemory({
      ...memory,
      id: '11111111-1111-1111-1111-111111111111',
      created_at: '2026-08-11T12:00:00.000Z',
    });

    expect(project).toHaveBeenCalledWith(
      'u1',
      'c1',
      expect.objectContaining({ predicate: 'dislikes' }),
      expect.objectContaining({
        sourceKind: 'user',
        sourceId: 'evt-pref',
        sourceMemoryId: '11111111-1111-1111-1111-111111111111',
      }),
      {},
    );
  });
});
