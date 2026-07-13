// P0/P1 伴侣像人：场景连贯 / 关系阶段 / 篇章 / 主动 / 身体 / 出图门禁
import assert from 'node:assert';
import {
  detectSceneLocks,
  sceneCoherenceToPrompt,
  detectNonSequitur,
  extractUnfinishedHooks,
  nonSequiturRepairHint,
  STOCK_ENDINGS,
} from '../src/companion/sceneCoherence.js';
import {
  inferRelationshipStage,
  relationshipStageToPrompt,
  relationshipStageBehavior,
  applyStageToBehavior,
} from '../src/companion/relationshipStage.js';
import {
  buildEpisodeHeuristic,
  episodesToPrompt,
  synthesizeEpisodeChain,
  detectEpisodeTopics,
} from '../src/companion/episode.js';
import { buildProactiveContentPack, PROACTIVE_STYLE_GUIDE } from '../src/companion/proactiveContent.js';
import {
  inferBodySituation,
  bodyStateToPrompt,
  bodyIntimacyGate,
  applyBodyToBehavior,
  isLikelyPeriod,
} from '../src/companion/bodyState.js';
import { buildConversationGoals, goalsToPrompt } from '../src/orchestrator/goals.js';
import { buildSystemPrompt } from '../src/orchestrator/assemble.js';
import { buildUnifiedLookPrompt, buildSelfiePrompt, imageQualityGate } from '../src/appearance/selfie.js';
import { toStoryPrompt } from '../src/story/index.js';

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
  const prompt = sceneCoherenceToPrompt(locks, { topGoalText: '轻轻分享加班' });
  ok('连贯 prompt 含硬规则+库存结尾禁', prompt.includes('【连贯性·硬规则') && prompt.includes('禁止库存结尾'));
  ok('结尾服务意图注入', prompt.includes('结尾服务意图'));
  const bad = detectNonSequitur('好舒服…明天上课困了别怪我', locks);
  ok('亲密+上课硬拼被检出', bad.bad === true);
  ok('库存结尾正则', STOCK_ENDINGS.test('记得吃早饭啊'));
  const repair = nonSequiturRepairHint('好舒服明天上课', locks);
  ok('跳戏给出 retry hint', repair.needsRetry && repair.hint.includes('跳戏'));
  const car = detectSceneLocks('在车里弄我', [], null);
  ok('车内场景锁定', car.some((l) => l.id === 'car'));
  const travel = detectSceneLocks('我在杭州出差', [], null);
  ok('出行场景锁定', travel.some((l) => l.id === 'travel'));
  const hooks = extractUnfinishedHooks([
    { role: 'user', content: '周末你有空吗？' },
    { role: 'assistant', content: '看情况' },
    { role: 'user', content: '嗯' },
  ]);
  ok('抽出未完钩子', hooks.some((h) => h.text.includes('周末')));
}

console.log('relationshipStage behavior packs');
{
  ok('深度绑定', inferRelationshipStage({ closeness: 0.9, trust: 0.85, tension: 0.1, repair_debt: 0 }).id === 'bonded');
  ok('修复中优先于亲密', inferRelationshipStage({ closeness: 0.9, trust: 0.8, tension: 0.4, repair_debt: 0.4 }).id === 'repair');
  ok('紧绷', inferRelationshipStage({ closeness: 0.6, trust: 0.5, tension: 0.75, repair_debt: 0.1 }).id === 'tense');
  const tensePack = relationshipStageBehavior('tense');
  ok('冷战行为包 terse+延迟', tensePack.lengthHint === 'terse' && tensePack.delayFactor > 1);
  ok('冷战留可恢复路径', tensePack.recoveryPath.includes('缝'));
  const base = { replyDelayMs: [100, 500], partsBudget: 3, lengthHint: 'chatty', proactiveBias: 0.2 };
  const applied = applyStageToBehavior(base, { id: 'tense' });
  ok('阶段叠加压 chatty→terse', applied.lengthHint === 'terse');
  ok('阶段叠加 proactiveBias 更负', applied.proactiveBias < 0);
  const p = relationshipStageToPrompt(inferRelationshipStage({ closeness: 0.2, trust: 0.2 }), {});
  ok('初识剧本注入', p.includes('初识'));
  const repairP = relationshipStageToPrompt({ id: 'repair' }, { repair_debt: 0.4 });
  ok('修复剧本含可恢复', repairP.includes('可恢复') || repairP.includes('台阶'));
}

console.log('episode chain');
{
  const ep = buildEpisodeHeuristic([
    { role: 'user', content: '加班到好晚' },
    { role: 'assistant', content: '辛苦了，回来好好睡' },
    { role: 'user', content: '想你了' },
  ]);
  ok('篇章启发式产出', ep && ep.type === 'episode' && ep.topics.includes('工作'));
  ok('篇章含情绪基调', Boolean(ep.moodHint));
  ok('出行话题', detectEpisodeTopics('杭州出差酒店').includes('出行'));
  const ep2 = buildEpisodeHeuristic([
    { role: 'user', content: '杭州这边好冷' },
    { role: 'assistant', content: '多穿点，想你了' },
  ]);
  const chain = synthesizeEpisodeChain([ep, ep2], { label: '那周' });
  ok('合成篇章链', chain && chain.chain && chain.content.includes('【篇章链】'));
  ok('篇章链 prompt 连续读', episodesToPrompt([chain.content]).includes('关系故事'));
  ok('多条孤立→连续读', episodesToPrompt(['A篇章', 'B篇章']).includes('连续读'));
  ok('太短不产篇章', buildEpisodeHeuristic([{ role: 'user', content: 'hi' }]) === null);
}

