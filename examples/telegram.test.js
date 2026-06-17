// Telegram bot 纯函数测试 (不连网, 不碰 Telegram API)。
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalJsonHistoryStore } from '../src/orchestrator/historyStore.js';
import { parseAllowedChatIds, isAllowedChat, telegramUserId, chunkMessage } from '../src/telegram/bot.js';

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

  // P1 分级主动性: lastUserMessageAt 供 ProactiveScheduler 判断"对方多久没说话了"。
  const lastAt = await store.lastUserMessageAt({ userId: 'telegram:1', companionId: 'default' });
  ok('lastUserMessageAt 返回最近一条用户消息的时间', typeof lastAt === 'string' && !Number.isNaN(new Date(lastAt).getTime()));
  const noHistory = await store.lastUserMessageAt({ userId: 'telegram:3', companionId: 'default' });
  ok('没有历史 → lastUserMessageAt 返回 null', noHistory === null);

  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\nTelegram bot 全部 ${passed} 条断言通过`);
