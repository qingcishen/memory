import { describe, expect, it } from 'vitest';
import { normalizeAblationFlags } from '../src/orchestrator/ablation.js';

describe('ablation flag compatibility', () => {
  const defaults = {
    narration: true,
    narrationPrompt: true,
    narrationClassifier: true,
  };

  it('maps the legacy narration flag to both split mechanisms', () => {
    expect(normalizeAblationFlags(defaults, { narration: false })).toMatchObject({
      narration: false,
      narrationPrompt: false,
      narrationClassifier: false,
    });
  });

  it('lets explicit split flags override the legacy compatibility mapping', () => {
    expect(
      normalizeAblationFlags(defaults, {
        narration: false,
        narrationPrompt: false,
        narrationClassifier: true,
      }),
    ).toMatchObject({
      narrationPrompt: false,
      narrationClassifier: true,
    });
  });

  it('can disable prompt injection while retaining scene classification', () => {
    expect(
      normalizeAblationFlags(defaults, { narrationPrompt: false }),
    ).toMatchObject({
      narrationPrompt: false,
      narrationClassifier: true,
    });
  });
});
