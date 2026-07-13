// StateLayer · 统一状态层门面。
//
// 编排器只对接这里: snapshot/toPrompt/samplingHints/evolve。
// 内部维度目前包含:
//   - emotion: { valence, warmth }
//   - life:    { energy, ... }
//   - desires
//   - intimacy (I 线)

import { readState, decayState, emotionDecayOverridesFromConfig } from './affect.js';
import { moodToEmotion, toEmotionPrompt, fuseEmotionPrompt } from '../emotion.js';
import { emotionLabelToPrompt } from './emotionLabel.js';
import { LifeDimension, toLifePrompt, lifeSamplingHints } from './life.js';
import { DesireDimension, toDesirePrompt } from './desire.js';
import { IntimacyDimension, toIntimacyPrompt, defaultIntimacy } from './intimacy.js';
import { OutfitDimension, toOutfitPrompt, defaultOutfitState } from './outfit.js';
import { PARAMS } from '../params.js';

const HOUR = 1000 * 60 * 60;

export class StateLayer {
  constructor({
    userId,
    companionId = 'default',
    read = readState,
    life = null,
    desire = null,
    intimacy = null,
    outfit = null,
    now = () => Date.now(),
    activityFn,
    lifeConfig,
    desireConfig,
    intimacyConfig,
    intimacyBaseline = null,
    intimacyHardBoundaries = null,
    intimacyKnowledge = null,
    outfitWardrobe = null,
    outfitConfig = null,
    emotionDecayOverrides = null,
  } = {}) {
    this.userId = userId;
    this.companionId = companionId;
    this.read = read;
    this.now = now;
    this.emotionDecayOverrides = emotionDecayOverrides;
    this.life = life ?? new LifeDimension({ userId, companionId, now, ...(activityFn ? { activityFn } : {}), ...(lifeConfig ? { lifeConfig } : {}) });
    this.desire = desire ?? new DesireDimension({ userId, companionId, now, ...(desireConfig ? { config: desireConfig } : {}) });
    this.intimacy =
      intimacy ??
      new IntimacyDimension({
        userId,
        companionId,
        now,
        ...(intimacyConfig ? { config: intimacyConfig } : {}),
        baseline: intimacyBaseline,
        hardBoundaries: intimacyHardBoundaries,
        knowledge: intimacyKnowledge ?? intimacyConfig?.knowledge ?? null,
      });
    this.outfit =
      outfit ??
      new OutfitDimension({
        userId,
        companionId,
        now,
        wardrobe: outfitWardrobe,
        ...(outfitConfig ? { config: outfitConfig } : {}),
      });
  }

  async snapshot() {
    const [state, life, desires, intimacy] = await Promise.all([
      this.userId ? this.read(this.userId, this.companionId) : {},
      this.life.current(),
      this.desire.snapshot(),
      this.intimacy.snapshot().catch(() => defaultIntimacy()),
    ]);
    const hours = state.updated_at ? Math.max(0, (this.now() - new Date(state.updated_at).getTime()) / HOUR) : 0;
    const decayed = decayState(state, hours, this.emotionDecayOverrides);
    const outfit = await this.outfit.snapshot({ life, intimacy }).catch(() => defaultOutfitState());
    return {
      emotion: moodToEmotion(decayed),
      life,
      desires,
      intimacy,
      outfit,
      // 门控/prompt 需要完整 relationship（emotion 映射可能丢字段）
      relationship: decayed?.relationship ?? null,
    };
  }

  /** 人设加载后挂上半衰期/基线覆盖（可直接传 overrides 或 CompanionConfig） */
  setEmotionDecayOverrides(overridesOrConfig) {
    if (!overridesOrConfig) {
      this.emotionDecayOverrides = null;
      return;
    }
    if (
      overridesOrConfig.halfLifeHours ||
      overridesOrConfig.baseline ||
      overridesOrConfig.recoverBias != null ||
      overridesOrConfig.sensitivity != null
    ) {
      this.emotionDecayOverrides = overridesOrConfig;
      return;
    }
    this.emotionDecayOverrides = emotionDecayOverridesFromConfig(overridesOrConfig);
  }

  toPrompt(snapshot, ctx = {}) {
    if (!snapshot) return '';
    const intimacyCfg = ctx.intimacyConfig ?? this.intimacy?.config ?? PARAMS.intimacy;
    const intimacyCtx = {
      relationship: ctx.relationship ?? snapshot.relationship,
      life: snapshot.life,
      desires: snapshot.desires,
      hardBoundaries: ctx.hardBoundaries ?? this.intimacy?.hardBoundaries,
    };
    const emotionBlock =
      ctx.emotionLabel != null
        ? fuseEmotionPrompt(snapshot.emotion, ctx.emotionLabel, ctx.emotionResidual, emotionLabelToPrompt)
        : toEmotionPrompt(snapshot.emotion);
    return [
      emotionBlock,
      toLifePrompt(snapshot.life),
      toDesirePrompt(snapshot.desires),
      intimacyCfg?.enabled !== false ? toIntimacyPrompt(snapshot.intimacy, intimacyCtx, intimacyCfg) : '',
      PARAMS.outfit?.enabled !== false
        ? toOutfitPrompt(snapshot.outfit, { wardrobe: this.outfit?.wardrobe })
        : '',
    ]
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
