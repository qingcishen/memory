// M4 纯逻辑测试: 共同记忆(dyad) / persona(self) 域隔离 / 关系叙事拼装。不连网。
// 验收 (见 docs/DEVELOPMENT.md M4):
//   - "我们一起…" 被当作 dyad 且能稳定作为关系底色挑出
//   - self(她对自己的设定) 与 user 域隔离, 检索"关于你"时不混进 self
import assert from 'node:assert';
import { filterBySubject, formatPersonaBlock } from '../src/persona.js';
import { pickDyadBackdrop, composeNarrativeInput } from '../src/narrative.js';
import { buildSupersededTrail, formatSupersededTrailForPrompt } from '../src/retrieve.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const mems = [
  { id: 'u1', subject_kind: 'user', fact_core: '诗雅讨厌香菜', importance: 5 },
  { id: 's1', subject_kind: 'self', fact_core: '我有点社恐', importance: 6 },
  { id: 's2', subject_kind: 'self', fact_core: '我爱吃甜的', importance: 4 },
  { id: 'd1', subject_kind: 'dyad', fact_core: '我们一起在西湖淋了雨', importance: 9, created_at: '2024-03-01' },
  { id: 'd2', subject_kind: 'dyad', fact_core: '我们第一次见面在咖啡馆', importance: 7, created_at: '2024-01-01' },
  { id: 'd3', subject_kind: 'dyad', fact_core: '一起看了场电影', importance: 9, created_at: '2024-05-01' },
];

console.log('filterBySubject (域隔离)');
{
  const userOnly = filterBySubject(mems, ['user', 'dyad']);
  ok('检索"关于你/我们"时剔除 self', userOnly.every((m) => m.subject_kind !== 'self'));
  ok('user 与 dyad 都保留', userOnly.some((m) => m.subject_kind === 'user') && userOnly.some((m) => m.subject_kind === 'dyad'));
  const selfOnly = filterBySubject(mems, 'self');
  ok('persona 域只取 self', selfOnly.length === 2 && selfOnly.every((m) => m.subject_kind === 'self'));
  ok('不传 subjects 时原样返回', filterBySubject(mems).length === mems.length);
}

console.log('pickDyadBackdrop (关系底色: 最重要的共同记忆)');
{
  const top1 = pickDyadBackdrop(mems, 1);
  ok('只挑 dyad', top1.length === 1 && top1[0].subject_kind === 'dyad');
  // d1 与 d3 同为 importance 9, 并列取更新近的 d3
  ok('重要性最高且并列取新近 (d3)', top1[0].id === 'd3');
  const top2 = pickDyadBackdrop(mems, 2);
  ok('取前 2 条按重要性/新近', top2.map((m) => m.id).join() === 'd3,d1');
  ok('user/self 不会被当作底色', pickDyadBackdrop(mems, 5).every((m) => m.subject_kind === 'dyad'));
}

console.log('formatPersonaBlock (人格注入块)');
{
  const block = formatPersonaBlock(filterBySubject(mems, 'self'), '诗雅');
  ok('包含 self 设定', block.includes('社恐') && block.includes('爱吃甜'));
  ok('不含 user 记忆', !block.includes('香菜'));
  ok('空 self 返回空串', formatPersonaBlock([], '诗雅') === '');
}

console.log('composeNarrativeInput (合成"我们的故事"的输入)');
{
  const input = composeNarrativeInput(pickDyadBackdrop(mems, 3), {
    relationship: { closeness: 0.8, tension: 0.1, trust: 0.7, repair_debt: 0 },
  });
  ok('含当前关系状态行', input.includes('亲密度 0.80'));
  ok('含共同经历事件', input.includes('西湖') && input.includes('咖啡馆'));
  const empty = composeNarrativeInput([], { relationship: {} });
  ok('无共同经历时给占位', empty.includes('还没有共同经历'));
}

console.log('buildSupersededTrail (显式翻旧账: 旧版本 → 当前版本)');
{
  const active = [{ id: 'm3', fact_core: '诗雅现在喜欢香菜', similarity: 0.9 }];
  const history = [
    { id: 'm2', fact_core: '诗雅觉得香菜还可以', superseded_by: 'm3', created_at: '2024-02-01' },
    { id: 'm1', fact_core: '诗雅讨厌香菜', superseded_by: 'm2', created_at: '2024-01-01' },
  ];
  const rows = buildSupersededTrail(active, history);
  ok('能沿 superseded_by 链找到所有旧版本', rows.length === 2);
  ok('每条旧版本都指向直接取代它的新版本', rows.some((r) => r.old.id === 'm1' && r.replacedBy.id === 'm2'));
  ok('每条旧版本都归到相关当前 anchor', rows.every((r) => r.anchor.id === 'm3'));

  const block = formatSupersededTrailForPrompt(rows, '诗雅');
  ok('历史 prompt 同时包含以前与后来', block.includes('以前:') && block.includes('后来更新为:'));
  ok('历史 prompt 保留旧偏好内容', block.includes('讨厌香菜') && block.includes('喜欢香菜'));
}

console.log(`\nM4 全部 ${passed} 条断言通过 ✅`);
