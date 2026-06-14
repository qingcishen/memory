// M2 纯逻辑测试: 自研激活引擎 + 心情门控检索。不连网。
// 验收 (见 docs/DEVELOPMENT.md M2):
//   - 同一 query, "她开心" vs "她受伤" 两态下 recall 集合显著不同 (负向记忆在受伤态被点亮)
//   - 关闭门控 (wMood=0) 退化为标准激活
//   - 万级记忆 recall < 20ms
import assert from 'node:assert';
import {
  scoreActivation,
  baseLevel,
  moodCongruence,
  directedMoodCongruence,
  milestone,
  temporalPenalty,
} from '../src/engine/activation.js';
import { rankCandidates } from '../src/engine/index.js';
import { VectorIndex, cosine } from '../src/engine/vector-index.js';
import { buildSimGraph, spreadActivation, attachSpread } from '../src/engine/graph.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const now = Date.now();
const DAY = 1000 * 60 * 60 * 24;

console.log('baseLevel (ACT-R: 新近 + 频次)');
{
  const fresh = baseLevel({ access_log: [now - 1 * DAY] }, now);
  const old = baseLevel({ access_log: [now - 100 * DAY] }, now);
  ok('越新近 base-level 越高', fresh > old);
  const many = baseLevel({ access_log: [now - 1 * DAY, now - 2 * DAY, now - 3 * DAY] }, now);
  const few = baseLevel({ access_log: [now - 1 * DAY] }, now);
  ok('被反复唤起 base-level 更高', many > few);
  ok('空 log 退回 created/last_accessed 不报错', Number.isFinite(baseLevel({ created_at: new Date(now - DAY).toISOString() }, now)));
}

console.log('moodCongruence (招牌③ 心情门控)');
{
  const hurt = { mood: { valence: -0.7 } };
  const happy = { mood: { valence: 0.7 } };
  const negMem = { affect_valence: -0.8, affect_intensity: 0.9 };
  const posMem = { affect_valence: 0.8, affect_intensity: 0.9 };
  ok('受伤态点亮负面记忆 (congruence>0)', moodCongruence(negMem, hurt) > 0);
  ok('受伤态压低正面记忆 (congruence<0)', moodCongruence(posMem, hurt) < 0);
  ok('开心态点亮正面记忆', moodCongruence(posMem, happy) > 0);
  ok('弱情绪记忆受心情影响更小', Math.abs(moodCongruence({ affect_valence: -0.8, affect_intensity: 0.1 }, hurt)) < Math.abs(moodCongruence(negMem, hurt)));
}

console.log('milestone / temporalPenalty');
{
  ok('锁定硬事实 milestone=1', milestone({ fact_locked: true }) === 1);
  ok('dyad 共同记忆有里程碑分', milestone({ subject_kind: 'dyad', importance: 9 }) > 0);
  ok('普通 user 记忆 milestone=0', milestone({ subject_kind: 'user', type: 'fact' }) === 0);
  const oldEp = temporalPenalty({ type: 'episode', created_at: new Date(now - 90 * DAY).toISOString() }, now);
  const newEp = temporalPenalty({ type: 'episode', created_at: new Date(now - 1 * DAY).toISOString() }, now);
  ok('越老的情节过期降权越大', oldEp > newEp);
  ok('非情节不降权', temporalPenalty({ type: 'fact', created_at: new Date(now - 90 * DAY).toISOString() }, now) === 0);
}

