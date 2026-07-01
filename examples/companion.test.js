// 多角色 (multi-companion) 测试: zod 校验 + 行/配置映射 + companionId 在各层正确隔离透传。
// 纯逻辑 + 依赖注入, 不连网。
import assert from 'node:assert';
import {
  CompanionConfigSchema,
  normalizeCompanionConfig,
  safeCompanionConfig,
  rowToConfig,
  configToRow,
  personaJsonToConfig,
} from '../src/companion.js';
import { StateLayer } from '../src/state/stateLayer.js';
import { LifeDimension } from '../src/state/life.js';
import { Memory } from '../src/memory.js';
import { MemoryAdapter, StateLayerAdapter, RelationshipAdapter, PersonaAdapter } from '../src/orchestrator/index.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('CompanionConfig zod 校验');
{
  const c = normalizeCompanionConfig({ name: '可可' });
  ok('缺省字段补默认 companionId=default', c.companionId === 'default');
  ok('traits/seedFacts 默认空数组', Array.isArray(c.traits) && c.traits.length === 0 && Array.isArray(c.seedFacts));
  ok('personality/speechStyle/appearance 默认空串', c.personality === '' && c.speechStyle === '' && c.appearance === '');

  // name 必填: 缺失应抛 (ZodError)
  let threw = false;
  try {
    normalizeCompanionConfig({});
  } catch {
    threw = true;
  }
  ok('缺 name 抛 ZodError', threw);

  // 非法类型 name=数字 也应抛
  let threw2 = false;
  try {
    normalizeCompanionConfig({ name: 123 });
  } catch {
    threw2 = true;
  }
  ok('name 类型非法抛错', threw2);

  // safeParse 版本不抛
  const bad = safeCompanionConfig({});
  ok('safeCompanionConfig 校验失败返回 {ok:false}', bad.ok === false && bad.error);
  const good = safeCompanionConfig({ name: '阿冷', traits: ['冷淡'] });
  ok('safeCompanionConfig 校验通过返回 {ok:true, config}', good.ok === true && good.config.name === '阿冷');

  // seedFacts 支持字符串与对象两种形态
  const withFacts = normalizeCompanionConfig({
    name: '可可',
    seedFacts: ['可可爱吃甜的', { fact_core: '可可怕黑', importance: 8 }],
  });
  ok('seedFacts 接受 string 与 {fact_core,...} 混合', withFacts.seedFacts.length === 2);

  // M9 每日训练知识库: 与 seedFacts 同形态, 默认空数组
  ok('knowledgeBank 默认空数组', c.knowledgeBank.length === 0);
  const withKnowledge = normalizeCompanionConfig({
    name: '可可',
    knowledgeBank: ['可可大学时学过法语', { fact_core: '可可怕辣', importance: 4 }],
  });
  ok('knowledgeBank 接受 string 与 {fact_core,...} 混合', withKnowledge.knowledgeBank.length === 2);

  // 身份硬约束: 用户角色的确定事实, 纯字符串数组, 默认空
  ok('identityConstraints 默认空数组', c.identityConstraints.length === 0);
  const withIdentity = normalizeCompanionConfig({
    name: '可可',
    identityConstraints: ['他是在读大二学生, 不是上班族'],
  });
  ok('identityConstraints 接受字符串数组', withIdentity.identityConstraints.length === 1 && withIdentity.identityConstraints[0] === '他是在读大二学生, 不是上班族');
}

console.log('personaJsonToConfig: 顶层 knowledge 数组映射到 knowledgeBank (M9 知识滴灌库)');
{
  const { config } = personaJsonToConfig({
    meta: { display_name: '阿冷' },
    persona: { name: '阿冷' },
    knowledge: ['阿冷小时候学过钢琴', '阿冷怕辣'],
  });
  ok('knowledge 数组映射进 knowledgeBank', config.knowledgeBank.length === 2 && config.knowledgeBank[0] === '阿冷小时候学过钢琴');
  ok('没有 knowledge 字段时 knowledgeBank 为空数组', personaJsonToConfig({ persona: { name: '阿冷' } }).config.knowledgeBank.length === 0);
}

console.log('personaJsonToConfig: persona.identity_constraints 映射到 identityConstraints');
{
  const { config } = personaJsonToConfig({
    meta: { display_name: '阿冷' },
    persona: { name: '阿冷', identity_constraints: ['不是上班族', '住在学校旁边不用通勤'] },
  });
  ok('identity_constraints 数组映射进 identityConstraints', config.identityConstraints.length === 2 && config.identityConstraints[0] === '不是上班族');
  ok('没有 identity_constraints 字段时为空数组', personaJsonToConfig({ persona: { name: '阿冷' } }).config.identityConstraints.length === 0);
}

