// 编排器纯逻辑测试: prompt 拼接 + 子系统适配 + reply/afterReply 管线。不连网。
// 验收 (见编排器设计方案):
//   - assemble/buildSystemPrompt/buildMonologueContext 纯拼接, 空状态容错
//   - formatRelationshipPrompt 把状态翻译成自然语言, 空状态返回空串
//   - Orchestrator.reply 按 deps 注入的 mock 跑完整管线 (同步路径 + 后台 afterReply)
import assert from 'node:assert';
import {
  Orchestrator,
  MemoryAdapter,
  StateLayerAdapter,
  RelationshipAdapter,
  PersonaAdapter,
  DefaultLLM,
  assemble,
  buildSystemPrompt,
  buildTimePrompt,
  buildGapHint,
  buildMonologueContext,
  formatRelationshipPrompt,
} from '../src/orchestrator/index.js';
import { normalizeCompanionConfig } from '../src/companion.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('buildSystemPrompt (纯拼接, 跳过空段落)');
{
  ok('全部为空 -> 空串', buildSystemPrompt({}) === '');
  ok('非空段落用空行分隔', buildSystemPrompt({ personaPrompt: 'A', statePrompt: 'B' }) === 'A\n\nB');
  ok(
    '时间段排在 system 最前面',
    buildSystemPrompt({ timePrompt: 'T', personaPrompt: 'A', statePrompt: 'B' }) === 'T\n\nA\n\nB'
  );
  ok(
    '内心独白被包装并追加在最后',
    buildSystemPrompt({ personaPrompt: 'A', monologue: '想法' }) === 'A\n\n(你此刻的想法, 别直接说出来): 想法'
  );
  ok('空白独白不会被追加', buildSystemPrompt({ personaPrompt: 'A', monologue: '   ' }) === 'A');
}

console.log('buildTimePrompt (真实时间上下文)');
{
  const prompt = buildTimePrompt(new Date('2026-06-15T08:33:00Z'));
  ok('包含中国/武汉时区', prompt.includes('武汉') && prompt.includes('Asia/Shanghai'));
  ok('包含换算后的本地时间', prompt.includes('2026-06-15 16:33'));
  ok('要求问时间时直接回答', prompt.includes('问现在几点'));
  ok('未传 gapHours 不带时间跳跃感提示', !prompt.includes('才回'));

  const withGap = buildTimePrompt(new Date('2026-06-15T08:33:00Z'), { gapHours: 5 });
  ok('gapHours 够大时追加时间跳跃感提示', withGap.includes('才回来'));
}

