// StateLayer · 统一状态层门面。
//
// 编排器只对接这里: snapshot/toPrompt/samplingHints/evolve。
// 内部维度目前包含:
//   - emotion: { valence, warmth }
//   - life:    { energy }

import { readState, decayState } from './affect.js';
import { moodToEmotion, toEmotionPrompt } from '../emotion.js';
import { LifeDimension, toLifePrompt, lifeSamplingHints } from './life.js';
import { DesireDimension, toDesirePrompt } from './desire.js';

const HOUR = 1000 * 60 * 60;

export class StateLayer {
  constructor({ userId, companionId = 'default', read = readState, life = null, desire = null, now = () => Date.now(), activityFn, lifeConfig, desireConfig } = {}) {
    this.userId = userId;
    this.companionId = companionId;
    this.read = read;
    this.now = now;
    this.life = life ?? new LifeDimension({ userId, companionId, now, ...(activityFn ? { activityFn } : {}), ...(lifeConfig ? { lifeConfig } : {}) });
    this.desire = desire ?? new DesireDimension({ userId, companionId, now, ...(desireConfig ? { config: desireConfig } : {}) });
  }

  async snapshot() {
    const [state, life, desires] = await Promise.all([
      this.userId ? this.read(this.userId, this.companionId) : {},
      this.life.current(),
      this.desire.snapshot(),
    ]);
    const hours = state.updated_at ? Math.max(0, (this.now() - new Date(state.updated_at).getTime()) / HOUR) : 0;
    const decayed = decayState(state, hours);
    return {
      emotion: moodToEmotion(decayed),
      life,
      desires,
    };
  }

  toPrompt(snapshot) {
    if (!snapshot) return '';
    return [toEmotionPrompt(snapshot.emotion), toLifePrompt(snapshot.life), toDesirePrompt(snapshot.desires)]
      .filter((part) => part && part.trim())
      .join('\n\n');
  }

  samplingHints(snapshot) {
    return lifeSamplingHints(snapshot?.life);
  }

  async evolve(turns) {
    await Promise.all([this.life.evolve(turns), this.desire.evolve(turns)]);
  }
}
