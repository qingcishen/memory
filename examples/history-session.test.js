// 会话线持久化 + 聊天日志导入回放
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalJsonHistoryStore } from '../src/orchestrator/historyStore.js';
import {
  emptySessionThread,
  updateSessionThread,
  normalizeSessionThread,
  serializeSessionThread,
  rebuildSessionThreadFromHistory,
} from '../src/companion/sessionThread.js';
import {
  parseChatLog,
  parsePlainTextLog,
  loadChatLogFile,
  replayChatLog,
  formatReplayReport,
} from '../src/companion/chatLogImport.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('LocalJsonHistoryStore session + chat migrate');
{
  const file = path.join(os.tmpdir(), `mem-hist-${Date.now()}.json`);
  const store = new LocalJsonHistoryStore({ file, maxTurnsPerChat: 20 });
  await store.append({
    userId: 'u1',
    companionId: 'c1',
    turns: [
      { role: 'user', content: '周末你有空吗？' },
      { role: 'assistant', content: '有' },
    ],
  });
  const hist = await store.load({ userId: 'u1', companionId: 'c1', limit: 10 });
  ok('load history', hist.length === 2 && hist[0].role === 'user');

  let thread = updateSessionThread(null, {
    userMessage: '周末你有空吗？',
    reply: '有，周六可以',
    now: Date.now(),
  });
  await store.saveSessionThread({ userId: 'u1', companionId: 'c1', thread: serializeSessionThread(thread) });
  const loaded = await store.loadSessionThread({ userId: 'u1', companionId: 'c1' });
  ok('load session thread', loaded && loaded.turnCount >= 1);
  ok('normalize ok', normalizeSessionThread(loaded).turnCount >= 1);

  // 旧格式兼容：顶层 key 数组
  const legacyFile = path.join(os.tmpdir(), `mem-hist-legacy-${Date.now()}.json`);
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({ 'u2::c2': [{ role: 'user', content: 'hi', created_at: new Date().toISOString() }] }),
  );
  const legacy = new LocalJsonHistoryStore({ file: legacyFile });
  const h2 = await legacy.load({ userId: 'u2', companionId: 'c2' });
  ok('legacy chat load', h2.length === 1 && h2[0].content === 'hi');
  await legacy.saveSessionThread({
    userId: 'u2',
    companionId: 'c2',
    thread: emptySessionThread(),
  });
  const raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  ok('migrate writes chats+sessions', raw.chats && raw.sessions);

  try {
    fs.unlinkSync(file);
    fs.unlinkSync(legacyFile);
  } catch {
    /* ignore */
  }
}

console.log('rebuild from history');
{
  const history = [
    { role: 'user', content: '加班到好晚' },
    { role: 'assistant', content: '辛苦了' },
    { role: 'user', content: '老板又甩锅' },
    { role: 'assistant', content: '别扛' },
  ];
  const t = rebuildSessionThreadFromHistory(history);
  ok('rebuild turnCount', t.turnCount === 2);
  ok('rebuild work topic', t.primaryTopic === '工作');
}

console.log('chat log import');
{
  const plain = parsePlainTextLog('我: 在吗\n她: 嗯\n我: 周末你有空吗？\n她: 有');
  ok('plain pairs', plain.length === 4 && plain[0].role === 'user');

  const jsonl = parseChatLog(`{"role":"user","content":"嗨"}\n{"role":"assistant","content":"嗯"}`);
  ok('jsonl', jsonl.length === 2);

  const pairs = parseChatLog([
    { user: '想你了', assistant: '我也是' },
    { user: '发张照片我看看你', assistant: '等一下' },
  ]);
  ok('pair objects', pairs.filter((t) => t.role === 'user').length === 2);

  const fixture = path.join(__dirname, 'eval/fixtures/sample-chat.jsonl');
  const fromFile = loadChatLogFile(fixture);
  ok('fixture jsonl load', fromFile.length >= 6);

  const txt = loadChatLogFile(path.join(__dirname, 'eval/fixtures/sample-chat.txt'), {
    userAliases: ['我'],
    assistantAliases: ['她'],
  });
  ok('fixture txt travel', txt.some((t) => t.content.includes('杭州')));

  const replay = replayChatLog(fromFile);
  ok('replay pairs', replay.summary.turnPairs >= 3);
  ok('replay has report', formatReplayReport(replay).includes('回放完成'));
  ok('replay open or topics', replay.summary.topics?.length >= 1 || replay.summary.primaryTopic);

  const travelReplay = replayChatLog(txt);
  ok('travel primary', travelReplay.summary.primaryTopic === '出行' || travelReplay.summary.topics.includes('出行'));
}

console.log('Orchestrator persists session via historyStore');
{
  const file = path.join(os.tmpdir(), `mem-orch-sess-${Date.now()}.json`);
  const historyStore = new LocalJsonHistoryStore({ file });
  const deps = {
    historyStore,
    memory: {
      async recall() {
        return '';
      },
      async observe() {},
      async checkProspective() {
        return [];
      },
    },
    stateLayer: {
      async snapshot() {
        return { mood: { valence: 0.1 }, life: { energy: 0.5 }, desires: {} };
      },
      toPrompt: () => '状态',
      samplingHints: () => ({ temperature: 0.8 }),
      async evolve() {},
    },
    relationship: {
      async current() {
        return { closeness: 0.7, trust: 0.6, tension: 0.1, repair_debt: 0 };
      },
      toPrompt: () => '关系',
      async bump() {},
    },
    persona: {
      toPrompt: () => '人设',
      async load() {},
    },
    llm: {
      async think() {
        return '';
      },
      async generateReply() {
        return '嗯，周六可以';
      },
    },
  };
  const orch = new Orchestrator({ userId: 'u_sess', companionId: 'c_sess', deps, options: { historyTurns: 4, useMonologue: false } });
  await orch.reply('周末你有空吗？');
  if (orch._lastSessionPersist) await orch._lastSessionPersist;
  if (orch._lastHistoryPersist) await orch._lastHistoryPersist;

  const snap = await historyStore.loadSessionThread({ userId: 'u_sess', companionId: 'c_sess' });
  ok('orch saved session', snap && (snap.turnCount >= 1 || snap.openQuestions?.length >= 0));

  // 模拟重启：新实例 loadHistory 应带回会话线
  const orch2 = new Orchestrator({ userId: 'u_sess', companionId: 'c_sess', deps, options: { historyTurns: 4, useMonologue: false } });
  await orch2.init();
  ok(
    'restart loads session or rebuilds',
    orch2._sessionThread?.turnCount >= 1 || orch2.history.length >= 1,
  );

  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

console.log(`\nhistory-session 全部 ${passed} 条断言通过 ✅`);
