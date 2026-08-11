import assert from 'node:assert/strict';
import {
  checkProactiveContact,
  computeDesire,
  decideContact,
  extractContactReason,
  predictReceptivity,
  scoreReasonQuality,
} from '../src/existence/proactiveEngine.js';
import {
  InMemoryConsolidationStore,
  buildConsolidationPrompt,
  buildPrivateMemorySaveRequest,
  consolidate,
  createConsolidationKey,
  evaluateSilence,
  extractEmotionalArc,
} from '../src/existence/memoryConsolidation.js';

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log('  ✓', name);
  passed++;
}

function near(actual, expected, epsilon = 1e-9) {
  return Math.abs(actual - expected) <= epsilon;
}

console.log('Continuous Existence M2 · 内驱力');
{
  const state = {
    temporal: { longing: 0.9, anticipation: 0.6 },
    cognitive: {
      unfinished_topics: [{ summary: '面试' }, { summary: '旅行' }],
      memory_surfaced: { summary: '雨天散步' },
    },
    emotional: { emotion_intensity: 0.8, valence: 0.5 },
    volitional: { contact_inhibit: 0.1 },
  };
  ok('五路信号按设计稿权重计算并扣除克制', near(computeDesire(state), 0.605));
  ok(
    '负向情绪的主动冲动折半',
    near(
      computeDesire({
        ...state,
        emotional: { emotion_intensity: 0.8, valence: -0.5 },
      }),
      0.525,
    ),
  );
  ok(
    '异常值被限制在 0-1 且不修改输入',
    computeDesire({
      temporal: { longing: 99 },
      cognitive: { unfinished_topics: [] },
      emotional: {},
      volitional: { contact_inhibit: 99 },
    }) === 0,
  );
}

console.log('Continuous Existence M2 · 接收窗口');
{
  const pattern = {
    hourly_receptivity: Array.from({ length: 24 }, () => 0.8),
  };
  const working = await predictReceptivity('u-receptive', new Date('2026-07-29T12:00:00Z'), {
    loadUserPattern: async () => pattern,
    resolveCurrentActivity: async () => ({ value: 'working' }),
    countTodayMessages: async () => 2,
    getHour: () => 12,
  });
  ok('工作状态与当天消息密度共同压低窗口', near(working.score, 0.144));
  ok('窗口解释保留活动与消息密度证据', working.reason.includes('working') && working.reason.includes('today_messages=2'));

  const sleeping = await predictReceptivity('u-sleep', new Date('2026-07-29T12:00:00Z'), {
    loadUserPattern: async () => pattern,
    currentActivity: 'sleeping',
    getHour: () => 12,
  });
  ok('睡眠状态硬阻断主动消息', sleeping.score === 0);

  const idle = await predictReceptivity('u-idle', new Date('2026-07-29T12:00:00Z'), {
    pattern,
    currentActivity: 'idle',
    getHour: () => 12,
  });
  ok('空闲窗口可增强但不会超过 1', idle.score === 1);

  const unknown = await predictReceptivity('u-no-pattern', new Date('2026-07-29T12:00:00Z'));
  ok('缺用户模式时 fail closed，不让裸 cron 误触发', unknown.score === 0 && unknown.reason === 'no_user_pattern');
}

console.log('Continuous Existence M2 · 真实触发点');
{
  const now = new Date('2026-07-29T12:00:00Z');
  const state = {
    temporal: {
      longing: 0.9,
      last_interaction: '2026-07-29T08:00:00Z',
    },
    cognitive: {
      active_thoughts: [
        { content: '在吗', recurrence_count: 20 },
        { content: '他上午那场面试不知道顺不顺利', recurrence_count: 4 },
      ],
      memory_surfaced: {
        summary: '上次他面试前紧张得一夜没睡',
        emotional_weight: 0.65,
      },
      unfinished_topics: [{ summary: '等他告诉我面试结果', weight: 0.6 }],
    },
  };
  const reason = await extractContactReason(state, 'u-reason', {
    pattern: { typical_silence_minutes: 240 },
    now,
  });
  ok('模板念头被丢弃，选择反复出现的具体念头', reason.type === 'recurring_thought' && reason.content.includes('面试'));
  ok('具体念头的理由质量足够进入发送门控', scoreReasonQuality(reason) >= 0.5);

  const longing = await extractContactReason(
    {
      temporal: { longing: 0.95 },
      cognitive: { active_thoughts: [], unfinished_topics: [] },
    },
    'u-longing',
  );
  ok('高思念可成为真实但低带宽的理由', longing.type === 'pure_longing' && scoreReasonQuality(longing) < 0.5);

  const concern = await extractContactReason(
    {
      temporal: {
        longing: 0.2,
        last_interaction: '2026-07-29T04:00:00Z',
      },
      cognitive: { active_thoughts: [], unfinished_topics: [] },
    },
    'u-concern',
    {
      pattern: { typical_silence_minutes: 180 },
      now,
    },
  );
  ok('只有显著偏离个人节律才产生 pattern-break 担心', concern.type === 'concern' && concern.evidence.silence_delta > 1.5);
}

