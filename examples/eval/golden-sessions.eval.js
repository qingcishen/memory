/**
 * 黄金会话评测 · ~20 段无 LLM 路径
 * 覆盖：结构化计划 / 场景锁 / 关系阶段 / 周记 / 画像槽 / 连贯检改 / 主动包 / 篇章
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConversationGoals, goalsToPrompt } from '../../src/orchestrator/goals.js';
import { inferEmotionLabel } from '../../src/state/emotionLabel.js';
import { behaviorPolicy, behaviorToPrompt } from '../../src/state/behavior.js';
import {
  detectSceneLocks,
  sceneCoherenceToPrompt,
  detectNonSequitur,
  nonSequiturRepairHint,
} from '../../src/companion/sceneCoherence.js';
import {
  inferRelationshipStage,
  relationshipStageToPrompt,
  applyStageToBehavior,
} from '../../src/companion/relationshipStage.js';
import { buildEpisodeHeuristic, synthesizeEpisodeChain } from '../../src/companion/episode.js';
import { buildProactiveContentPack, PROACTIVE_STYLE_GUIDE } from '../../src/companion/proactiveContent.js';
import { inferBodySituation, bodyIntimacyGate } from '../../src/companion/bodyState.js';
import { desireUrgency } from '../../src/orchestrator/scheduler.js';
import { buildSystemPrompt } from '../../src/orchestrator/assemble.js';
import {
  planStructuredHeuristic,
  applyStructuredToTurn,
  structuredPlanToPrompt,
} from '../../src/orchestrator/structuredPlan.js';
import {
  synthesizeRelationshipNarrative,
  relationshipNarrativeToPrompt,
} from '../../src/companion/relationshipNarrative.js';
import { planTurn } from '../../src/orchestrator/turnPlan.js';
import { formatUserProfilePrompt } from '../../src/profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-sessions.scenarios.json'), 'utf8'));

let failed = 0;
let passed = 0;

for (const s of scenarios) {
  const label = inferEmotionLabel(
    { mood: s.state?.mood, relationship: s.state?.relationship },
    s.state?.desires,
    s.turns || [],
  );
  let behavior = behaviorPolicy(label, { relationship: s.state?.relationship });
  const stage = inferRelationshipStage(s.state?.relationship || {});
  behavior = applyStageToBehavior(behavior, stage);
  const history = s.history || [];
  const lastUser = [...(s.turns || [])].reverse().find((t) => t.role === 'user')?.content || s.userMessage || '';
  const locks = detectSceneLocks(lastUser, history, s.state?.intimacy?.scene_phase);
  const bodySit = inferBodySituation(s.state?.life || {});
  const unfinished = s.unfinished || [];
  const goals = buildConversationGoals({
    dueItems: [],
    desires: s.state?.desires,
    storyBeat: s.storyBeat,
    intimacy: s.state?.intimacy,
    outfit: s.state?.outfit,
    userMessage: lastUser,
    unfinished,
    sceneLocks: locks,
  });
  const coherence = sceneCoherenceToPrompt(locks, {
    intimacyPhase: s.state?.intimacy?.scene_phase,
    topGoalText: goals[0]?.text,
  });
  const stagePrompt = relationshipStageToPrompt(stage, s.state?.relationship || {});

  const structured = planStructuredHeuristic({
    userMessage: lastUser,
    sceneLocks: locks,
    goals,
    behavior,
    storyBeat: s.storyBeat,
    unfinished,
    intimacyPhase: s.state?.intimacy?.scene_phase,
    bodySit,
  });
  let turn = planTurn({
    userMessage: lastUser,
    sceneLocks: locks,
    behavior,
    goals,
    intimacyPhase: s.state?.intimacy?.scene_phase,
    bodySit,
  });
  turn = applyStructuredToTurn(turn, structured, behavior);

  const narrative = synthesizeRelationshipNarrative({
    stage,
    relationship: s.state?.relationship,
    storyBeat: s.storyBeat,
    episodes: s.episodes || [],
  });
  const narrativePrompt = relationshipNarrativeToPrompt(s.relationshipNarrative || narrative);
  const profilePrompt = s.userProfile
    ? formatUserProfilePrompt(typeof s.userProfile === 'string' ? s.userProfile : s.userProfile)
    : '';

  const system = buildSystemPrompt({
    goalsPrompt: goalsToPrompt(goals),
    relationshipStagePrompt: stagePrompt,
    coherencePrompt: coherence,
    structuredPlanPrompt: structuredPlanToPrompt(structured),
    relationshipNarrativePrompt: narrativePrompt,
    userProfilePrompt: profilePrompt,
    turnBriefPrompt: turn.turnBrief || '',
  });

  const checks = [
    ['emotion label', typeof label === 'string' && label.length > 0],
    ['system has speech rules', system.includes('像真人说话')],
    ['structured plan exists', Boolean(structured?.attitude)],
    ['structured prompt injected', system.includes('【本轮决策】') || !lastUser],
  ];

  if (s.expect?.relationshipStage) {
    checks.push([`stage=${s.expect.relationshipStage}`, stage.id === s.expect.relationshipStage]);
  }
  if (s.expect?.sceneLock) {
    checks.push([`lock=${s.expect.sceneLock}`, locks.some((l) => l.id === s.expect.sceneLock)]);
  }
  if (s.expect?.structuredAttitude) {
    checks.push([
      `attitude=${s.expect.structuredAttitude}`,
      structured.attitude === s.expect.structuredAttitude,
    ]);
  }
  if (s.expect?.wantPhoto != null) {
    checks.push([`wantPhoto=${s.expect.wantPhoto}`, structured.wantPhoto === s.expect.wantPhoto]);
  }
  if (s.expect?.mentionStory != null) {
    checks.push([`mentionStory=${s.expect.mentionStory}`, structured.mentionStory === s.expect.mentionStory]);
  }
  if (s.expect?.replyFormat) {
    checks.push([`replyFormat=${s.expect.replyFormat}`, structured.replyFormat === s.expect.replyFormat]);
  }
  if (s.expect?.lengthHint) {
    checks.push([
      `lengthHint=${s.expect.lengthHint}`,
      structured.lengthHint === s.expect.lengthHint || behavior.lengthHint === s.expect.lengthHint,
    ]);
  }
  if (s.expect?.goalKind) {
    checks.push([`goal=${s.expect.goalKind}`, goals.some((g) => g.kind === s.expect.goalKind)]);
  }
  if (s.expect?.mustAvoidJump?.length) {
    const fake = detectNonSequitur(`嗯…${s.expect.mustAvoidJump[0]}，好舒服`, locks);
    checks.push(['non-sequitur flags jump', fake.bad === true || locks.length > 0]);
    const repair = nonSequiturRepairHint(`好舒服${s.expect.mustAvoidJump[0]}`, locks);
    checks.push(['repair hint available', repair.needsRetry === true || locks.length === 0]);
  }
  if (s.expect?.narrativeHas) {
    const blob = narrative + narrativePrompt;
    checks.push([
      'narrative contains',
      s.expect.narrativeHas.every((k) => blob.includes(k)),
    ]);
  }
  if (s.expect?.systemHas) {
    checks.push([
      'system has tokens',
      s.expect.systemHas.every((k) => system.includes(k)),
    ]);
  }
  if (s.expect?.episodeTopic) {
    const ep = buildEpisodeHeuristic([...(history || []), ...(s.turns || [])]);
    checks.push([
      `episode=${s.expect.episodeTopic}`,
      ep && Array.isArray(ep.topics) && ep.topics.includes(s.expect.episodeTopic),
    ]);
    if (ep) {
      checks.push(['episode chain', Boolean(synthesizeEpisodeChain([ep])?.content)]);
    }
  }
  if (s.expect?.proactivePrimary) {
    const pack = buildProactiveContentPack({
      urgency: desireUrgency(s.state?.desires),
      storyBeat: s.storyBeat,
    });
    checks.push([`proactive=${s.expect.proactivePrimary}`, pack.primary?.kind === s.expect.proactivePrimary]);
  }
  if (s.expect?.bodyGateBlocksIntimate) {
    checks.push(['body gate', bodyIntimacyGate(bodySit).allowIntimateInit === false]);
  }
  if (s.expect?.proactiveNotEmptyHi) {
    const pack = buildProactiveContentPack({
      urgency: desireUrgency(s.state?.desires),
      silenceTier: s.silenceTier,
      lifeActivity: s.state?.life?.current_activity,
      life: s.state?.life,
    });
    checks.push([
      'proactive not empty hi',
      pack.primary?.kind !== 'default' && !/^\s*在吗\s*$/.test(pack.reason),
    ]);
    checks.push(['style bans 在吗', PROACTIVE_STYLE_GUIDE.includes('在吗')]);
  }
  if (s.expect?.behaviorAvoidInternals) {
    const prompt = [behaviorToPrompt(behavior), goalsToPrompt(goals)].join('\n');
    checks.push(['no internals in behavior', !/系统|目标栈|story|mood_link/i.test(prompt)]);
  }

  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) {
    failed++;
    console.error(`✗ ${s.id}: ${bad.map(([n]) => n).join(', ')}`);
    console.error(
      `   stage=${stage.id} locks=${locks.map((l) => l.id).join(',') || '-'} attitude=${structured.attitude} goals=${goals.map((g) => g.kind).join(',')}`,
    );
  } else {
    passed++;
    console.log(
      `✓ ${s.id}: ${s.title} · ${label} · ${stage.id} · ${structured.attitude} · locks=${locks.map((l) => l.id).join(',') || '-'}`,
    );
  }
}

if (scenarios.length < 20) {
  console.error(`\n期望至少 20 段黄金会话，当前 ${scenarios.length}`);
  process.exit(1);
}

if (failed) {
  console.error(`\ngolden-sessions failed: ${failed}/${scenarios.length}`);
  process.exit(1);
}

console.log(`\ngolden-sessions passed: ${passed}/${scenarios.length} ✅`);
