// P2 工程债 #11 纯逻辑测试: 端到端场景回归。不连网。
// 之前都是单模块单测; 这里串成一条"N 轮对话 → 状态轨迹 → 召回质量"的回归:
//   1) 5 轮对话(吵架→和好→升温)用启发式状态机推演出真实轨迹 (M1)
//   2) 轨迹里"要紧的一轮"按情绪位移给当轮记忆 importance 加成 (emotion-design.md §8)
//   3) 同一份候选记忆池, 在轨迹的"受伤态"与"升温后"两个时间点分别 recall,
//      引擎路径 (M2 心情门控) 的召回集合随轨迹漂移, 旧路径 (rerank, 不感知心情) 不漂移
//      —— 把 docs 里"可切换双轨"落成一条实际断言。
//   4) 同话题但情绪相反的两条记忆 → 召回时被标记 _lowConfidence (#4), 注入文案改口"我记得好像"。
import assert from 'node:assert';
import {
  defaultState,
  applyDeltas,
  decayState,
  inferHeuristicDeltas,
  stateDelta,
  labelStateEvent,
  moodShiftMagnitude,
  summarizeTrajectory,
  formatTrajectory,
  moodLabel,
} from '../src/state/affect.js';
import { rankCandidates } from '../src/engine/index.js';
import { rerank } from '../src/decay.js';
import { attachConfidence } from '../src/confidence.js';
import { formatForPrompt } from '../src/retrieve.js';
import { applyMoodShiftBoost } from '../src/extract.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const now = Date.now();
const DAY = 1000 * 60 * 60 * 24;
const iso = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();

console.log('场景 1: 5 轮对话 → 状态轨迹 (吵架 → 和好 → 升温)');
const turns = [
  '你怎么又忘了我们的纪念日, 我真的很失望很难过',
  '你都不在乎我的感受, 我现在很生气, 不想理你',
  '对不起, 我错了, 以后一定记得, 抱抱好不好',
  '谢谢你, 我现在很开心, 真的很喜欢你',
  '今天和你在一起真的很幸福, 我爱你',
];

let state = defaultState();
const labels = [];
const history = [];
let turn1 = null; // 留给场景 2
let stateAfterConflict = null; // 留给场景 3
let happyState = null; // 留给场景 3

for (let i = 0; i < turns.length; i++) {
  const before = decayState(state, 0); // 同一次会话, 不经过时间
  const deltas = inferHeuristicDeltas([{ role: 'user', content: turns[i] }]);
  const after = applyDeltas(before, deltas);
  const event = labelStateEvent(before, after);
  labels.push(event);
  if (stateDelta(before, after) >= PARAMS.state.snapshotMinDelta) {
    history.push({ ...after, created_at: iso(turns.length - i), event });
  }
  if (i === 0) turn1 = { before, after };
  state = after;
  if (i === 1) stateAfterConflict = state;
}
happyState = state; // 第 5 轮后

ok('第 1/2 轮被识别为"吵架"', labels[0] === '吵架' && labels[1] === '吵架');
ok('第 3 轮被识别为"和好"', labels[2] === '和好');
ok('第 4/5 轮被识别为"开心"', labels[3] === '开心' && labels[4] === '开心');
ok('吵架后心情判定为受伤/闹脾气', moodLabel(stateAfterConflict) === '受伤/闹脾气');
ok('5 轮过后心情比受伤态回暖 (从负转正)', happyState.mood.valence > 0 && stateAfterConflict.mood.valence < 0);

const summary = summarizeTrajectory(history);
ok('轨迹记录到至少一次和好', summary.repairs >= 1);
ok('关系越走越亲近 (closeness 趋势上升)', summary.closenessTrend === 'rising');
const trajectoryText = formatTrajectory(summary);
ok('轨迹叙述里包含"和好"', trajectoryText.includes('和好'));

console.log('场景 2: 轨迹里"要紧的一轮" → 当轮记忆 importance 加成 (emotion-design.md §8)');
{
  const shift = moodShiftMagnitude(turn1.before, turn1.after);
  ok('第 1 轮心情位移超过加成阈值 (吵架是件大事)', shift > PARAMS.moodShiftImportanceBoost.threshold);
  const boosted = applyMoodShiftBoost([{ importance: 5 }], shift);
  ok('该轮提取的记忆 importance 被加成 (5 → 7)', boosted[0].importance === 7);
}

