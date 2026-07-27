import assert from 'node:assert';
import { StoryEngine, nextStoryStage, normalizeCast, normalizeStoryline, toStoryPrompt } from '../src/story/index.js';

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); console.log('  ✓', name); passed++; }

console.log('S1 story pure logic');
const cast = normalizeCast([{ name: '周姐', role: 'colleague', closeness: 2 }, { name: '周姐', role: 'friend' }, { name: '' }]);
ok('卡司去重、过滤空名并钳制亲密度', cast.length === 1 && cast[0].closeness === 1);
ok('非法 stage 回退 setup', normalizeStoryline({ id: 'x', title: '项目', stage: 'bad' }).stage === 'setup');
const prompt = toStoryPrompt({ lines: [{ title: '项目评审', stage: 'rising', last_beat: '周姐提出了修改意见' }], today: null });
ok('故事 prompt 带连续进展', prompt.includes('项目评审') && prompt.includes('周姐提出了修改意见') && prompt.includes('连续发生'));
ok('空故事不注入', toStoryPrompt({ lines: [], today: null }) === '');
ok('阶段机按 setup→rising→climax→cooldown→closed 推进', nextStoryStage('setup') === 'rising' && nextStoryStage('rising') === 'climax' && nextStoryStage('climax') === 'cooldown' && nextStoryStage('cooldown') === 'closed');
ok('LLM 不能越级关闭故事线', nextStoryStage('setup', 'closed') === 'rising');

console.log('StoryEngine seed/current/K1');
{
  const calls = { rows: [], relations: [] };
  const stored = [{ storyline_key: 'project', title: '新项目', stage: 'setup', mood_link: 0.1, last_beat: '准备启动', next_beat_hint: '内部评审', updated_at: '2026-07-11T00:00:00Z' }];
  const client = { from() { return {
    async upsert(rows) { calls.rows.push(...rows); return { error: null }; },
    select() { return this; }, eq() { return this; }, async order() { return { data: stored, error: null }; },
  }; } };
  const ids = new Map([['沈清词', 'self-id'], ['周姐', 'zhou-id']]);
  const engine = new StoryEngine({ userId: 'u1', companionName: '沈清词', cast: [{ name: '周姐', role: 'colleague', closeness: 0.7 }], lines: [{ id: 'project', title: '新项目' }], client,
    entityWriter: async () => ids,
    relationWriter: async (_u, _c, relations) => { calls.relations.push(...relations); return relations.length; },
  });
  const seeded = await engine.seed();
  ok('seed 幂等写入故事线 seed', seeded.lines === 1 && calls.rows[0].storyline_key === 'project');
  ok('固定卡司写入 companion→cast 图谱关系', seeded.cast === 1 && calls.relations[0].relation === 'colleague_of');
  ok('cast() 返回图谱 entityId', engine.cast()[0].entityId === 'zhou-id');
  const current = await engine.current();
  ok('current() 返回持久化故事线', current.lines.length === 1 && current.lines[0].id === 'project');
}

console.log('StoryEngine.tick S2 每日推进闭环');
{
  let row = { storyline_key: 'project', title: '新项目', stage: 'setup', mood_link: 0, last_beat: '准备启动', next_beat_hint: '内部评审', beats_day: null, beats_today: 0, updated_at: '2026-07-10T00:00:00Z' };
  const effects = { memory: [], desires: [], affect: [], world: [] };
  const client = { from() { return {
    select() { return this; }, eq() { return this; }, async order() { return { data: [row], error: null }; },
    update(patch) { row = { ...row, ...patch }; return this; },
  }; } };
  let generated = 0;
  const llmClient = { chat: { completions: { async create(req) {
    ok('生成前 prompt 注入卡司与故事线一致性事实', req.messages[1].content.includes('周姐') && req.messages[1].content.includes('新项目'));
    generated++;
    const contents = ['周姐在内部评审时指出方案的数据迁移风险。', '团队根据意见重做了迁移方案。', '新方案通过终审，项目进入执行准备。'];
    return { choices: [{ message: { content: JSON.stringify({ content: contents[generated - 1], next_beat_hint: '继续推进', mood_link: generated === 1 ? -0.3 : 0.3, sharing: 0.7 }) } }] };
  } } } };
  const engine = new StoryEngine({ userId: 'u1', companionName: '沈清词', cast: [{ name: '周姐', role: 'colleague', closeness: 0.7 }], client, llmClient,
    memory: { async recordSelfEvent(content) { effects.memory.push(content); } },
    desire: { async accumulate(delta) { effects.desires.push(delta); } },
    affectUpdater: async (...args) => effects.affect.push(args),
    worldRead: async () => ({ atmosphere: '忙碌' }), worldWrite: async (_u, _c, world) => effects.world.push(world),
  });
  const now = Date.parse('2026-07-11T04:00:00Z');
  const beat = await engine.tick({ now });
  ok('tick 生成一拍并推进到 rising', beat?.stage === 'rising' && row.stage === 'rising');
  ok('拍子落 self 记忆', effects.memory[0].includes('周姐'));
  ok('负面拍子增加 sharing/comfort 需求', effects.desires[0].sharing === 0.7 && effects.desires[0].comfort > 0);
  ok('mood_link 写入 affect 增量', effects.affect.length === 1 && effects.affect[0][3].extraDeltas.mood.valence < 0);
  ok('故事进展同步 world_state', effects.world[0].arc.includes('周姐'));
  const pending = await engine.pendingShare(now);
  ok('新拍子成为待分享主题', pending?.content.includes('周姐') && pending.sharing === 0.7);
  await engine.markShared(pending, now + 500);
  ok('分享成功后同一拍不再待分享', await engine.pendingShare(now + 600) === null);
  ok('分享成功后消解对应 sharing', effects.desires.at(-1).sharing < 0);
  ok('同一天达到 beatsPerDay 后不重复推进', await engine.tick({ now: now + 1000 }) === null);
  await engine.tick({ now: now + 24 * 60 * 60 * 1000 });
  await engine.tick({ now: now + 48 * 60 * 60 * 1000 });
  ok('连续三个模拟日形成 rising→climax→cooldown', row.stage === 'cooldown' && effects.memory.length === 3);
}
console.log(`\nStory S1~S3 全部 ${passed} 条断言通过`);