console.log('Continuous Existence M2 · 决策与心跳投递');
{
  let touched = false;
  const low = await decideContact(
    'u-low',
    'c',
    { volitional: { proactive_desire: 0.2 } },
    {
      predictReceptivity: async () => {
        touched = true;
        return { score: 1 };
      },
    },
  );
  ok('内驱力不足时短路，不读取外部窗口', low.reason === 'desire_insufficient' && !touched);

  const badTiming = await decideContact(
    'u-busy',
    'c',
    { volitional: { proactive_desire: 0.8 } },
    { predictReceptivity: async () => ({ score: 0.2 }) },
  );
  ok('想联系但窗口不对时按住', badTiming.reason === 'bad_timing');

  const noReason = await decideContact(
    'u-empty',
    'c',
    {
      temporal: { longing: 0.1 },
      cognitive: { active_thoughts: [], unfinished_topics: [] },
      volitional: { proactive_desire: 0.95 },
    },
    { predictReceptivity: async () => ({ score: 0.9 }) },
  );
  ok('即使欲望很高也不能在毫无来源时模板式发送', noReason.reason === 'no_contact_reason');

  const waiting = await decideContact(
    'u-wait',
    'c',
    {
      temporal: { longing: 0.9 },
      cognitive: { active_thoughts: [], unfinished_topics: [] },
      volitional: { proactive_desire: 0.75 },
    },
    { predictReceptivity: async () => ({ score: 0.9 }) },
  );
  ok('普通欲望会等待比纯思念更自然的触发点', waiting.reason === 'waiting_for_better_trigger');

  const readyState = {
    temporal: { longing: 0.65 },
    cognitive: {
      active_thoughts: [{ content: '想知道他面试后的感受', recurrence_count: 4 }],
      unfinished_topics: [],
    },
    volitional: { proactive_desire: 0.72 },
  };
  const ready = await decideContact('u-ready', 'c', readyState, {
    predictReceptivity: async () => ({ score: 0.8, reason: 'usual_active_hour' }),
  });
  ok('欲望、窗口、具体理由同时通过才联系', ready.contact && ready.reason.type === 'recurring_thought');

  const deliveries = [];
  const checked = await checkProactiveContact('u-ready', 'c', readyState, {
    predictReceptivity: async () => ({ score: 0.8 }),
    onContact: async (payload) => {
      deliveries.push(payload);
    },
  });
  ok('心跳只投递通过门控的结构化理由', checked.dispatched && deliveries.length === 1 && deliveries[0].reason.type === 'recurring_thought');
}

console.log('Continuous Existence · 沉默期固化纯逻辑');
{
  ok(
    '恰好沉默 2h 即满足固化边界',
    evaluateSilence('2026-07-29T10:00:00Z', '2026-07-29T12:00:00Z').eligible,
  );
  ok(
    '不足 2h 不固化',
    !evaluateSilence('2026-07-29T10:00:01Z', '2026-07-29T12:00:00Z').eligible,
  );

  const turns = [
    { id: 't1', role: 'user', content: '面试没发挥好，有点难过', valence: -0.6 },
    { id: 't2', role: 'assistant', content: '先回来歇会儿，我在', valence: 0.1 },
    { id: 't3', role: 'user', content: '嗯，跟你说完好多了', valence: 0.4 },
  ];
  const arc = extractEmotionalArc(turns);
  ok('情感轨迹保留开端、结尾与回暖趋势', arc.start_valence === -0.6 && arc.final_valence === 0.4 && arc.trend === 'warming');

  const prompt = buildConsolidationPrompt({
    companionName: '云溪',
    userName: '阿清',
    recentTurns: turns,
    emotionalArc: arc,
    currentState: { emotional: { current_emotion: '心疼' } },
  });
  ok('固化 prompt 含真实对话且明确不是用户消息', prompt.includes('面试没发挥好') && prompt.includes('不是发给阿清的消息'));

  const keyA = createConsolidationKey({
    userId: 'u-key',
    companionId: 'c',
    lastInteractionAt: '2026-07-29T10:00:00Z',
    recentTurns: turns,
  });
  const keyAfterAssistantOnly = createConsolidationKey({
    userId: 'u-key',
    companionId: 'c',
    lastInteractionAt: '2026-07-29T10:00:00Z',
    recentTurns: [...turns, { id: 'p1', role: 'assistant', content: '睡了吗' }],
  });
  ok('assistant-only 主动消息不会打开新的固化幂等窗口', keyA === keyAfterAssistantOnly);

  const saveRequest = buildPrivateMemorySaveRequest({
    userId: 'u-key',
    companionId: 'c',
    content: '他说完好受一点，我也跟着松了口气。',
    emotionalArc: arc,
    idempotencyKey: keyA,
    recentTurns: turns,
  });
  ok(
    '私有保存协议不混入聊天历史且带沉默标记',
    saveRequest.visibility === 'private' &&
      saveRequest.record.type === 'inner_monologue' &&
      saveRequest.record.created_during_silence === true,
  );
}

