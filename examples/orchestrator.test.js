// 编排器纯逻辑测试: prompt 拼接 + 子系统适配 + reply/afterReply 管线。不连网。
// 验收 (见编排器设计方案):
//   - assemble/buildSystemPrompt/buildMonologueContext 纯拼接, 空状态容错
//   - formatEmotionPrompt/formatRelationshipPrompt 把状态翻译成自然语言, 空状态返回空串
//   - Orchestrator.reply 按 deps 注入的 mock 跑完整管线 (同步路径 + 后台 afterReply)
import assert from 'node:assert';
import {
  Orchestrator,
  MemoryAdapter,
  EmotionAdapter,
  RelationshipAdapter,
  PersonaAdapter,
  DefaultLLM,
  assemble,
  buildSystemPrompt,
  buildMonologueContext,
  formatEmotionPrompt,
  formatRelationshipPrompt,
} from '../src/orchestrator/index.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('buildSystemPrompt (纯拼接, 跳过空段落)');
{
  ok('全部为空 -> 空串', buildSystemPrompt({}) === '');
  ok('非空段落用空行分隔', buildSystemPrompt({ personaPrompt: 'A', emotionPrompt: 'B' }) === 'A\n\nB');
  ok(
    '内心独白被包装并追加在最后',
    buildSystemPrompt({ personaPrompt: 'A', monologue: '想法' }) === 'A\n\n(你此刻的想法, 别直接说出来): 想法'
  );
  ok('空白独白不会被追加', buildSystemPrompt({ personaPrompt: 'A', monologue: '   ' }) === 'A');
}

console.log('assemble (system + 短期历史裁剪 + 当前消息)');
{
  const withSystem = assemble({ userMessage: '你好', history: [], personaPrompt: 'A' });
  ok('有 system 段时排在最前', withSystem[0].role === 'system' && withSystem[0].content === 'A');
  ok('最后一条是当前用户消息', withSystem.at(-1).role === 'user' && withSystem.at(-1).content === '你好');

  const noSystem = assemble({ userMessage: '你好', history: [] });
  ok('所有段落都为空时不插入 system', noSystem.length === 1 && noSystem[0].role === 'user');

  const history = [
    { role: 'user', content: '1' },
    { role: 'assistant', content: '2' },
    { role: 'user', content: '3' },
    { role: 'assistant', content: '4' },
  ];
  const trimmed = assemble({ userMessage: '5', history, historyTurns: 1, personaPrompt: 'A' });
  ok('history 裁剪到最近 1 轮 (2条)', trimmed.length === 4);
  ok('裁剪后保留最近的两条历史', trimmed[1].content === '3' && trimmed[2].content === '4');
}

console.log('buildMonologueContext (拼内心独白输入)');
{
  const ctx = buildMonologueContext({ userMessage: '在干嘛', personaPrompt: 'A', emotionPrompt: 'B' });
  ok('包含各子系统段落', ctx.includes('A') && ctx.includes('B'));
  ok('包含用户原话', ctx.includes('对方刚说: "在干嘛"'));
  ok('包含写想法的指令', ctx.includes('写一句她此刻心里冒出来的真实想法'));

  const ctxEmpty = buildMonologueContext({ userMessage: '在干嘛' });
  ok('子系统段落全空时仍有原话+指令两段', ctxEmpty.split('\n\n').length === 2);
}

console.log('formatEmotionPrompt (情绪状态 -> 自然语言, 容忍空状态)');
{
  ok('空状态返回空串', formatEmotionPrompt(null) === '');
  ok('基线状态 -> 平静', formatEmotionPrompt({}) === '你现在心情平静。');
  ok(
    '低唤起 + 平静 -> 补一句慵懒',
    formatEmotionPrompt({ mood: { arousal: 0.05 } }) === '你现在心情平静, 状态比较慵懒。'
  );
  ok(
    '高 valence + 高 arousal -> 开心且激动',
    formatEmotionPrompt({ mood: { valence: 0.5, arousal: 0.8 } }) === '你现在心情开心, 情绪比较激动。'
  );
  ok(
    'repair_debt 高 -> 受伤/闹脾气 且补一句没说开的事',
    formatEmotionPrompt({ relationship: { repair_debt: 0.5 } }) === '你现在心情受伤/闹脾气, 心里还憋着一点没说开的事。'
  );
}

console.log('formatRelationshipPrompt (关系状态 -> 自然语言, 容忍空状态)');
{
  ok('空状态返回空串', formatRelationshipPrompt(null) === '');
  ok('基线状态 -> 还不算太熟', formatRelationshipPrompt({}) === '你们还不算太熟, 说话要保持一点礼貌和分寸。');
  ok(
    '有待和好的债 -> 优先于亲密度',
    formatRelationshipPrompt({ relationship: { repair_debt: 0.5, closeness: 0.9 } }) ===
      '你们之间还有点没和好的别扭, 她还在等一句主动的道歉。'
  );
  ok(
    '高亲密度 -> 称呼可以更黏人',
    formatRelationshipPrompt({ relationship: { closeness: 0.8 } }) === '你们已经很亲密了, 称呼和语气可以更黏人、更随意。'
  );
  ok(
    '中等亲密 + 高信任 -> 熟悉信任',
    formatRelationshipPrompt({ relationship: { closeness: 0.6, trust: 0.6 } }) === '你们处得不错, 算是熟悉信任的关系。'
  );
  ok(
    '中等亲密 + 低信任 -> 还留着保留',
    formatRelationshipPrompt({ relationship: { closeness: 0.6, trust: 0.3 } }) === '你们处得还行, 但她对你还留着一点保留。'
  );
}

