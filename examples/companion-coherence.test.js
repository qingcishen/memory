// P0/P1 伴侣像人：场景连贯 / 关系阶段 / 篇章 / 主动内容包 / 目标栈钩子
import assert from 'node:assert';
import {
  detectSceneLocks,
  sceneCoherenceToPrompt,
  detectNonSequitur,
  extractUnfinishedHooks,
  SCENE_LOCKS,
} from '../src/companion/sceneCoherence.js';
import { inferRelationshipStage, relationshipStageToPrompt } from '../src/companion/relationshipStage.js';
import { buildEpisodeHeuristic, episodesToPrompt } from '../src/companion/episode.js';
import { buildProactiveContentPack } from '../src/companion/proactiveContent.js';
import { buildConversationGoals, goalsToPrompt } from '../src/orchestrator/goals.js';
import { buildSystemPrompt } from '../src/orchestrator/assemble.js';
import { buildUnifiedLookPrompt, buildSelfiePrompt } from '../src/appearance/selfie.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('sceneCoherence');
{
  const locks = detectSceneLocks('想要你', [
    { role: 'user', content: '来，抱紧我' },
    { role: 'assistant', content: '嗯…' },
  ], 'foreplay');
  ok('亲密语境锁住 intimate', locks.some((l) => l.id === 'intimate'));
  const prompt = sceneCoherenceToPrompt(locks);
  ok('连贯 prompt 含硬规则', prompt.includes('【连贯性·硬规则') && prompt.includes('亲密'));
  const bad = detectNonSequitur('好舒服…明天上课困了别怪我', locks);
  ok('亲密+上课硬拼被检出', bad.bad === true);
  const car = detectSceneLocks('在车里弄我', [], null);
  ok('车内场景锁定', car.some((l) => l.id === 'car'));
  const hooks = extractUnfinishedHooks([
    { role: 'user', content: '周末你有空吗？' },
    { role: 'assistant', content: '看情况' },
    { role: 'user', content: '嗯' },
  ]);
  ok('抽出未完钩子', hooks.some((h) => h.text.includes('周末')));
}

console.log('relationshipStage');
{
  ok('深度绑定', inferRelationshipStage({ closeness: 0.9, trust: 0.85, tension: 0.1, repair_debt: 0 }).id === 'bonded');
  ok('修复中优先于亲密', inferRelationshipStage({ closeness: 0.9, trust: 0.8, tension: 0.4, repair_debt: 0.4 }).id === 'repair');
  ok('紧绷', inferRelationshipStage({ closeness: 0.6, trust: 0.5, tension: 0.75, repair_debt: 0.1 }).id === 'tense');
  const p = relationshipStageToPrompt(inferRelationshipStage({ closeness: 0.2, trust: 0.2 }), {});
  ok('初识剧本注入', p.includes('初识'));
}

console.log('episode');
{
  const ep = buildEpisodeHeuristic([
    { role: 'user', content: '加班到好晚' },
    { role: 'assistant', content: '辛苦了，回来好好睡' },
    { role: 'user', content: '想你了' },
  ]);
  ok('篇章启发式产出', ep && ep.type === 'episode' && ep.topics.includes('工作'));
  ok('篇章 prompt', episodesToPrompt([ep.content]).includes('【最近的关系篇章】'));
  ok('太短不产篇章', buildEpisodeHeuristic([{ role: 'user', content: 'hi' }]) === null);
}

console.log('proactiveContent pack');
{
  const pack = buildProactiveContentPack({
    storyBeat: { title: '项目', content: '被拉去接新项目' },
    urgency: { urgent: true, need: 'sharing', tone: '想分享', score: 0.9 },
    outfit: { current: { summary: '黑色针织+阔腿裤' }, context: 'date' },
    unfinished: [{ text: '周末有空吗' }],
  });
  ok('主因优先 story/分享', pack.primary.kind === 'story' || pack.primary.kind === 'desire');
  ok('reason 非空', pack.reason.length > 5);
  ok('有 query seed', Boolean(pack.query));
}

console.log('goals · unfinished + outfit');
{
  const goals = buildConversationGoals({
    userMessage: '今天穿什么？好看吗',
    outfit: { current: { summary: '奶油针织裙' }, context: 'date' },
    unfinished: [{ text: '周末有空吗' }],
    desires: { attention: 0, sharing: 0, comfort: 0, security: 0 },
  });
  ok('穿搭问句进目标', goals.some((g) => g.kind === 'outfit' && g.text.includes('奶油针织裙')));
  ok('未完钩子进目标', goals.some((g) => g.kind === 'unfinished'));
  const gp = goalsToPrompt(goals);
  ok('意图强调不压过连贯', gp.includes('场景连贯'));
}

console.log('assemble · coherence slots');
{
  const sys = buildSystemPrompt({
    personaPrompt: '人设',
    coherencePrompt: '【连贯性·硬规则·本轮最高优先级】\n锁住亲密',
    relationshipStagePrompt: '【关系阶段·亲密恋人】',
    episodePrompt: '【最近的关系篇章】\n- 加班夜',
  });
  ok('连贯段进 system', sys.includes('连贯性·硬规则'));
  ok('关系阶段进 system', sys.includes('关系阶段·亲密恋人'));
  ok('篇章进 system', sys.includes('最近的关系篇章'));
  ok('连贯在人设之后', sys.indexOf('人设') < sys.indexOf('连贯性'));
}

console.log('unified selfie look');
{
  const snap = {
    emotion: { valence: 0.5, warmth: 0.8 },
    life: { current_activity: '在家' },
    outfit: {
      current: {
        summary: '真丝吊带+开衫',
        pieces: { hair: '微卷长发', makeup: '水光唇' },
      },
      context: 'home',
    },
  };
  const look = buildUnifiedLookPrompt(snap, '瓜子脸杏眼', Date.now());
  ok('统一管线含外貌', look.prompt.includes('瓜子脸'));
  ok('统一管线含穿搭', look.prompt.includes('真丝吊带'));
  ok('统一管线含脸锁', look.prompt.includes('consistent face') || look.prompt.includes('same woman'));
  ok('tags 含 selfie+outfit', look.tags.includes('selfie') && look.tags.includes('outfit'));
  const legacy = buildSelfiePrompt(snap, '瓜子脸杏眼');
  ok('buildSelfiePrompt 走统一管线', legacy.prompt.includes('真丝吊带'));
}

console.log(`\ncompanion-coherence 全部 ${passed} 条断言通过 ✅`);
