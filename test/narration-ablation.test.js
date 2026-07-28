import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/orchestrator/index.js';

function deps({ captured, classifier }) {
  return {
    narration: classifier,
    memory: {
      async recall() { return { block: '', hits: [] }; },
      async observe() {},
    },
    stateLayer: {
      async snapshot() {
        return {
          emotion: { valence: 0, warmth: 0.6 },
          relationship: { closeness: 0.6, tension: 0, trust: 0.6 },
          life: { energy: 0.7, health: 1 },
          desires: {},
          intimacy: { scene_phase: 'none' },
        };
      },
      async evolve() {},
      toPrompt() { return 'STATE'; },
      samplingHints() { return {}; },
    },
    relationship: {
      async current() { return { relationship: { closeness: 0.6, tension: 0, trust: 0.6 } }; },
      async bump() {},
      toPrompt() { return 'RELATIONSHIP'; },
    },
    persona: {
      async load() {},
      toPrompt() { return 'PERSONA'; },
    },
    llm: {
      async generateReply(messages) {
        captured.push(messages.map((message) => message.content).join('\n'));
        return '好呀';
      },
    },
  };
}

describe('narration ablation wiring', () => {
  it('keeps classification active while removing narration prompt injection', async () => {
    const captured = [];
    const classifier = { classify: vi.fn(async () => 'romantic') };
    const orchestrator = new Orchestrator({
      userId: 'u1',
      config: {
        narrationDirectives: { romantic: 'UNIQUE_NARRATION_MARKER' },
      },
      deps: deps({ captured, classifier }),
      options: {
        useMonologue: false,
        ablation: {
          narrationPrompt: false,
          narrationClassifier: true,
        },
      },
    });

    await orchestrator.reply('靠近一点');
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(captured[0]).not.toContain('UNIQUE_NARRATION_MARKER');
  });

  it('injects narration prompt when both split mechanisms are enabled', async () => {
    const captured = [];
    const classifier = { classify: vi.fn(async () => 'romantic') };
    const orchestrator = new Orchestrator({
      userId: 'u2',
      config: {
        narrationDirectives: {
          romantic: 'UNIQUE_NARRATION_MARKER',
          flirting: 'UNIQUE_NARRATION_MARKER',
        },
      },
      deps: deps({ captured, classifier }),
      options: {
        useMonologue: false,
        ablation: {
          narrationPrompt: true,
          narrationClassifier: true,
        },
      },
    });

    await orchestrator.reply('靠近一点');
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(captured[0]).toContain('UNIQUE_NARRATION_MARKER');
  });

  it('can disable classification independently', async () => {
    const captured = [];
    const classifier = { classify: vi.fn(async () => 'romantic') };
    const orchestrator = new Orchestrator({
      userId: 'u3',
      deps: deps({ captured, classifier }),
      options: {
        useMonologue: false,
        ablation: {
          narrationPrompt: true,
          narrationClassifier: false,
        },
      },
    });

    await orchestrator.reply('普通聊天');
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
