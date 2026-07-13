// Telegram bot 纯函数测试 (不连网, 不碰 Telegram API)。
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalJsonHistoryStore } from '../src/orchestrator/historyStore.js';
import { TelegramMemoryBot, parseAllowedChatIds, isAllowedChat, telegramUserId, chunkMessage, buildOutgoingMessages, ensureReplyParts, typingDelayMs, parseDataUrl, pickPolicyDelay, applyPartsBudget, simulateBehaviorDelay, startTypingHeartbeat, pollRetryDelayMs } from '../src/telegram/bot.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('parseAllowedChatIds / isAllowedChat (白名单)');
{
  const set = parseAllowedChatIds('123, 456 , ,789');
  ok('解析逗号分隔并去空', set.size === 3 && set.has('123') && set.has('789'));
  ok('空配置 → 空集合', parseAllowedChatIds('').size === 0 && parseAllowedChatIds(undefined).size === 0);
  ok('空集合 = 允许所有', isAllowedChat(999, new Set()) === true);
  ok('在白名单内 → 允许', isAllowedChat(123, set) === true);
  ok('不在白名单 → 拒绝', isAllowedChat(111, set) === false);
}

console.log('telegramUserId (每个 chat 独立记忆)');
{
  ok('chatId → telegram:<id>', telegramUserId(42) === 'telegram:42');
  ok('不同 chat 不同 userId', telegramUserId(1) !== telegramUserId(2));
}

console.log('chunkMessage (超长消息分片)');
{
  ok('短消息不分片', chunkMessage('你好').length === 1);
  const long = 'a'.repeat(8500);
  const chunks = chunkMessage(long);
  ok('超长按 3900 上限分片', chunks.length === 3 && chunks.every((c) => c.length <= 3900));
  ok('空消息给占位', chunkMessage('   ')[0] === '...');
  ok('分片后拼回原文', chunkMessage(long).join('') === long);

  // 切点正好落在 emoji (代理对) 中间: 不能劈出非法半字符
  const emojiAtBoundary = 'a'.repeat(3899) + '😊' + 'b'.repeat(10);
  const parts = chunkMessage(emojiAtBoundary);
  ok('emoji 不被劈成两半', parts.every((p) => !/[\uD800-\uDBFF]$/.test(p) && !/^[\uDC00-\uDFFF]/.test(p)));
  ok('emoji 分片后仍拼回原文', parts.join('') === emojiAtBoundary);
}

console.log('buildOutgoingMessages / typingDelayMs (parts -> Telegram 消息)');
{
  const out = buildOutgoingMessages([
    { type: 'narration', text: '她低头笑了一下。' },
    { type: 'dialogue', text: '（她靠过来很久很久）嗯，我在。' },
    { type: 'dialogue', text: '   ' },
  ]);
  ok('保留 narration/dialogue 顺序', out.length === 2 && out[0].type === 'narration' && out[1].type === 'dialogue');
  ok('dialogue 会清理长括号旁白', out[1].text === '嗯，我在。');
  ok('空 part 被跳过', out.every((m) => m.text));
  ok('typingDelayMs 有上下限', typingDelayMs('短') >= 600 && typingDelayMs('a'.repeat(1000)) <= 4000);
}

console.log('pollRetryDelayMs (轮询失败退避, 代理/网络抖动时别刷爆日志和连接)');
{
  ok('退避指数增长', pollRetryDelayMs(1) < pollRetryDelayMs(2) && pollRetryDelayMs(2) < pollRetryDelayMs(3));
  ok('退避有上限', pollRetryDelayMs(100) === 60000);
  ok('第 1 次退避等于 base', pollRetryDelayMs(1) === 3000);
  ok('0 次和 1 次一样 (至少退避一次)', pollRetryDelayMs(0) === pollRetryDelayMs(1));
}

