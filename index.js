export { Memory } from './src/memory.js';
export { extractMemories, extractObservation } from './src/extract.js';
export { storeMemories } from './src/store.js';
export {
  retrieveMemories,
  retrieveSupersededTrail,
  buildSupersededTrail,
  formatForPrompt,
  formatSupersededTrailForPrompt,
} from './src/retrieve.js';
export { runReflection, findForgettable, mergeNearDuplicates } from './src/reflect.js';
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
export { currentActivity, isSleeping, ACTIVITY_TEMPLATES, parseSleepWindow } from './src/state/activity.js';
// L4 健康/生病闭环
export { isSick, maybeFallSick, detectCare, applyCare, isLateNight, updateLateNightStreak } from './src/state/health.js';
// 后台"活着"调度循环 (维护 + 主动性)
export { CompanionRuntime, isNightlyDue, localDayKey, localHour } from './src/runtime/index.js';
// 轻量监控
export { incr, get, metricsSnapshot, resetMetrics, recordLlmCall } from './src/metrics.js';
// 真实世界感知 · 天气
export { WeatherProvider, weatherCodeToZh, buildWeatherLine } from './src/world/weather.js';
// 世界观系统 · 动态世界状态 (背景剧情线/氛围随对话演变)
export {
  defaultWorldState,
  readWorldState,
  writeWorldState,
  toWorldPrompt,
  composeEvolveInput,
  WorldDimension,
} from './src/world/index.js';
// 旁白系统 · 按场景动态给旁白指令
export {
  SCENE_TYPES,
  NARRATION_DIRECTIVES,
  buildNarrationPrompt,
  parseSceneLabel,
  composeClassifyInput,
  SceneClassifier,
} from './src/narration.js';
// M9 每日训练 · 知识滴灌 + 自我日记
export { pickDailyKnowledge, buildDiaryPrompt, selfFactCores, dailyTraining } from './src/training.js';
// M5 扛量 · 持久化任务队列
export {
  enqueue,
  claimBatch,
  completeJob,
  failJob,
  queueStats,
  Worker,
  nextBackoffMs,
  decideAfterFailure,
  isClaimable,
} from './src/queue/jobs.js';
// A1 外貌/自拍 (骨架, 出图为仓库外基建)
export {
  MockImageProvider,
  HttpImageProvider,
  defaultImageProvider,
  shouldSendSelfie,
  canSendSelfie,
  buildSelfiePrompt,
  buildScenePrompt,
  decidePhoto,
  Selfie,
  readAppearanceAssets,
  insertAppearanceAsset,
  recentPhotoRateState,
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
  personaJsonToConfig,
  loadPersonaConfig,
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
  extractKnowledgeTriples,
  storeKnowledgeTriples,
  queryKnowledgeGraph,
  recallKnowledgeAsPrompt,
  entityKey,
  relationKey,
  normalizeTriple,
  normalizeTriples,
  expandNeighborhood,
  formatGraphPrompt,
} from './src/knowledge-graph/index.js';
export {
  Orchestrator,
  MemoryAdapter,
  StateLayerAdapter,
  RelationshipAdapter,
  PersonaAdapter,
  DefaultLLM,
  assemble,
  buildSystemPrompt,
  buildTimePrompt,
  buildGapHint,
  buildMonologueContext,
  formatRelationshipPrompt,
  LocalJsonHistoryStore,
  SupabaseHistoryStore,
  DEFAULT_PROACTIVE_POLICY,
  ProactiveScheduler,
  MemoryRateLimitStore,
  SupabaseRateLimitStore,
  canSendProactive,
  defaultRateLimitState,
  isQuietHour,
  markProactiveSent,
  normalizeRateLimitState,
  pickSilenceTier,
  pickBedtimeTier,
} from './src/orchestrator/index.js';
