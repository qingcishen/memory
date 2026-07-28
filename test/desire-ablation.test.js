import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/index.js';

function deps(captured) {
  return {
    memory: {
      async recall() { return { block: '', hits: [] }; },
      async observe() {},
    },
    stateLayer: {
      async snapshot() {
        return {
          emotion: { valence: 0, warmth: 0.5 },
          relationship: { closeness: 0.5, tension: 0, trust: 0.5 },
          life: { energy: 0.7, health: 1 },
          desires: { attention: 0.95 },
          intimacy: { scene_phase: 'none' },
        };
      },
      async evolve() {},
      toPrompt(snapshot) {
        return snapshot?.desires ? 'UNIQUE_DESIRE_MARKER' : 'STATE_WITHOUT_DESIRE';
      },
      samplingHints() { return {}; },
    },
    relationship: {
      async current() { return { relationship: { closeness: 0.5, tension: 0, trust: 0.5 } }; },
      async bump() {},
      toPrompt() { return ''; },
    },
    persona: {
      async load() {},
      toPrompt() { return 'PERSONA'; },
    },
    llm: {
      async generateReply(messages) {
        captured.push(messages.map((message) => message.content).join('\n'));
        return '在呢';
      },
    },
  };
}

async function runWithAblation(ablation) {
  const captured = [];
  const orchestrator = new Orchestrator({
    userId: `desire-${JSON.stringify(ablation)}`,
    deps: deps(captured),
    options: { useMonologue: false, ablation },
  });
  await orchestrator.reply('在吗');
  return captured[0];
}

describe('desire ablation wiring', () => {
  it('removes desire only from the generated prompt', async () => {
    const prompt = await runWithAblation({
      desirePrompt: false,
      desireInference: true,
    });
    expect(prompt).not.toContain('UNIQUE_DESIRE_MARKER');
    expect(prompt).toContain('STATE_WITHOUT_DESIRE');
  });

  it('can disable desire inference while retaining prompt state', async () => {
    const prompt = await runWithAblation({
      desirePrompt: true,
      desireInference: false,
    });
    expect(prompt).toContain('UNIQUE_DESIRE_MARKER');
  });

  it('keeps legacy desire=false behavior for prompt removal', async () => {
    const prompt = await runWithAblation({ desire: false });
    expect(prompt).not.toContain('UNIQUE_DESIRE_MARKER');
  });
});