console.log('行 <-> Config 映射 (companions 表)');
{
  const config = {
    companionId: 'keke',
    name: '可可',
    personality: '软糯爱撒娇',
    traits: ['温柔', '爱吃甜'],
    speechStyle: '语气词多',
    appearance: '齐肩黑发, 米色毛衣',
    seedFacts: ['可可爱吃甜的'],
    identityConstraints: ['他是在读大二学生, 不是上班族'],
  };
  const row = configToRow('u1', config);
  ok('configToRow: user_id/companion_id 落独立列', row.user_id === 'u1' && row.companion_id === 'keke');
  ok('configToRow: name/appearance 冗余成独立列', row.name === '可可' && row.appearance.includes('米色毛衣'));
  ok('configToRow: 其余收进 config jsonb', row.config.personality === '软糯爱撒娇' && row.config.traits.length === 2 && row.config.seedFacts.length === 1);
  ok('configToRow: identityConstraints 收进 config jsonb', row.config.identityConstraints.length === 1);

  // 模拟从表里读回的行 (列 + config jsonb), round-trip 回 Config
  const dbRow = {
    user_id: 'u1',
    companion_id: 'keke',
    name: '可可',
    appearance: '齐肩黑发, 米色毛衣',
    config: { personality: '软糯爱撒娇', traits: ['温柔', '爱吃甜'], speechStyle: '语气词多', seedFacts: ['可可爱吃甜的'] },
  };
  const back = rowToConfig(dbRow);
  ok('rowToConfig: companionId 取自 companion_id 列', back.companionId === 'keke');
  ok('rowToConfig: name/appearance 还原', back.name === '可可' && back.appearance.includes('米色毛衣'));
  ok('rowToConfig: config jsonb 字段还原', back.personality === '软糯爱撒娇' && back.speechStyle === '语气词多');
  ok('rowToConfig: 没有 identityConstraints 列时默认空数组', back.identityConstraints.length === 0);
  // 干净的 round-trip: config -> row -> config 保持核心字段
  const rt = rowToConfig(configToRow('u1', config));
  ok('round-trip 保持核心字段', rt.companionId === 'keke' && rt.name === '可可' && rt.speechStyle === '语气词多' && rt.seedFacts.length === 1);
  ok('round-trip 保持 identityConstraints', rt.identityConstraints.length === 1 && rt.identityConstraints[0] === '他是在读大二学生, 不是上班族');
  ok('rowToConfig(null) -> null', rowToConfig(null) === null);
}

console.log('companionId 在状态层正确透传 (注入 read/write 监视)');
{
  // LifeDimension: current() 读、evolve() 写都应带上 companionId
  const reads = [];
  const writes = [];
  const read = async (userId, companionId) => {
    reads.push([userId, companionId]);
    return { energy: 0.6, satiety: 0.6, health: 1, updated_at: null };
  };
  const write = async (userId, companionId, state) => {
    writes.push([userId, companionId]);
    return state;
  };
  const life = new LifeDimension({ userId: 'u1', companionId: 'keke', read, write });
  await life.current();
  await life.evolve();
  ok('LifeDimension.current 读带 companionId', reads[0][0] === 'u1' && reads[0][1] === 'keke');
  ok('LifeDimension.evolve 写带 companionId', writes[0][0] === 'u1' && writes[0][1] === 'keke');

  // StateLayer: snapshot() 读 affect 应带上 companionId
  const stateReads = [];
  const layer = new StateLayer({
    userId: 'u1',
    companionId: 'keke',
    read: async (userId, companionId) => {
      stateReads.push([userId, companionId]);
      return { mood: { valence: 0, arousal: 0.3 }, relationship: { closeness: 0.5 }, updated_at: null };
    },
    life: { async current() { return { energy: 0.6 }; } },
  });
  await layer.snapshot();
  ok('StateLayer.snapshot 读 affect 带 companionId', stateReads[0][0] === 'u1' && stateReads[0][1] === 'keke');
  ok('StateLayer 把 companionId 传给默认 LifeDimension', new StateLayer({ userId: 'u1', companionId: 'keke' }).life.companionId === 'keke');
}

console.log('companionId 在门面/适配层落位');
{
  const mem = new Memory({ userId: 'u1', companionId: 'keke', subjectName: '诗雅' });
  ok('Memory 记住 companionId', mem.companionId === 'keke');
  ok('Memory 默认 companionId=default', new Memory({ userId: 'u1' }).companionId === 'default');

  const ma = new MemoryAdapter({ userId: 'u1', companionId: 'keke', subjectName: '诗雅' });
  ok('MemoryAdapter 透传 companionId 给内部 Memory', ma._mem.companionId === 'keke');

  const ra = new RelationshipAdapter('u1', 'keke');
  ok('RelationshipAdapter 记住 companionId', ra.companionId === 'keke');

  const sa = new StateLayerAdapter('u1', 'keke');
  ok('StateLayerAdapter 透传 companionId 给 StateLayer', sa.stateLayer.companionId === 'keke');

  const pa = new PersonaAdapter({ userId: 'u1', companionId: 'keke', subjectName: '可可' });
  ok('PersonaAdapter 记住 companionId', pa.companionId === 'keke');
  // setExtra + toPrompt: 外貌/风格补充随 persona 段一起注入
  pa.setExtra('外貌: 齐肩黑发');
  ok('PersonaAdapter.toPrompt 含 setExtra 补充', pa.toPrompt().includes('齐肩黑发'));
}

console.log(`\n多角色 全部 ${passed} 条断言通过`);
