// 世界观系统测试: toWorldPrompt / composeEvolveInput 纯逻辑 + WorldDimension 注入假 llm/read/write, 不连网。
import assert from 'node:assert';
import { defaultWorldState, toWorldPrompt, composeEvolveInput, WorldDimension } from '../src/world/index.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('toWorldPrompt (纯逻辑)');
{
  ok('全空状态 -> 空串', toWorldPrompt(defaultWorldState()) === '');
  ok('null -> 空串', toWorldPrompt(null) === '');
  const p = toWorldPrompt({ arc: '她刚搬家', atmosphere: '平静日常', last_event: '上周搬进新公寓' });
  ok('包含氛围/剧情/进展三段', p.includes('平静日常') && p.includes('她刚搬家') && p.includes('上周搬进新公寓'));
  ok('提醒别生硬复述', p.includes('别生硬复述'));
  ok('只有部分字段也能拼', toWorldPrompt({ atmosphere: '暗流涌动' }) === '当前世界氛围: 暗流涌动\n结合这些背景自然对话, 别生硬复述设定。');
}

console.log('composeEvolveInput (纯逻辑)');
{
  const input = composeEvolveInput(defaultWorldState(), [{ role: 'user', content: '我搬新家了' }]);
  ok('无历史状态标注为 (无)', input.includes('氛围=(无)') && input.includes('背景剧情=(无)'));
  ok('对话按角色标注', input.includes('对方: 我搬新家了'));
  const input2 = composeEvolveInput({ arc: 'X', atmosphere: 'Y', last_event: 'Z' }, []);
  ok('带上已有状态', input2.includes('氛围=Y') && input2.includes('背景剧情=X') && input2.includes('最近进展=Z'));
  ok('空对话标注为 (无)', input2.endsWith('最近对话:\n(无)'));
}

console.log('WorldDimension (注入假 read/write/llm, 不连网)');
{
  const seedState = { arc: '', atmosphere: '', last_event: '', updated_at: null };
  const wd = new WorldDimension({
    userId: 'u1',
    read: async () => seedState,
    write: async (userId, companionId, state) => ({ ...state, updated_at: 'now' }),
    llmClient: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify({ changed: true, arc: '她换了新工作', atmosphere: '忙碌但充实', last_event: '今天入职' }) } }],
          }),
        },
      },
    },
  });

  ok('current() 委托给 read', (await wd.current()) === seedState);
  ok('无 userId -> current() 返回默认状态, 不报错', (await new WorldDimension({}).current()).arc === '');

  const evolved = await wd.evolve([{ role: 'user', content: '我今天入职新公司了' }]);
  ok('changed=true 时写入新状态', evolved.arc === '她换了新工作' && evolved.atmosphere === '忙碌但充实');

  ok('无 turns 时 evolve 直接返回 null, 不调 LLM', (await wd.evolve([])) === null);
  ok('无 userId 时 evolve 直接返回 null', (await new WorldDimension({}).evolve([{ role: 'user', content: 'hi' }])) === null);

  const noChangeWd = new WorldDimension({
    userId: 'u2',
    read: async () => ({ arc: 'A', atmosphere: 'B', last_event: 'C', updated_at: null }),
    write: async () => {
      throw new Error('不该被调用');
    },
    llmClient: {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ changed: false }) } }] }) } },
    },
  });
  const unchanged = await noChangeWd.evolve([{ role: 'user', content: '今天天气不错' }]);
  ok('changed=false 时原样返回当前状态, 不写库', unchanged.arc === 'A');

  const failingWd = new WorldDimension({
    userId: 'u3',
    read: async () => defaultWorldState(),
    llmClient: { chat: { completions: { create: async () => { throw new Error('网络错误'); } } } },
  });
  ok('LLM 调用失败 -> evolve 降级返回 null, 不抛', (await failingWd.evolve([{ role: 'user', content: 'x' }])) === null);

  const badJsonWd = new WorldDimension({
    userId: 'u4',
    read: async () => defaultWorldState(),
    llmClient: { chat: { completions: { create: async () => ({ choices: [{ message: { content: '不是json' } }] }) } } },
  });
  ok('JSON 解析失败 -> evolve 降级返回 null, 不抛', (await badJsonWd.evolve([{ role: 'user', content: 'x' }])) === null);
}

console.log(`\n世界观系统 全部 ${passed} 条断言通过`);