console.log('ensureReplyParts (结构化 parts 为空时不静默)');
{
  const existing = [{ type: 'dialogue', text: '原结构' }];
  ok('已有 parts 原样保留', ensureReplyParts('回退文字', existing) === existing);
  ok('parts 为空时使用 reply text', ensureReplyParts('  兜底回复  ', [])[0]?.text === '兜底回复');
  ok('reply 也为空时保持空数组', ensureReplyParts('', []).length === 0);
}

console.log('startTypingHeartbeat (生成期间持续显示正在输入)');
{
  const actions = [];
  let tick = null;
  let cleared = false;
  const stop = startTypingHeartbeat(
    { sendChatAction: async (chatId, action) => actions.push([chatId, action]) },
    42,
    { setIntervalFn: (fn) => { tick = fn; return 7; }, clearIntervalFn: (id) => { cleared = id === 7; } },
  );
  await Promise.resolve();
  tick();
  await Promise.resolve();
  ok('启动时立即发送 typing', actions[0]?.[0] === 42 && actions[0]?.[1] === 'typing');
  ok('定时续期 typing', actions.length === 2);
  stop();
  tick();
  await Promise.resolve();
  ok('停止后清理定时器且不再发送', cleared && actions.length === 2);
}

console.log('parseDataUrl (GPT Image base64 -> multipart 上传用的 buffer)');
{
  const png = parseDataUrl('data:image/png;base64,' + Buffer.from('fake-png').toString('base64'));
  ok('合法 data URL 解析出 mime + buffer', png.mime === 'image/png' && png.buffer.toString() === 'fake-png');
  const webp = parseDataUrl('data:image/webp;base64,' + Buffer.from('x').toString('base64'));
  ok('webp mime 保留', webp.mime === 'image/webp');
  ok('公网 URL 不是 data URL', parseDataUrl('https://example.com/a.png') === null);
  ok('mock 地址返回 null', parseDataUrl('mock://selfie/abc.png') === null);
  ok('空串/空 base64 返回 null', parseDataUrl('') === null && parseDataUrl('data:image/png;base64,') === null);
}

console.log('B3 behavior delivery helpers');
{
  ok('策略延迟可确定取最小/最大值', pickPolicyDelay({ replyDelayMs: [1000, 5000] }, () => 0) === 1000 && pickPolicyDelay({ replyDelayMs: [1000, 5000] }, () => 1) === 5000);
  const limited = applyPartsBudget([{ type: 'narration', text: '她抬眼。' }, { type: 'dialogue', text: '一' }, { type: 'dialogue', text: '二' }], 1);
  ok('partsBudget 只截台词并保留旁白', limited.length === 2 && limited[0].type === 'narration' && limited[1].text === '一');
  const actions = [], waits = [];
  await simulateBehaviorDelay({ sendChatAction: async (_id, action) => actions.push(action) }, 1, 7000, async (ms) => waits.push(ms));
  ok('延迟期间 typing 状态会闪烁', actions.length >= 2 && actions.every((a) => a === 'typing'));
  ok('模拟延迟总时长准确', waits.reduce((a, b) => a + b, 0) === 7000);
}

console.log('TelegramMemoryBot.deliverReply B3 完整发送/合并');
{
  const sent = [], saved = [], selfEvents = [];
  const api = { sendChatAction: async () => {}, sendMessage: async (_id, text) => sent.push(text) };
  const behaviorStore = { load: async () => ({ stonewallAt: [], mustGiveRepairStep: false }), save: async (state) => { saved.push(state); return state; } };
  const delivery = new TelegramMemoryBot({ api, behaviorStore, sleepFn: async () => {}, rng: () => 0, personaFile: '/not-found.json' });
  const memoryBot = { memory: { recordSelfEvent: async (text) => selfEvents.push(text) } };
  const stonewalled = await delivery.deliverReply(42, [{ type: 'dialogue', text: '不发出去' }], {
    policy: { replyDelayMs: [0, 0], partsBudget: 1, stonewall: true }, behaviorState: { stonewallAt: [], mustGiveRepairStep: false }, bot: memoryBot,
  });
  ok('stonewall 标记也不再阻断回复', stonewalled.length === 1 && sent.join('') === '不发出去' && selfEvents.length === 0);

  await delivery.deliverReply(42, [{ type: 'dialogue', text: '给你一个台阶' }, { type: 'dialogue', text: '多余第二条' }], {
    policy: { replyDelayMs: [0, 0], partsBudget: 1, stonewall: false }, behaviorState: saved.at(-1), bot: memoryBot,
  });
  // 默认多气泡连发（非 MERGE=1）；两条台词都会发出
  ok(
    '下一轮完整发送全部台词（多气泡）',
    sent.includes('给你一个台阶') && sent.includes('多余第二条'),
  );
  ok('正常回复后清除强制台阶标志', saved.length === 0);
}

