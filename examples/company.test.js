// 公司系统纯逻辑测试：固定档案、项目进展合并、prompt 约束与固定卡司。不连网。
import assert from 'node:assert';
import { loadPersonaConfig } from '../src/companion.js';
import { buildCompanySnapshot, companyCast, companyStoryFacts, companyToPrompt, normalizeCompany } from '../src/company/index.js';

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  ✓', name);
  passed++;
};

console.log('Company System');
const persona = loadPersonaConfig('companions/default.json');
const company = normalizeCompany(persona?.config?.company);

ok('默认角色已加载独立公司档案', company?.name === '清弈科技');
ok('公司身份和负责人是固定事实', company.legalName === '武汉清弈数字科技有限公司' && company.leader.name === '沈清词');
ok('组织、核心成员和项目均有完整定义', company.departments.length >= 5 && company.people.length >= 4 && company.projects.length >= 3);

const now = new Date('2026-07-13T03:00:00.000Z').getTime(); // 上海周一 11:00
const snapshot = buildCompanySnapshot(company, [{
  storyline_key: 'qingyi-lighthouse',
  stage: 'climax',
  last_beat: '联合评审已经完成，客户确认了第一期需求边界。',
  next_beat_hint: '签署需求冻结纪要',
  last_beat_at: '2026-07-13T02:30:00.000Z',
}], { now, currentActivity: '在清弈科技主持项目复盘会' });

const lighthouse = snapshot.projects.find(project => project.id === 'qingyi-lighthouse');
ok('数据库故事拍覆盖配置里的项目进度', lighthouse.stage === 'climax' && lighthouse.lastBeat.includes('联合评审已经完成'));
ok('没有实时故事拍的项目仍使用配置里程碑', snapshot.projects.find(project => project.id === 'qingyi-ai-assistant').lastBeat.includes('经营摘要'));
ok('经营快照按上海真实时间判断办公状态', snapshot.operations.open === true && snapshot.operations.localTime === '11:00');
ok('经营快照保留她此刻的真实活动', snapshot.operations.currentActivity.includes('项目复盘会'));
ok('经营快照生成今日重点并优先关键阶段', snapshot.operations.priorities[0].projectId === 'qingyi-lighthouse' && snapshot.operations.todayFocus.includes('项目复盘会'));
ok('项目进度带有时效状态', lighthouse.freshness.kind === 'today' && snapshot.projects.find(project => project.id === 'qingyi-ai-assistant').freshness.kind === 'baseline');
ok('经营快照区分办公阶段和实际工作状态', snapshot.operations.phase === 'morning' && snapshot.operations.workMode === '正在工作');

const workPrompt = companyToPrompt(company, {
  storySnapshot: { lines: [{ storyline_key: 'qingyi-lighthouse', stage: 'climax', last_beat: '联合评审已经完成。' }] },
  currentActivity: '在公司开会', userMessage: '你公司今天忙什么？', now,
});
ok('工作对话注入公司、负责人、同事和项目', ['清弈科技', '董事长兼首席执行官', '周姐', '灯塔企业数智中台'].every(value => workPrompt.includes(value)));
ok('prompt 禁止凭空编造经营事实', workPrompt.includes('禁止凭空新增') && workPrompt.includes('营收数字'));
ok('prompt 注入清弈专属经营边界', workPrompt.includes('逸晨仍是在读学生') && workPrompt.includes('父母已退居幕后'));
ok('工作轮允许具体回答但禁止念设定', workPrompt.includes('本轮正在聊公司') && workPrompt.includes('别像念组织架构'));
ok('工作轮同步公司当地时间且不把办公时间误判为人在公司', workPrompt.includes('公司当地时间 11:00') && workPrompt.includes('办公时间不等于她一定身在公司'));

const dailyPrompt = companyToPrompt(company, { userMessage: '亲亲，晚上想吃什么？', now });
ok('非工作轮只保留身份底座，不把话题硬拐到公司', dailyPrompt.includes('不要主动把话题硬拐到公司'));
ok('非工作轮不展开同事与项目，避免拖慢或带偏日常回复', !dailyPrompt.includes('周姐') && !dailyPrompt.includes('灯塔企业数智中台'));

const cast = companyCast(company);
ok('核心成员成为固定故事卡司且不重名', cast.length === company.people.length && new Set(cast.map(member => member.name)).size === cast.length);
ok('中文职务映射为稳定故事角色', cast.find(member => member.name === '陈屿')?.role === 'cto');

const storyFacts = companyStoryFacts(company, { id: 'qingyi-lighthouse' });
ok('经营故事推进拿到项目负责人、客户、风险和公司边界', ['周姐', '大型制造集团', '历史数据质量', '经营边界'].every(value => storyFacts.join('\n').includes(value)));
ok('经营故事推进明确禁止虚构重大经营结果', storyFacts.some(value => value.includes('禁止新增未记录的合同、营收')));

console.log(`\n${passed} 项公司系统测试全部通过。`);