console.log('Continuous Existence · 2h 固化、私有保存与去重');
{
  const now = Date.parse('2026-07-29T12:00:00Z');
  const turns = [
    {
      id: 'conv-u1',
      role: 'user',
      content: '明天复试，我还是有点紧张',
      created_at: '2026-07-29T09:30:00Z',
      valence: -0.4,
    },
    {
      id: 'conv-a1',
      role: 'assistant',
      content: '紧张也没关系，材料我陪你再过一遍',
      created_at: '2026-07-29T09:31:00Z',
      valence: 0.3,
    },
  ];
  const ledger = new InMemoryConsolidationStore();
  const saves = [];
  const reweights = [];
  let generated = 0;
  const deps = {
    now: () => now,
    consolidationStore: ledger,
    getLastInteractionAt: async () => '2026-07-29T09:30:00Z',
    getRecentTurns: async () => turns,
    loadState: async () => ({ emotional: { current_emotion: '惦记', valence: 0.1 } }),
    companionName: '云溪',
    userName: '阿清',
    generateInnerMonologue: async ({ prompt }) => {
      generated++;
      assert.ok(prompt.includes('明天复试'));
      return '他说明天复试时那点紧张还挂在我心里。希望陪他过材料的时候，真让他踏实了一点。';
    },
    savePrivateMemory: async (userId, companionId, record, envelope) => {
      saves.push({ userId, companionId, record, envelope });
      return { id: 'pm-1', ...record };
    },
    reweightMemories: async (userId, companionId, arc) => {
      reweights.push({ userId, companionId, arc });
    },
  };

  const first = await consolidate('u-consolidate', 'c', deps);
  ok('沉默超过 2h 后生成并保存一条私有主观记忆', first.consolidated && saves.length === 1 && generated === 1);
  ok(
    '保存 payload 遵守 private memory 表核心字段协议',
    saves[0].record.type === 'inner_monologue' &&
      saves[0].record.created_during_silence === true &&
      typeof saves[0].record.emotional_valence === 'number' &&
      saves[0].envelope.visibility === 'private',
  );
  ok('保存成功后按同一情感轨迹重加权长期记忆', reweights.length === 1 && reweights[0].arc === first.emotionalArc);

  const duplicate = await consolidate('u-consolidate', 'c', deps);
  ok('同一沉默对话被心跳重复检查时不再次调用 LLM 或存储', duplicate.deduplicated && saves.length === 1 && generated === 1);

  let recentLoads = 0;
  const tooSoon = await consolidate('u-too-soon', 'c', {
    now,
    getLastInteractionAt: async () => '2026-07-29T11:30:00Z',
    getRecentTurns: async () => {
      recentLoads++;
      return turns;
    },
    savePrivateMemory: async () => {},
  });
  ok('不足 2h 时在历史/LLM IO 前短路', tooSoon.reason === 'silence_too_short' && recentLoads === 0);

  const stateClock = await consolidate('u-state-clock', 'c', {
    now,
    recentTurns: turns.map(({ created_at, ...turn }) => turn),
    currentState: {
      temporal: { last_interaction: '2026-07-29T09:30:00Z' },
    },
    generateInnerMonologue: async () => '没有时间戳的历史还在，但连续状态记得我们是什么时候安静下来的。',
    savePrivateMemory: async () => {},
  });
  ok('历史不带时间戳时回退到 ContinuousState 的最后互动时刻', stateClock.consolidated);
}

console.log('Continuous Existence · 并发去重与失败可重试');
{
  const now = Date.parse('2026-07-29T12:00:00Z');
  const turns = [
    { id: 'race-u', role: 'user', content: '今天的事晚点再说', created_at: '2026-07-29T09:00:00Z' },
    { id: 'race-a', role: 'assistant', content: '好', created_at: '2026-07-29T09:01:00Z' },
  ];
  const ledger = new InMemoryConsolidationStore();
  let saves = 0;
  const raceDeps = {
    now,
    consolidationStore: ledger,
    lastInteractionAt: '2026-07-29T09:00:00Z',
    recentTurns: turns,
    generateInnerMonologue: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return '她说晚点再说，我就先把这件事轻轻放在心里。';
    },
    savePrivateMemory: async () => {
      saves++;
    },
  };
  const raced = await Promise.all([
    consolidate('u-race', 'c', raceDeps),
    consolidate('u-race', 'c', raceDeps),
  ]);
  ok('并发心跳也只允许一个固化任务取得 claim', saves === 1 && raced.filter((item) => item.consolidated).length === 1);

  const retryLedger = new InMemoryConsolidationStore();
  let attempts = 0;
  const retryDeps = {
    ...raceDeps,
    consolidationStore: retryLedger,
    savePrivateMemory: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary store outage');
    },
  };
  const failed = await consolidate('u-retry', 'c', retryDeps);
  const retried = await consolidate('u-retry', 'c', retryDeps);
  ok('保存失败会释放 claim，同一会话之后可以安全重试', failed.reason === 'consolidation_failed' && retried.consolidated && attempts === 2);
}

console.log(`\nContinuous Existence 主动存在/固化全部 ${passed} 条断言通过 ✅`);