console.log('cosine / VectorIndex / graph');
{
  ok('相同向量 cosine=1', Math.abs(cosine([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
  ok('正交向量 cosine=0', Math.abs(cosine([1, 0], [0, 1])) < 1e-9);

  const idx = new VectorIndex();
  idx.addAll([
    { id: 'a', embedding: [1, 0, 0] },
    { id: 'b', embedding: [0.9, 0.1, 0] },
    { id: 'c', embedding: [0, 0, 1] },
  ]);
  ok('索引 size 计数', idx.size === 3);
  const hits = idx.query([1, 0, 0], { k: 2 });
  ok('query 返回最相似的在前', hits[0].id === 'a' && hits[1].id === 'b' && hits.length === 2);

  // 扩散: a-b 强相连, c 孤立。以 a 为种子, b 应收到扩散, c 不应
  const items = [
    { id: 'a', embedding: [1, 0, 0], similarity: 1 },
    { id: 'b', embedding: [0.98, 0.2, 0], similarity: 0.3 },
    { id: 'c', embedding: [0, 0, 1], similarity: 0.1 },
  ];
  const adj = buildSimGraph(items, { k: 4, threshold: 0.6 });
  const spread = spreadActivation(adj, new Map([['a', 1]]), { hops: 2, decay: 0.5 });
  ok('相连节点 b 收到扩散', (spread.get('b') ?? 0) > 0);
  ok('孤立节点 c 不收到扩散', (spread.get('c') ?? 0) === 0);
  const withSpread = attachSpread(items, { k: 4, threshold: 0.6, seedCount: 1 });
  ok('attachSpread 给每条附 _spread', withSpread.every((m) => typeof m._spread === 'number'));
}

console.log('scoreActivation: 心情门控让 recall 集合随状态漂移 (核心验收)');
{
  // 同一批候选 (语境相似度相同), 区别只在情感正负
  const mk = (id, valence) => ({
    id,
    similarity: 0.5,
    affect_valence: valence,
    affect_intensity: 0.9,
    type: 'episode',
    subject_kind: 'user',
    importance: 5,
    access_log: [now - 5 * DAY],
    created_at: new Date(now - 5 * DAY).toISOString(),
  });
  const cands = [mk('pos1', 0.8), mk('pos2', 0.7), mk('neg1', -0.8), mk('neg2', -0.7)];

  const hurt = { mood: { valence: -0.8 } };
  const happy = { mood: { valence: 0.8 } };

  const inHurt = rankCandidates(cands, hurt, { now });
  const inHappy = rankCandidates(cands, happy, { now });

  const topHurt = inHurt.slice(0, 2).map((m) => m.id).sort();
  const topHappy = inHappy.slice(0, 2).map((m) => m.id).sort();
  ok('受伤态 top2 是负面记忆', topHurt.join() === 'neg1,neg2');
  ok('开心态 top2 是正面记忆', topHappy.join() === 'pos1,pos2');
  ok('两态 recall 集合显著不同', topHurt.join() !== topHappy.join());

  // 关闭门控 (wMood=0): 两态结果应一致 (退化标准激活)
  const offHurt = rankCandidates(cands, hurt, { now, params: { wMood: 0 } }).map((m) => m.id);
  const offHappy = rankCandidates(cands, happy, { now, params: { wMood: 0 } }).map((m) => m.id);
  ok('wMood=0 时两态顺序一致 (退化标准激活)', offHurt.join() === offHappy.join());
}

console.log('性能: 万级记忆 recall < 20ms');
{
  const DIM = 64; // 维度不影响相对量级, 用 64 维跑万条足以验证 brute-force 可行
  const idx = new VectorIndex();
  for (let i = 0; i < 10000; i++) {
    const vec = Array.from({ length: DIM }, () => Math.random());
    idx.add({ id: `m${i}`, embedding: vec, similarity: 0, affect_valence: Math.random() * 2 - 1, affect_intensity: 0.5, type: 'fact', importance: 5, access_log: [now - DAY] });
  }
  const q = Array.from({ length: DIM }, () => Math.random());
  const t0 = performance.now();
  const cand = idx.query(q, { k: 30 });
  const ranked = scoreActivation(cand, { mood: { valence: -0.5 } }, { now });
  const dt = performance.now() - t0;
  ok(`10k 条 query+激活耗时 ${dt.toFixed(1)}ms < 20ms`, dt < 20 && ranked.length === 30);
}

console.log('#5 定向心情门控 (directedMoodCongruence)');
{
  // 话题向量 = [1,0]; 两条负面记忆: 一条与话题同向(考试相关), 一条正交(与你吵架相关)
  const topicVec = [1, 0];
  const negOnTopic = { affect_valence: -0.8, affect_intensity: 0.8, embedding: [1, 0] };
  const negOffTopic = { affect_valence: -0.8, affect_intensity: 0.8, embedding: [0, 1] };

  // 她负面 + 指向外部话题 "考试"
  const stExternal = { mood: { valence: -0.6 }, relationship: { tension: 0.6, tension_target: 'external', tension_topic: '考试' } };
  const onT = directedMoodCongruence(negOnTopic, stExternal, { topicEmbedding: topicVec });
  const offT = directedMoodCongruence(negOffTopic, stExternal, { topicEmbedding: topicVec });
  ok('定向门控: 话题相关的负面记忆点亮 > 不相关的', onT > offT);
  ok('定向门控: 不相关的负面记忆被压低但不归零', offT < onT && Math.abs(offT) > 0);

  // 指向用户时退化为全局门控 (两条记忆点亮一致, 与 moodCongruence 相同)
  const stUser = { mood: { valence: -0.6 }, relationship: { tension: 0.6, tension_target: 'user' } };
  const u1 = directedMoodCongruence(negOnTopic, stUser, { topicEmbedding: topicVec });
  ok('指向用户: 退化为全局 moodCongruence', Math.abs(u1 - moodCongruence(negOnTopic, stUser)) < 1e-9);
  // 无话题向量也退化为全局
  const noVec = directedMoodCongruence(negOnTopic, stExternal, {});
  ok('无话题向量: 退化为全局 moodCongruence', Math.abs(noVec - moodCongruence(negOnTopic, stExternal)) < 1e-9);
}

console.log(`\nM2 全部 ${passed} 条断言通过 ✅`);