console.log('proactiveContent + style');
{
  ok('克制美学指引存在', PROACTIVE_STYLE_GUIDE.includes('克制') && PROACTIVE_STYLE_GUIDE.includes('在吗'));
  const pack = buildProactiveContentPack({
    storyBeat: { title: '项目', content: '被拉去接新项目' },
    urgency: { urgent: true, need: 'sharing', tone: '想分享', score: 0.9 },
    outfit: { current: { summary: '黑色针织+阔腿裤' }, context: 'date' },
    unfinished: [{ text: '周末有空吗' }],
  });
  ok('主因优先 story', pack.primary.kind === 'story');
  ok('styleGuide 附带', pack.styleGuide.includes('克制'));
  ok('style 要求短', pack.style.includes('一两句'));
  const sickPack = buildProactiveContentPack({
    life: { sick_until: new Date(Date.now() + 86400000).toISOString() },
  });
  ok('病中内容源', sickPack.sources.some((s) => s.kind === 'sick'));
}

console.log('bodyState');
{
  const sit = inferBodySituation({ energy: 0.2, health: 0.4, sick_until: new Date(Date.now() + 1e6).toISOString() });
  ok('病中识别', sit.sick);
  ok('病中禁主动亲密', bodyIntimacyGate(sit).allowIntimateInit === false);
  ok('病中 prompt', bodyStateToPrompt(sit).includes('病中'));
  const aftercare = bodyStateToPrompt({}, { aftercare_need: 0.7 });
  ok('aftercare 余韵', aftercare.includes('余韵'));
  const period = isLikelyPeriod({ enabled: true, lastPeriodStart: new Date().toISOString().slice(0, 10), cycleLengthDays: 28, periodLengthDays: 5 });
  ok('经期窗口', period === true);
  const pol = applyBodyToBehavior({ replyDelayMs: [0, 200], partsBudget: 4, lengthHint: 'chatty', proactiveBias: 0.2 }, sit);
  ok('病中行为变 terse', pol.lengthHint === 'terse' && pol.partsBudget === 1);
}

console.log('goals · story force + outfit');
{
  const goals = buildConversationGoals({
    userMessage: '你今天过得怎么样？',
    storyBeat: { content: '被周姐拉去救火项目' },
    desires: { attention: 0, sharing: 0.2, comfort: 0, security: 0 },
  });
  ok('问近况时 story 高优先', goals.some((g) => g.kind === 'story' && g.priority >= 0.8));
  const outfitGoals = buildConversationGoals({
    userMessage: '今天穿什么？好看吗',
    outfit: { current: { summary: '奶油针织裙' }, context: 'date' },
    unfinished: [{ text: '周末有空吗' }],
    desires: { attention: 0, sharing: 0, comfort: 0, security: 0 },
  });
  ok('穿搭问句进目标', outfitGoals.some((g) => g.kind === 'outfit'));
  const gp = goalsToPrompt(goals);
  ok('意图星标+收尾服务', gp.includes('★') && gp.includes('收尾'));
}

console.log('story forceToday');
{
  const sp = toStoryPrompt(
    { lines: [{ title: '新项目', stage: 'rising', last_beat: '被拉去救火' }], today: { content: '周姐又怼了她' } },
    { cast: [{ name: '周姐' }], forceToday: true }
  );
  ok('今日必知', sp.includes('今天必知'));
  ok('配角固定', sp.includes('周姐'));
  ok('强制轻点生活', sp.includes('生活碎片'));
}

console.log('assemble · coherence slots');
{
  const sys = buildSystemPrompt({
    personaPrompt: '人设',
    coherencePrompt: '【连贯性·硬规则·本轮最高优先级】\n锁住亲密',
    relationshipStagePrompt: '【关系阶段·亲密恋人】',
    relationshipNarrativePrompt: '【我们最近】彼此很亲近',
    userProfilePrompt: '【她眼中的你】加班多',
    structuredPlanPrompt: '【本轮决策】态度：warm',
    episodePrompt: '【最近的关系篇章】\n- 加班夜',
  });
  ok('连贯段进 system', sys.includes('连贯性·硬规则'));
  ok('关系阶段进 system', sys.includes('关系阶段·亲密恋人'));
  ok('篇章进 system', sys.includes('最近的关系篇章'));
  ok('周记常驻槽进 system', sys.includes('我们最近'));
  ok('画像常驻槽进 system', sys.includes('她眼中的你'));
  ok('结构化决策进 system', sys.includes('本轮决策'));
}

console.log('unified selfie + quality gate');
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
  ok('统一管线含穿搭+脸锁', look.prompt.includes('真丝吊带') && /same woman|identity lock/i.test(look.prompt));
  ok('人妻感/成熟气质', /married-woman|mature elegant/i.test(look.prompt));
  ok('出图鞋履', /shoe|footwear|heel/i.test(look.prompt));
  ok('有外貌+脸锁过门禁', imageQualityGate({ prompt: look.prompt, appearance: '瓜子脸', kind: 'selfie' }).ok);
  ok('无锚拒绝出图', imageQualityGate({ prompt: 'a girl', appearance: '', kind: 'selfie', hasReferences: false }).ok === false);
  ok('buildSelfiePrompt 走统一管线', buildSelfiePrompt(snap, '瓜子脸杏眼').prompt.includes('真丝吊带'));
}

console.log(`\ncompanion-coherence 全部 ${passed} 条断言通过 ✅`);