console.log('RelationshipAdapter.bump 在本系统里是 no-op; EmotionAdapter 由独立 emotion 表驱动');
{
  const relationship = new RelationshipAdapter('u_noop');
  ok('relationship.bump 不连网且不抛错', (await relationship.bump()) === undefined);
  const emotion = new EmotionAdapter('u_noop');
  ok('emotion adapter 暴露 samplingHints', typeof emotion.samplingHints === 'function');
}

console.log('Orchestrator 默认依赖 (无 deps) 构造不抛错、不连网');
{
  const orch = new Orchestrator({ userId: 'u_default', subjectName: '诗雅', companionName: '可可' });
  ok('memory 是 MemoryAdapter', orch.memory instanceof MemoryAdapter);
  ok('emotion 是 EmotionAdapter', orch.emotion instanceof EmotionAdapter);
  ok('relationship 是 RelationshipAdapter', orch.relationship instanceof RelationshipAdapter);
  ok('persona 是 PersonaAdapter', orch.persona instanceof PersonaAdapter);
  ok('llm 是 DefaultLLM', orch.llm instanceof DefaultLLM);
  ok('persona.name 取 companionName', orch.persona.name === '可可');
}

// ---- 完整管线: 全部依赖注入为 mock, 验证拼接顺序与 afterReply 触发 ----
function makeMocks() {
  return {
    memory: {
      recallCalls: [],
      observeCalls: [],
      async recall(query) {
        this.recallCalls.push(query);
        return '你记得关于诗雅的事:\n- 诗雅讨厌香菜';
      },
      async observe(turns) {
        this.observeCalls.push(turns);
      },
    },
    emotion: {
      currentCalls: 0,
      updateCalls: [],
      async current() {
        this.currentCalls++;
        return { mood: { valence: 0.5 }, relationship: {} };
      },
      async update(userMessage, reply) {
        this.updateCalls.push([userMessage, reply]);
      },
      toPrompt(state) {
        return state ? `情绪:${state.mood.valence}` : '';
      },
      samplingHints() {
        return { temperature: 0.91, maxTokens: 333 };
      },
    },
    relationship: {
      currentCalls: 0,
      bumpCalls: 0,
      async current() {
        this.currentCalls++;
        return { relationship: { closeness: 0.6 } };
      },
      async bump() {
        this.bumpCalls++;
      },
      toPrompt(state) {
        return state ? `关系:${state.relationship.closeness}` : '';
      },
    },
    persona: {
      loadCalls: 0,
      _cached: '',
      async load() {
        this.loadCalls++;
        this._cached = '可可是这样一个人:\n- 爱吃甜的';
        return this._cached;
      },
      toPrompt() {
        return this._cached;
      },
    },
    llm: {
      thinkCalls: [],
      generateCalls: [],
      async think(ctx) {
        this.thinkCalls.push(ctx);
        return '他今天聊起诗雅, 我有点开心。';
      },
      async generateReply(messages, opts = {}) {
        this.generateCalls.push({ messages, opts });
        return '嗯嗯, 我记得呀!';
      },
    },
  };
}

function makeHistoryStore(initial = []) {
  return {
    loadCalls: [],
    appendCalls: [],
    async load(args) {
      this.loadCalls.push(args);
      return initial;
    },
    async append(args) {
      this.appendCalls.push(args);
    },
  };
}