console.log('场景 3: 召回质量随轨迹漂移 + 引擎(M2) vs 旧路径(rerank/pgvector) 对照');
{
  const mk = (id, valence) => ({
    id,
    content: id,
    fact_core: id,
    similarity: 0.5,
    affect_valence: valence,
    affect_intensity: 0.8,
    emotion: 0.8,
    type: 'episode',
    subject_kind: 'user',
    importance: 5,
    embedding: [valence > 0 ? 0 : 1, valence > 0 ? 1 : 0, 0, 0],
    created_at: iso(2),
    last_accessed: iso(2),
    access_log: [now - 2 * DAY],
  });
  // 两条"吵架"记忆 (负向) + 两条"温馨"记忆 (正向), 语境相关度/新近度/重要性全部相同,
  // 唯一区别是情感正负 —— 这样旧路径 (rerank) 必然打平 (按原顺序), 引擎路径只看心情门控。
  const pool = [mk('fight1', -0.8), mk('fight2', -0.7), mk('joy1', 0.8), mk('joy2', 0.7)];

  const engineOpts = { now, params: { wSpread: 0 } }; // 关掉联想扩散, 只看心情门控
  const hurtTop2 = rankCandidates(pool, stateAfterConflict, engineOpts).slice(0, 2).map((m) => m.id).sort().join(',');
  const happyTop2 = rankCandidates(pool, happyState, engineOpts).slice(0, 2).map((m) => m.id).sort().join(',');
  const rerankTop2 = rerank(pool, now).slice(0, 2).map((m) => m.id).sort().join(',');

  ok('受伤态下引擎召回的 top2 是两条"吵架"记忆', hurtTop2 === 'fight1,fight2');
  ok('5 轮升温后引擎召回的 top2 变成两条"温馨"记忆', happyTop2 === 'joy1,joy2');
  ok('同一份候选池, 引擎召回集合随状态轨迹漂移', hurtTop2 !== happyTop2);
  ok('旧路径 (rerank) 不感知心情, 与受伤态引擎结果一致(平局按原顺序)', rerankTop2 === hurtTop2);
  ok('但旧路径不会随对话升温而切换召回集合, 与升温后引擎结果不同', rerankTop2 !== happyTop2);
}

console.log('场景 4: 同话题情绪相反的记忆 → _lowConfidence (#4), 注入文案改口"我记得好像"');
{
  const conflictPool = [
    {
      id: 'taste-bad',
      content: '诗雅讨厌香菜',
      fact_core: '诗雅讨厌香菜',
      similarity: 0.5,
      affect_valence: -0.7,
      affect_intensity: 0.8,
      emotion: 0.8,
      type: 'preference',
      subject_kind: 'user',
      importance: 5,
      embedding: [1, 0, 0, 0],
      created_at: iso(10),
      last_accessed: iso(2),
      access_log: [now - 2 * DAY],
    },
    {
      id: 'taste-good',
      content: '诗雅后来说还挺爱吃香菜的',
      fact_core: '诗雅后来说还挺爱吃香菜的',
      similarity: 0.5,
      affect_valence: 0.6,
      affect_intensity: 0.7,
      emotion: 0.7,
      type: 'preference',
      subject_kind: 'user',
      importance: 5,
      embedding: [0.99, 0.01, 0, 0],
      created_at: iso(1),
      last_accessed: iso(1),
      access_log: [now - 1 * DAY],
    },
    {
      id: 'unrelated',
      content: '诗雅在备考雅思',
      fact_core: '诗雅在备考雅思',
      similarity: 0.5,
      affect_valence: 0.1,
      affect_intensity: 0.2,
      emotion: 0.2,
      type: 'fact',
      subject_kind: 'user',
      importance: 5,
      embedding: [0, 0, 1, 0],
      created_at: iso(1),
      last_accessed: iso(1),
      access_log: [now - 1 * DAY],
    },
  ];

  const ranked = rankCandidates(conflictPool, happyState, { now, params: { wSpread: 0 } });
  const withConfidence = attachConfidence(ranked, { now });
  const byId = Object.fromEntries(withConfidence.map((m) => [m.id, m]));

  ok('"讨厌香菜" 与 "后来说爱吃" 互相冲突 → _lowConfidence', byId['taste-bad']._lowConfidence && byId['taste-good']._lowConfidence);
  ok('不相关的"在备考雅思" 不受影响', byId.unrelated._lowConfidence === false);

  const block = formatForPrompt(withConfidence, '诗雅');
  ok('冲突记忆在 prompt 里改口"我记得好像"', block.includes('我记得好像诗雅讨厌香菜') && block.includes('我记得好像诗雅后来说还挺爱吃香菜的'));
  ok('不冲突的记忆保持确定口吻', block.includes('- 诗雅在备考雅思'));
}

console.log(`\nScenario 全部 ${passed} 条断言通过 ✅`);
