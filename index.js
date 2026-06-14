export { Memory } from './src/memory.js';
export { extractMemories } from './src/extract.js';
export { storeMemories } from './src/store.js';
export {
  retrieveMemories,
  retrieveSupersededTrail,
  buildSupersededTrail,
  formatForPrompt,
  formatSupersededTrailForPrompt,
} from './src/retrieve.js';
export { runReflection, findForgettable } from './src/reflect.js';
export { embed, embedMany } from './src/embeddings.js';
export {
  rerank,
  recencyScore,
  memoryStrength,
  effectiveDecay,
  hoursSince,
} from './src/decay.js';
export { PARAMS } from './src/config.js';
export {
  normalizeMemory,
  applyAffectUpdate,
  assertFactCorePreserved,
  SUBJECT_KINDS,
  MEMORY_TYPES,
} from './src/ontology.js';
export {
  defaultState,
  clampState,
  decayState,
  applyDeltas,
  inferHeuristicDeltas,
  moodLabel,
  stateDelta,
  labelStateEvent,
  detectTensionTarget,
  summarizeTrajectory,
  formatTrajectory,
  readState,
  writeState,
  updateFromTurn,
  decayToBaseline,
  appendStateHistory,
  readStateHistory,
} from './src/state/affect.js';
export {
  defaultEmotion,
  clampEmotion,
  moodToEmotion,
  toEmotionPrompt,
} from './src/emotion.js';
// L3 生活模拟 (作息活动)
export { currentActivity, isSleeping, ACTIVITY_TEMPLATES } from './src/state/activity.js';
// L4 健康/生病闭环
export { isSick, maybeFallSick, detectCare, applyCare } from './src/state/health.js';
// A1 外貌/自拍 (骨架, 出图为仓库外基建)
export {
  MockImageProvider,
  HttpImageProvider,
  defaultImageProvider,
  shouldSendSelfie,
  canSendSelfie,
  buildSelfiePrompt,
  Selfie,
  readAppearanceAssets,
  insertAppearanceAsset,
} from './src/appearance/index.js';
export {
  rankCandidates,
  engineRecall,
  scoreActivation,
  VectorIndex,
  buildSimGraph,
  spreadActivation,
  attachSpread,
} from './src/engine/index.js';
export { baseLevel, moodCongruence, directedMoodCongruence, milestone, temporalPenalty } from './src/engine/activation.js';
export {
  reconsolidate,
  shouldRewriteNarrative,
  reconsolidateOnRecall,
  reconsolidateRecent,
  persistReconsolidation,
  anchorTarget,
  clampToOrigin,
  driftFromOrigin,
} from './src/memory/reconsolidate.js';
export { filterBySubject, formatPersonaBlock, seedPersona, personaBlock } from './src/persona.js';
export {
  CompanionConfigSchema,
  normalizeCompanionConfig,
  safeCompanionConfig,
  rowToConfig,
  configToRow,
  upsertCompanion,
  getCompanion,
  listCompanions,
} from './src/companion.js';
export { pickDyadBackdrop, composeNarrativeInput, dyadBackdrop, synthesizeNarrative } from './src/narrative.js';
export {
  relativeTriggerAt,
  detectProspective,
  isDue,
  isExpired,
  scheduleProspective,
  scheduleFromTurns,
  dueProspectives,
  markFired,
} from './src/memory/prospective.js';
export {
  buildImageMemory,
  captionImage,
  ingestImage,
  prosodyToAffect,
  buildAudioMemory,
  transcribeAudio,
  ingestAudio,
} from './src/modal/index.js';
export { normalizeForHash, dedupHash, findDuplicate } from './src/dedup.js';
export {
  Orchestrator,
  MemoryAdapter,
  StateLayerAdapter,
  RelationshipAdapter,
  PersonaAdapter,
  DefaultLLM,
  assemble,
  buildSystemPrompt,
  buildMonologueContext,
  formatRelationshipPrompt,
  DEFAULT_PROACTIVE_POLICY,
  ProactiveScheduler,
  MemoryRateLimitStore,
  SupabaseRateLimitStore,
  canSendProactive,
  defaultRateLimitState,
  isQuietHour,
  markProactiveSent,
  normalizeRateLimitState,
} from './src/orchestrator/index.js';
