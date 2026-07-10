// K1 知识图谱应用层的纯逻辑单测: 提取解析/归一化/有界多跳展开/注入格式化。
// 不连网、不调 LLM、不碰数据库。

import {
  parseKnowledgeExtraction,
  normalizeEntityKey,
  normalizeRelation,
  expandGraph,
  formatKnowledgeFacts,
} from '../src/knowledge/index.js';

let passed = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exit(1);
  }
  console.log(`  ✓ ${name}`);
  passed++;
};

console.log('normalizeEntityKey / normalizeRelation (归一化)');
{
  ok('实体键小写去空白', normalizeEntityKey('  Xiao Wang ') === 'xiaowang');
  ok('中文实体保留原样', normalizeEntityKey('腾讯') === '腾讯');
  ok('空名 -> 空串', normalizeEntityKey('') === '');
  ok('关系归一 snake_case', normalizeRelation('Works At') === 'works_at');
  ok('杂字符折叠成下划线', normalizeRelation('friend-of / close!') === 'friend_of_close');
  ok('归一失败 -> null', normalizeRelation('##') === null);
}

console.log('parseKnowledgeExtraction (LLM 输出 -> 规范结构)');
{
  const good = parseKnowledgeExtraction(JSON.stringify({
    entities: [
      { name: '小王', type: 'person', aliases: ['王哥'] },
      { name: '小王', type: 'person' },              // 重复实体
      { name: '腾讯', type: '不存在的类型' },          // 未知 type
    ],
    relations: [
      { source: '小王', relation: 'Works At', target: '腾讯', confidence: 1.7, evidence: '他说小王在腾讯上班' },
      { source: '小王', relation: 'likes', target: '小王' }, // 自环
      { source: '妈妈', relation: 'lives_in', target: '武汉' }, // 实体表漏报
      { source: '小王', relation: 'works_at', target: '腾讯' }, // 归一后重复三元组
    ],
  }));
  ok('实体按键去重', good.entities.filter((e) => e.key === '小王').length === 1);
  ok('未知 type 归为 concept', good.entities.find((e) => e.key === '腾讯').type === 'concept');
  ok('别名保留', good.entities.find((e) => e.key === '小王').aliases.includes('王哥'));
  ok('关系名归一', good.relations[0].relation === 'works_at');
  ok('confidence 夹在 0..1', good.relations[0].confidence === 1);
  ok('自环被过滤', !good.relations.some((r) => r.sourceKey === r.targetKey));
  ok('漏报实体自动补 concept', good.entities.some((e) => e.key === '妈妈') && good.entities.some((e) => e.key === '武汉'));
  ok('归一后重复三元组去重', good.relations.filter((r) => r.relation === 'works_at').length === 1);
  ok('evidence 保留', good.relations[0].evidence === '他说小王在腾讯上班');

  ok('坏 JSON 降级为空', parseKnowledgeExtraction('不是 json').entities.length === 0);
  ok('缺字段降级为空', parseKnowledgeExtraction('{}').relations.length === 0);
  const defConf = parseKnowledgeExtraction(JSON.stringify({ entities: [], relations: [{ source: 'a', relation: 'r', target: 'b' }] }));
  ok('缺 confidence 给默认 0.7', defConf.relations[0].confidence === 0.7);
}

console.log('expandGraph (有界多跳展开)');
{
  // 图: 我 -knows-> 小王 -works_at-> 腾讯 -located_in-> 深圳; 孤岛: 猫 -likes-> 鱼
  const edges = [
    { source_entity_id: 'me', target_entity_id: 'wang', relation: 'knows', confidence: 0.9 },
    { source_entity_id: 'wang', target_entity_id: 'tencent', relation: 'works_at', confidence: 0.8 },
    { source_entity_id: 'tencent', target_entity_id: 'shenzhen', relation: 'located_in', confidence: 0.7 },
    { source_entity_id: 'cat', target_entity_id: 'fish', relation: 'likes', confidence: 0.9 },
  ];
  const oneHop = expandGraph(['wang'], edges, { maxHops: 1, maxFacts: 10 });
  ok('1 跳: 只拿直连边 (双向)', oneHop.length === 2 && oneHop.every((f) => f.hop === 1));
  const twoHop = expandGraph(['wang'], edges, { maxHops: 2, maxFacts: 10 });
  ok('2 跳: 展开到深圳', twoHop.some((f) => f.target_entity_id === 'shenzhen' && f.hop === 2));
  ok('孤岛不被卷入', !twoHop.some((f) => f.source_entity_id === 'cat'));
  ok('按 hop 升序排', twoHop[0].hop <= twoHop.at(-1).hop);
  ok('maxFacts 截断', expandGraph(['wang'], edges, { maxHops: 2, maxFacts: 1 }).length === 1);
  ok('minConfidence 过滤', !expandGraph(['wang'], edges, { maxHops: 2, maxFacts: 10, minConfidence: 0.75 }).some((f) => f.relation === 'located_in'));

  // 环不死循环: a->b, b->a
  const cyc = expandGraph(['a'], [
    { source_entity_id: 'a', target_entity_id: 'b', relation: 'r1', confidence: 0.9 },
    { source_entity_id: 'b', target_entity_id: 'a', relation: 'r2', confidence: 0.9 },
  ], { maxHops: 5, maxFacts: 10 });
  ok('环图不死循环、每条边只走一次', cyc.length === 2);
  ok('空入口返回空', expandGraph([], edges, {}).length === 0);
}

console.log('formatKnowledgeFacts (注入格式化)');
{
  const names = new Map([['wang', '小王'], ['tencent', '腾讯']]);
  const block = formatKnowledgeFacts([{ source_entity_id: 'wang', target_entity_id: 'tencent', relation: 'works_at', hop: 1 }], names);
  ok('拼出关系行', block.includes('- 小王 —works_at→ 腾讯'));
  ok('带说明头', block.includes('你记下的相关人物/事实关系'));
  ok('缺名字的边跳过', formatKnowledgeFacts([{ source_entity_id: 'x', target_entity_id: 'y', relation: 'r' }], names) === '');
  ok('空事实返回空串', formatKnowledgeFacts([], names) === '');
}

console.log(`\nK1 知识图谱 全部 ${passed} 条断言通过 ✅`);
