// P1 工程债 #4 纯逻辑测试: 不确定性表达 (confidence)。不连网。
import assert from 'node:assert';
import { memoryConfidence, isLowConfidence, detectConflicts, attachConfidence } from '../src/confidence.js';
import { formatForPrompt } from '../src/retrieve.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const HOUR = 1000 * 60 * 60;
const now = Date.now();

console.log('memoryConfidence / isLowConfidence');
{
  const fresh = { similarity: 0.9, last_accessed: new Date(now).toISOString() };
  ok('相关度高且刚被想起 → 高置信', !isLowConfidence(memoryConfidence(fresh, { now })));

  const stale = { similarity: 0.1, last_accessed: new Date(now - 1000 * 24 * HOUR).toISOString() };
  ok('相关度低且很久没被想起 → 低置信', isLowConfidence(memoryConfidence(stale, { now })));

  const noMeta = { id: 'dyad-1' }; // dyadBackdrop 不带 similarity/last_accessed
  const score = memoryConfidence(noMeta, { now });
  ok('缺少 similarity/last_accessed (如 dyad backdrop) 时不主动判定低置信', !isLowConfidence(score));
  ok('缺数据时给中性分数', Math.abs(score - 0.75) < 1e-9);

  const moderate = { similarity: 0.6, last_accessed: new Date(now).toISOString() };
  const plain = memoryConfidence(moderate, { now });
  const conflicted = memoryConfidence(moderate, { now, conflicted: true });
  ok('冲突会扣分', conflicted < plain);
  ok('冲突扣分够大时可把中等置信拉到低置信线下', !isLowConfidence(plain) && isLowConfidence(conflicted));
}

console.log('detectConflicts (同话题但情绪相反)');
{
  const sameTopicOpposite = [
    { id: 'a', embedding: [1, 0, 0], affect_valence: 0.8 },
    { id: 'b', embedding: [1, 0, 0], affect_valence: -0.8 },
  ];
  const c1 = detectConflicts(sameTopicOpposite);
  ok('同话题+情绪相反 → 两条都被标记冲突', c1.has('a') && c1.has('b'));

  const sameTopicSameSide = [
    { id: 'a', embedding: [1, 0, 0], affect_valence: 0.8 },
    { id: 'b', embedding: [1, 0, 0], affect_valence: 0.6 },
  ];
  ok('同话题但情绪同向 → 不算冲突', detectConflicts(sameTopicSameSide).size === 0);

  const differentTopic = [
    { id: 'a', embedding: [1, 0, 0], affect_valence: 0.8 },
    { id: 'c', embedding: [0, 1, 0], affect_valence: -0.8 },
  ];
  ok('不同话题即使情绪相反也不算冲突', detectConflicts(differentTopic).size === 0);

  const gapTooSmall = [
    { id: 'a', embedding: [1, 0, 0], affect_valence: 0.3 },
    { id: 'b', embedding: [1, 0, 0], affect_valence: -0.1 },
  ];
  ok('情绪差值不够大 → 不算冲突', detectConflicts(gapTooSmall).size === 0);

  const stringEmbeddings = [
    { id: 'a', embedding: '[1,0,0]', affect_valence: 0.8 },
    { id: 'b', embedding: '[1,0,0]', affect_valence: -0.8 },
  ];
  ok('pgvector 字符串形式的 embedding 也能判冲突', detectConflicts(stringEmbeddings).has('a'));

  ok('空输入返回空 Set', detectConflicts([]).size === 0);
}

console.log('attachConfidence (附 _confidence / _lowConfidence)');
{
  const fresh = new Date(now).toISOString();
  const candidates = [
    { id: 'a', embedding: [1, 0, 0], affect_valence: 0.8, similarity: 0.6, last_accessed: fresh },
    { id: 'b', embedding: [1, 0, 0], affect_valence: -0.8, similarity: 0.6, last_accessed: fresh },
    { id: 'c', embedding: [0, 1, 0], affect_valence: 0.5, similarity: 0.6, last_accessed: fresh },
  ];
  const out = attachConfidence(candidates, { now });
  const byId = Object.fromEntries(out.map((m) => [m.id, m]));

  ok('冲突的两条被标记 _lowConfidence', byId.a._lowConfidence && byId.b._lowConfidence);
  ok('无冲突的一条不被标记', !byId.c._lowConfidence);
  ok('每条都带 _confidence 数值', out.every((m) => typeof m._confidence === 'number'));
}

console.log('formatForPrompt 接入 _lowConfidence');
{
  const high = { id: 'a', fact_core: '诗雅讨厌香菜', _lowConfidence: false };
  const low = { id: 'b', fact_core: '诗雅小时候学过钢琴', _lowConfidence: true };

  ok('高置信记忆正常表述', formatForPrompt([high]).includes('- 诗雅讨厌香菜'));
  ok('低置信记忆前缀"我记得好像"', formatForPrompt([low]).includes('- 我记得好像诗雅小时候学过钢琴'));
  ok('未标记 _lowConfidence 时按高置信处理', formatForPrompt([{ fact_core: '诗雅在备考' }]).includes('- 诗雅在备考'));
}

console.log('参数存在性');
{
  ok('PARAMS.confidence.lowThreshold 已定义', typeof PARAMS.confidence.lowThreshold === 'number');
  ok('PARAMS.confidence.conflict.similarityThreshold 已定义', typeof PARAMS.confidence.conflict.similarityThreshold === 'number');
}

console.log(`\nConfidence 全部 ${passed} 条断言通过 ✅`);
