// StateLayer · 统一状态层门面。
//
// 编排器只对接这里: snapshot/toPrompt/samplingHints/evolve。
// 内部维度目前包含:
//   - emotion: { valence, warmth }
//   - life:    { energy }

import { readState, decayState } from './affect.js';
import { moodToEmotion, toEmotionPrompt } from '../emotion.js';
import { moodToLife, toLifePrompt, lifeSamplingHints } from './life.js';

const HOUR = 1000 * 60 * 60;

export class StateLayer {
  constructor({ userId, read = readState, now = () => Date.now() } = {}) {
    this.userId = userId;
    this.read = read;
    this.now = now;
  }

  async snapshot() {
    const state = this.userId ? await this.read(this.userId) : {};
    const hours = state.updated_at ? Math.max(0, (this.now() - new Date(state.updated_at).getTime()) / HOUR) : 0;
    const decayed = decayState(state, hours);
    return {
      emotion: moodToEmotion(decayed),
      life: moodToLife(decayed),
    };
  }

  toPrompt(snapshot) {
    if (!snapshot) return '';
    return [toEmotionPrompt(snapshot.emotion), toLifePrompt(snapshot.life)]
      .filter((part) => part && part.trim())
      .join('\n\n');
  }

  samplingHints(snapshot) {
    return lifeSamplingHints(snapshot?.life);
  }

  async evolve() {}
}
