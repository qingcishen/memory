// 两阶段结构化计划 + 关系周记常驻槽 + assemble 槽位
import assert from 'node:assert';
import {
  planStructuredHeuristic,
  mergeStructured,
  applyStructuredToTurn,
  structuredPlanToPrompt,
} from '../src/orchestrator/structuredPlan.js';
import {
  synthesizeRelationshipNarrative,
  relationshipNarrativeToPrompt,
  isRelationshipNarrativeRow,
} from '../src/companion/relationshipNarrative.js';
import { buildSystemPrompt } from '../src/orchestrator/assemble.js';
import { detectNonSequitur, nonSequiturRepairHint } from '../src/companion/sceneCoherence.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('structuredPlan heuristic');
{
  const photo = planStructuredHeuristic({
    userMessage: '发张自拍看看你',
    sceneLocks: [],
    goals: [],
    behavior: { lengthHint: 'normal', partsBudget: 2 },
  });
  ok('要图 → wantPhoto', photo.wantPhoto === true);
  ok('要图 → photo action', photo.actions.some((a) => a.type === 'photo'));

  const intimate = planStructuredHeuristic({
    userMessage: '抱紧我',
    sceneLocks: [{ id: 'intimate' }],
    goals: [{ kind: 'story', text: '加班', priority: 0.9 }],
    behavior: { lengthHint: 'chatty', partsBudget: 3 },
    intimacyPhase: 'foreplay',
  });
  ok('亲密 → attitude intimate', intimate.attitude === 'intimate');
  ok('亲密 → 不硬塞故事', intimate.mentionStory === false);
  ok('亲密 → json', intimate.replyFormat === 'json');

  const conflict = planStructuredHeuristic({
    userMessage: '你怎么这样',
    sceneLocks: [{ id: 'conflict' }],
    goals: [],
    behavior: { lengthHint: 'terse', partsBudget: 1 },
  });
  ok('冲突 → guarded + 1 气泡', conflict.attitude === 'guarded' && conflict.bubbleCount === 1);

  const day = planStructuredHeuristic({
    userMessage: '你今天怎么样？',
    sceneLocks: [],
    goals: [],
    behavior: { lengthHint: 'normal', partsBudget: 2 },
    storyBeat: { content: '被拉去救火项目' },
  });
  ok('问近况+有 beat → mentionStory', day.mentionStory === true);
}

console.log('structuredPlan merge + apply');
{
  const base = planStructuredHeuristic({
    userMessage: '嗯',
    sceneLocks: [{ id: 'conflict' }],
    goals: [],
    behavior: { lengthHint: 'terse', partsBudget: 1 },
  });
  const merged = mergeStructured(base, {
    attitude: 'playful',
    lengthHint: 'chatty',
    bubbleCount: 3,
    note: '轻松点',
  });
  ok('冲突锁压住 chatty', merged.lengthHint === 'terse' && merged.bubbleCount === 1);
  ok('merge 带 source', merged.source === 'heuristic+llm');

  const turn = applyStructuredToTurn(
    { historyTurns: 6, useMonologue: true, recallQuery: 'x', partsBudget: 2, turnBrief: '【本轮简报】' },
    { ...merged, note: '先接住情绪' },
    { lengthHint: 'normal' },
  );
  ok('apply 写入 structured', turn.structured?.attitude);
  ok('apply 追加 brief', String(turn.turnBrief).includes('先接住情绪'));
  ok('prompt 段含本轮决策', structuredPlanToPrompt(merged).includes('【本轮决策】'));
}

console.log('relationship narrative');
{
  const text = synthesizeRelationshipNarrative({
    stage: { id: 'bonded', label: '深度绑定' },
    relationship: { closeness: 0.88, tension: 0.1, repair_debt: 0 },
    storyBeat: { content: '周姐又怼了她' },
    episodes: [{ content: '加班夜他等她回家' }],
  });
  ok('周记合成非空', text.length > 10);
  ok('周记含阶段', text.includes('深度绑定') || text.includes('bonded'));
  const prompt = relationshipNarrativeToPrompt(text);
  ok('prompt 带我们最近', prompt.includes('【我们最近】'));
  ok('识别周记行', isRelationshipNarrativeRow({ source: { kind: 'relationship_narrative' } }));
  ok('识别前缀行', isRelationshipNarrativeRow({ fact_core: '【关系周记】彼此很亲近' }));
}

console.log('assemble resident + structured slots');
{
  const sys = buildSystemPrompt({
    personaPrompt: '人设',
    relationshipNarrativePrompt: '【我们最近】彼此很亲近',
    userProfilePrompt: '【她眼中的你】他加班多',
    structuredPlanPrompt: '【本轮决策】态度倾向：warm',
    coherencePrompt: '【连贯性·硬规则】',
  });
  ok('关系周记进 system', sys.includes('我们最近'));
  ok('用户画像进 system', sys.includes('她眼中的你'));
  ok('结构化决策进 system', sys.includes('本轮决策'));
}

console.log('coherence retry defaults');
{
  ok('params 默认 coherenceRetry', PARAMS.orchestrator.coherenceRetry === true);
  ok('params 默认 structuredPlanLlm', PARAMS.orchestrator.structuredPlanLlm === true);
  ok('params 默认 residentSlots', PARAMS.orchestrator.residentSlots === true);
  ok('params 默认 sessionThread', PARAMS.orchestrator.sessionThread === true);
  const bad = detectNonSequitur('好舒服。明天上课别怪我', [{ id: 'intimate', forbidJump: /明天上课/, detect: /想要/ }]);
  ok('跳戏可检', bad.bad);
  const repair = nonSequiturRepairHint('好舒服明天上课', [{ id: 'intimate', forbidJump: /明天上课/, detect: /./ }]);
  ok('repair hint', repair.needsRetry);
}

console.log(`\nstructured-plan 全部 ${passed} 条断言通过 ✅`);
