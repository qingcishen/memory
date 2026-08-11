import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function bareOrchestrator() {
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.ablation = {};
  orchestrator.now = () => NOW;
  orchestrator._emotionJournal = [];
  orchestrator._emotionResidue = {};
  orchestrator.stateLayer = { evolve: vi.fn(async () => null) };
  orchestrator.memory = { observe: vi.fn(async () => ({ stored: [] })) };
  orchestrator.relationship = { bump: vi.fn(async () => null) };
  orchestrator.world = null;
  orchestrator.history = [];
  return orchestrator;
}

describe('E-5 Orchestrator wiring', () => {
  it('exposes only a newly journaled turn event for memory projection', () => {
    const orchestrator = bareOrchestrator();

    const event = orchestrator.applyEmotionSideEffects(
      { label: '平静', intensity: 0.1 },
      { label: '生气', intensity: 0.82, cause: '冲突' },
      { userMessage: '你太过分了', source: 'turn' },
    );

    expect(event).toMatchObject({
      fromLabel: '平静',
      toLabel: '生气',
      intensity: 0.82,
      source: 'turn',
      at: NOW,
    });
    expect(orchestrator._pendingEmotionMemoryEvent).toEqual(event);
  });

  it('forwards the event, scene and stable eventId into Memory.observe', async () => {
    const orchestrator = bareOrchestrator();
    const emotionEvent = {
      toLabel: '期待',
      intensity: 0.8,
      cause: '终于见面',
      at: NOW,
    };

    await orchestrator.runAfterReply('终于见到了', '嗯，过来', {
      eventId: 'evt-emotion-main-path',
      sceneType: 'romantic',
      emotionLabel: '期待',
      emotionEvent,
    });

    expect(orchestrator.memory.observe).toHaveBeenCalledWith(
      [
        { role: 'user', content: '终于见到了' },
        { role: 'assistant', content: '嗯，过来' },
      ],
      expect.objectContaining({
        eventId: 'evt-emotion-main-path',
        sceneType: 'romantic',
        emotionLabel: '期待',
        emotionEvent,
        now: NOW,
      }),
    );
  });
});