console.log('LocalJsonHistoryStore (本地短期历史持久化)');
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-history-'));
  const file = path.join(dir, 'history.json');
  const store = new LocalJsonHistoryStore({ file, maxTurnsPerChat: 3 });
  await store.append({
    userId: 'telegram:1',
    companionId: 'default',
    turns: [
      { role: 'user', content: '我今天请假了' },
      { role: 'assistant', content: '记住了, 你今天在家陪我' },
      { role: 'user', content: '我在家' },
      { role: 'assistant', content: '嗯, 你在家' },
    ],
  });
  await store.append({ userId: 'telegram:2', companionId: 'default', turns: [{ role: 'user', content: '另一个 chat' }] });
  const loaded = await new LocalJsonHistoryStore({ file, maxTurnsPerChat: 3 }).load({
    userId: 'telegram:1',
    companionId: 'default',
    limit: 10,
  });
  ok('重启后能读回本地历史', loaded.length === 3);
  ok('按最大条数裁剪最近历史', loaded[0].content === '记住了, 你今天在家陪我' && loaded.at(-1).content === '嗯, 你在家');
  const other = await store.load({ userId: 'telegram:2', companionId: 'default', limit: 10 });
  ok('不同 chat 历史隔离', other.length === 1 && other[0].content === '另一个 chat');
  const eventTurn = { userId: 'telegram:3', companionId: 'default', eventId: 'telegram:99', turns: [{ role: 'user', content: '幂等消息' }] };
  await store.append(eventTurn);
  await store.append(eventTurn);
  const idempotent = await store.load({ userId: 'telegram:3', companionId: 'default', limit: 10 });
  ok('相同 eventId + role 不重复写本地历史', idempotent.length === 1);

  // P1 分级主动性: lastUserMessageAt 供 ProactiveScheduler 判断"对方多久没说话了"。
  const lastAt = await store.lastUserMessageAt({ userId: 'telegram:1', companionId: 'default' });
  ok('lastUserMessageAt 返回最近一条用户消息的时间', typeof lastAt === 'string' && !Number.isNaN(new Date(lastAt).getTime()));
  const noHistory = await store.lastUserMessageAt({ userId: 'telegram:4', companionId: 'default' });
  ok('没有历史 → lastUserMessageAt 返回 null', noHistory === null);

  // 一次写盘失败不能毒化锁链: 失败后下一次 append 仍要能正常落盘
  const originalWrite = store.write.bind(store);
  store.write = async () => { throw new Error('disk full'); };
  await store.append({ userId: 'telegram:1', companionId: 'default', turns: [{ role: 'user', content: '这条会失败' }] }).catch(() => {});
  store.write = originalWrite;
  await store.append({ userId: 'telegram:1', companionId: 'default', turns: [{ role: 'user', content: '失败后还能存' }] });
  const afterFailure = await store.load({ userId: 'telegram:1', companionId: 'default', limit: 10 });
  ok('写失败后锁链恢复, 后续 append 正常', afterFailure.at(-1).content === '失败后还能存');

  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\nTelegram bot 全部 ${passed} 条断言通过`);