console.log('buildGapHint (时间跳跃感: 距上次说话过了多久, 分级软提示)');
{
  ok('null -> 不提', buildGapHint(null) === '');
  ok('刚聊过 (0.5h) -> 不提', buildGapHint(0.5) === '');
  ok('excuse 档 (2-4h) -> 轻描淡写接上', buildGapHint(2.5).includes('才回'));
  ok('direct 档 (4-6h) -> 惦记, 问问刚才在干嘛', buildGapHint(5).includes('惦记'));
  ok('miss 档 (>6h) -> 小情绪/失落', buildGapHint(8).includes('失落'));
  ok('跨天 (>=24h) -> 好久没理我/想你, 按天数', buildGapHint(50).includes('2 天') && buildGapHint(50).includes('想你'));
  ok('所有分级提示都要求别报数字', [2.5, 5, 8, 50].every((h) => buildGapHint(h).includes('别报数字')));
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
  const ctx = buildMonologueContext({ userMessage: '在干嘛', personaPrompt: 'A', statePrompt: 'B' });
  ok('包含各子系统段落', ctx.includes('A') && ctx.includes('B'));
  ok('包含用户原话', ctx.includes('对方刚说: "在干嘛"'));
  ok('包含写想法的指令', ctx.includes('写一句她此刻心里冒出来的真实想法'));

  const ctxEmpty = buildMonologueContext({ userMessage: '在干嘛' });
  ok('子系统段落全空时仍有原话+指令两段', ctxEmpty.split('\n\n').length === 2);

  const ctxSituation = buildMonologueContext({ situation: '你想主动找对方说点什么', personaPrompt: 'A' });
  ok('situation 模式不加"对方刚说"前缀', !ctxSituation.includes('对方刚说'));
  ok('situation 内容原样拼入', ctxSituation.includes('你想主动找对方说点什么'));
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

console.log('RelationshipAdapter.bump / StateLayerAdapter.evolve 均为 no-op (增量随 memory.observe 完成)');
{
  const relationship = new RelationshipAdapter('u_noop');
  ok('relationship.bump 不连网且不抛错', (await relationship.bump()) === undefined);
  let delegatedTurns = null;
  const stateLayer = new StateLayerAdapter('u_noop', 'default', {
    async snapshot() {
      return null;
    },
    async evolve(turns) {
      delegatedTurns = turns;
    },
    toPrompt() {
      return '';
    },
    samplingHints() {
      return {};
    },
  });
  const turns = [{ role: 'user', content: 'hi' }];
  // L4: life(及情绪/关系)的演变已移交 memory.observe 统一处理, adapter.evolve 不再重复演变 life,
  // 否则会与 memory.observe 里的 life.evolve 双写 life_state。
  ok('stateLayer.evolve 是 no-op, 不再委托底层 evolve', (await stateLayer.evolve(turns)) === undefined && delegatedTurns === null);
  ok('stateLayer adapter 暴露 samplingHints', typeof stateLayer.samplingHints === 'function');
}

console.log('Orchestrator 默认依赖 (无 deps) 构造不抛错、不连网');
{
  const orch = new Orchestrator({ userId: 'u_default', subjectName: '诗雅', companionName: '可可' });
  ok('memory 是 MemoryAdapter', orch.memory instanceof MemoryAdapter);
  ok('stateLayer 是 StateLayerAdapter', orch.stateLayer instanceof StateLayerAdapter);
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
      trainCalls: [],
      async recall(query) {
        this.recallCalls.push(query);
        return '你记得关于诗雅的事:\n- 诗雅讨厌香菜';
      },
      async observe(turns) {
        this.observeCalls.push(turns);
      },
      async train(opts) {
        this.trainCalls.push(opts);
        return { seeded: [], diary: null };
      },
    },
    stateLayer: {
      snapshotCalls: 0,
      evolveCalls: [],
      async snapshot() {
        this.snapshotCalls++;
        return { emotion: { valence: 0.5, warmth: 0.6 }, life: { energy: 0.4 } };
      },
      async evolve(turns) {
        this.evolveCalls.push(turns);
      },
      toPrompt(snapshot) {
        return snapshot ? `状态:${snapshot.emotion.valence}/${snapshot.life.energy}` : '';
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

function makeHistoryStore(initial = [], lastUserMessageAt = null) {
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
    async lastUserMessageAt() {
      return lastUserMessageAt;
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
  ok('stateLayer.snapshot 被调用', deps.stateLayer.snapshotCalls === 1);
  ok('relationship.current 被调用', deps.relationship.currentCalls === 1);
  ok('useMonologue 默认开启, llm.think 被调用一次', deps.llm.thinkCalls.length === 1);

  const { messages: messages1, opts: opts1 } = deps.llm.generateCalls[0];
  ok('messages 第一条是 system', messages1[0].role === 'system');
  ok('system 含人格段', messages1[0].content.includes('可可是这样一个人'));
  ok('system 含状态层段', messages1[0].content.includes('状态:0.5/0.4'));
  ok('system 含关系段', messages1[0].content.includes('关系:0.6'));
  ok('system 含记忆块', messages1[0].content.includes('诗雅讨厌香菜'));
  ok('system 含内心独白标记', messages1[0].content.includes('你此刻的想法'));
  ok('generateReply 收到 stateLayer samplingHints', opts1.temperature === 0.91 && opts1.maxTokens === 333);
  ok('最后一条是当前用户消息', messages1.at(-1).role === 'user' && messages1.at(-1).content === '诗雅最近怎么样?');

  ok('短期历史记下这一轮 (user+assistant)', orch.history.length === 2);

  await orch._lastAfterReply;
  ok('memory.observe 收到这一轮的两条消息', deps.memory.observeCalls[0].length === 2);
  ok('stateLayer.evolve 被调用一次 (afterReply)', deps.stateLayer.evolveCalls.length === 1);
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

console.log('Orchestrator.reply 时间跳跃感 (historyStore.lastUserMessageAt -> gapHours -> system 软提示)');
{
  // 8 小时前说过话 -> miss 档 ("失落")
  const deps = makeMocks();
  const longAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  deps.historyStore = makeHistoryStore([], longAgo);
  const orch = new Orchestrator({ userId: 'u_gap', deps, options: { useMonologue: false } });
  await orch.reply('在吗');
  const { messages } = deps.llm.generateCalls[0];
  ok('距上次说话 8h -> system 带"失落"软提示', messages[0].content.includes('失落'));
  ok('软提示带"别报数字"', messages[0].content.includes('别报数字'));

  // 没有上次说话记录 (lastUserMessageAt 返回 null) -> 不带提示
  const deps2 = makeMocks();
  deps2.historyStore = makeHistoryStore([], null);
  const orch2 = new Orchestrator({ userId: 'u_gap2', deps: deps2, options: { useMonologue: false } });
  await orch2.reply('在吗');
  const { messages: messages2 } = deps2.llm.generateCalls[0];
  ok('没有上次说话记录 -> 不带时间跳跃感提示', !messages2[0].content.includes('别报数字'));
}

console.log('Orchestrator persona 缓存按 personaRefreshMs 刷新 (长期运行实例感知 self 记忆更新)');
{
  const deps = makeMocks();
  const orch = new Orchestrator({ userId: 'u_persona_stale', deps, options: { useMonologue: false, personaRefreshMs: 0 } });
  await orch.reply('你好');
  await orch.reply('在吗');
  ok('personaRefreshMs=0 时每轮都重新加载 persona', deps.persona.loadCalls === 2);
}

console.log('Orchestrator.maintain 夜间触发 memory.train (M9 每日训练: 知识滴灌 + 自我日记)');
{
  const deps = makeMocks();
  const config = normalizeCompanionConfig({ name: '可可', knowledgeBank: ['她爱吃甜的'] });
  const orch = new Orchestrator({ userId: 'u_train', deps, config, options: { useMonologue: false } });

  await orch.maintain({ nightly: false });
  ok('非夜间不触发 memory.train', deps.memory.trainCalls.length === 0);

  await orch.maintain({ nightly: true });
  ok('夜间触发 memory.train 一次', deps.memory.trainCalls.length === 1);
  const trainOpts = deps.memory.trainCalls[0];
  ok('train 收到 knowledgeBank (来自 CompanionConfig)', trainOpts.knowledgeBank[0] === '她爱吃甜的');
  ok('train 收到 llm (用于自我日记)', trainOpts.llm === deps.llm);
  ok(
    'train 收到拼好的 promptCtx (人格/状态/关系段)',
    trainOpts.promptCtx.personaPrompt.includes('可可是这样一个人') && trainOpts.promptCtx.statePrompt.includes('状态:')
  );
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
  ok('主动独白输入不把主动开场指令当成"对方刚说"', !deps.llm.thinkCalls[0].includes('对方刚说'));
  ok('主动独白输入描述的是"自己想主动找对方"的情境', deps.llm.thinkCalls[0].includes('你自己想主动找对方说点什么'));
  const { messages, opts } = deps.llm.generateCalls[0];
  ok('主动 prompt 最后一条是内部主动开场指令', messages.at(-1).role === 'user' && messages.at(-1).content.includes('主动找对方'));
  ok('主动 prompt 带入 reason/style', messages.at(-1).content.includes('很久没聊天') && messages.at(-1).content.includes('轻一点'));
  ok('主动生成同样收到 stateLayer samplingHints', opts.temperature === 0.91 && opts.maxTokens === 333);
  ok('主动消息默认记入短期历史为 assistant', orch.history.at(-1).role === 'assistant' && orch.history.at(-1).content === msg);
}

console.log('Orchestrator A1 拍照分享 (onPhoto 投递回调 + 用户要求触发自拍)');
{
  const deps = makeMocks();
  const photoCalls = [];
  const delivered = [];
  deps.photo = {
    async rateState() {
      return { sentAt: [] };
    },
    async photo(snapshot, opts) {
      photoCalls.push(opts);
      return { url: 'mock://selfie.png', tags: ['selfie', 'happy'], kind: opts.kind, cached: false };
    },
  };
  deps.onPhoto = (p) => delivered.push(p);
  const orch = new Orchestrator({ userId: 'u_photo', deps, options: { useMonologue: false } });

  // 普通消息: 不触发拍照
  await orch.reply('今天好热');
  await (orch._lastPhoto ?? Promise.resolve());
  ok('普通消息不触发拍照', photoCalls.length === 0 && delivered.length === 0);

  // 要看她样子: 触发自拍, 经 onPhoto 投递
  await orch.reply('发张自拍看看你现在的样子');
  await orch._lastPhoto;
  ok('用户要照片 → 生成一张', photoCalls.length === 1);
  ok('生成的是自拍 (kind=selfie)', photoCalls[0].kind === 'selfie');
  ok('经 onPhoto 投递, 带 url 与 kind', delivered.length === 1 && delivered[0].url === 'mock://selfie.png' && delivered[0].kind === 'selfie');

  // 没有 onPhoto 投递渠道时, 不生成 (默认离线安全)
  const deps2 = makeMocks();
  let called = false;
  deps2.photo = { async rateState() { return { sentAt: [] }; }, async photo() { called = true; return null; } };
  const orch2 = new Orchestrator({ userId: 'u_nophoto', deps: deps2, options: { useMonologue: false } });
  await orch2.reply('发张自拍');
  await (orch2._lastPhoto ?? Promise.resolve());
  ok('没配 onPhoto → 不生成照片', called === false);
}

console.log(`\nOrchestrator 全部 ${passed} 条断言通过 ✅`);