console.log('Orchestrator.reply 完整管线 (deps 全 mock)');
{
  const deps = makeMocks();
  const orch = new Orchestrator({
    userId: 'u_test',
    subjectName: '诗雅',
    companionName: '可可',
    deps,
    options: { historyTurns: 1 },
  });

  const reply1 = await orch.reply('诗雅最近怎么样?');
  ok('reply 返回 llm.generateReply 的结果', reply1 === '嗯嗯, 我记得呀!');
  ok('persona.load 只在首轮调用一次', deps.persona.loadCalls === 1);
  ok('memory.recall 收到当前用户消息', deps.memory.recallCalls[0] === '诗雅最近怎么样?');
  ok('emotion.current 被调用', deps.emotion.currentCalls === 1);
  ok('relationship.current 被调用', deps.relationship.currentCalls === 1);
  ok('useMonologue 默认开启, llm.think 被调用一次', deps.llm.thinkCalls.length === 1);

  const { messages: messages1, opts: opts1 } = deps.llm.generateCalls[0];
  ok('messages 第一条是 system', messages1[0].role === 'system');
  ok('system 含人格段', messages1[0].content.includes('可可是这样一个人'));
  ok('system 含情绪段', messages1[0].content.includes('情绪:0.5'));
  ok('system 含关系段', messages1[0].content.includes('关系:0.6'));
  ok('system 含记忆块', messages1[0].content.includes('诗雅讨厌香菜'));
  ok('system 含内心独白标记', messages1[0].content.includes('你此刻的想法'));
  ok('generateReply 收到 emotion samplingHints', opts1.temperature === 0.91 && opts1.maxTokens === 333);
  ok('最后一条是当前用户消息', messages1.at(-1).role === 'user' && messages1.at(-1).content === '诗雅最近怎么样?');

  ok('短期历史记下这一轮 (user+assistant)', orch.history.length === 2);

  await orch._lastAfterReply;
  ok('memory.observe 收到这一轮的两条消息', deps.memory.observeCalls[0].length === 2);
  ok('emotion.update 被调用一次 (afterReply)', deps.emotion.updateCalls.length === 1);
  ok('relationship.bump 被调用一次 (afterReply)', deps.relationship.bumpCalls === 1);

  // 第二轮: 验证短期历史按 historyTurns=1 (2条) 注入且持续裁剪
  const reply2 = await orch.reply('那她现在心情怎么样?');
  ok('第二轮回复正常返回', reply2 === '嗯嗯, 我记得呀!');
  ok('persona.load 不重复调用 (已缓存)', deps.persona.loadCalls === 1);
  ok('history 仍裁剪在 2 条以内', orch.history.length === 2);

  const { messages: messages2 } = deps.llm.generateCalls[1];
  ok('第二轮带上第一轮的对话作为短期历史', messages2[1].content === '诗雅最近怎么样?' && messages2[2].content === '嗯嗯, 我记得呀!');
  ok('第二轮最后一条是新的用户消息', messages2.at(-1).content === '那她现在心情怎么样?');
}

console.log('Orchestrator.reply (useMonologue: false 时跳过内心独白)');
{
  const deps = makeMocks();
  const orch = new Orchestrator({ userId: 'u_test2', deps, options: { useMonologue: false } });
  await orch.reply('你好');
  ok('llm.think 未被调用', deps.llm.thinkCalls.length === 0);
  const { messages } = deps.llm.generateCalls[0];
  ok('system 不含内心独白标记', !messages[0].content.includes('你此刻的想法'));
}

console.log('Orchestrator 可注入 historyStore (启动加载 + 回复后异步追加)');
{
  const deps = makeMocks();
  deps.historyStore = makeHistoryStore([
    { role: 'assistant', content: '更早的回复' },
    { role: 'user', content: '上一句' },
    { role: 'assistant', content: '上一句的回复' },
  ]);
  const orch = new Orchestrator({ userId: 'u_history', deps, options: { historyTurns: 1, useMonologue: false } });
  await orch.reply('继续');

  ok('historyStore.load 收到 userId 和 limit', deps.historyStore.loadCalls[0].userId === 'u_history' && deps.historyStore.loadCalls[0].limit === 2);
  const { messages } = deps.llm.generateCalls[0];
  ok('生成前注入加载到的最近一轮历史', messages[1].content === '上一句' && messages[2].content === '上一句的回复');
  ok('回复后实例历史仍按 historyTurns 裁剪', orch.history.length === 2);
  await orch._lastHistoryPersist;
  ok('historyStore.append 收到本轮 user+assistant', deps.historyStore.appendCalls[0].turns.length === 2);
}

console.log('Orchestrator.proactiveTick (主动性入口复用组装链路)');
{
  const deps = makeMocks();
  const orch = new Orchestrator({ userId: 'u_proactive', deps, options: { historyTurns: 2 } });

  const skipped = await orch.proactiveTick({ shouldSend: false });
  ok('shouldSend=false 时返回 null', skipped === null);
  ok('跳过时不调用生成模型', deps.llm.generateCalls.length === 0);

  const msg = await orch.proactiveTick({ reason: '很久没聊天', style: '轻一点' });
  ok('主动消息返回 generateReply 的结果', msg === '嗯嗯, 我记得呀!');
  ok('主动消息会检索记忆', deps.memory.recallCalls.length === 1);
  ok('主动消息默认也会生成内心独白', deps.llm.thinkCalls.length === 1);
  const { messages, opts } = deps.llm.generateCalls[0];
  ok('主动 prompt 最后一条是内部主动开场指令', messages.at(-1).role === 'user' && messages.at(-1).content.includes('主动找对方'));
  ok('主动 prompt 带入 reason/style', messages.at(-1).content.includes('很久没聊天') && messages.at(-1).content.includes('轻一点'));
  ok('主动生成同样收到 emotion samplingHints', opts.temperature === 0.91 && opts.maxTokens === 333);
  ok('主动消息默认记入短期历史为 assistant', orch.history.at(-1).role === 'assistant' && orch.history.at(-1).content === msg);
}

console.log(`\nOrchestrator 全部 ${passed} 条断言通过 ✅`);
