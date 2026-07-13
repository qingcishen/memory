/**
 * 真实聊天日志导入 · 解析多种格式为统一 turns，供无 LLM 回放评测。
 *
 * 支持：
 * - JSON 数组：[{role,content}] | [{user,assistant}] | [{from,text}]
 * - JSONL：每行一条
 * - 纯文本：User:/Assistant:、我:/她:、A:/B: 前缀
 * - Telegram 导出风格粗解析（"Name, date\ntext"）
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  emptySessionThread,
  updateSessionThread,
  detectSessionDrift,
  sessionThreadToPrompt,
} from './sessionThread.js';
import { detectSceneLocks, detectNonSequitur } from './sceneCoherence.js';
import { planStructuredHeuristic } from '../orchestrator/structuredPlan.js';
import { buildConversationGoals } from '../orchestrator/goals.js';
import { sessionHooksToUnfinished } from './sessionThread.js';

/**
 * @returns {{ role: 'user'|'assistant', content: string }[]}
 */
export function parseChatLog(input, { userAliases = [], assistantAliases = [] } = {}) {
  if (input == null) return [];
  if (Array.isArray(input)) return normalizeTurnList(input, { userAliases, assistantAliases });

  const text = String(input).trim();
  if (!text) return [];

  // JSON 整包
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) return normalizeTurnList(data, { userAliases, assistantAliases });
      if (Array.isArray(data.messages)) return normalizeTurnList(data.messages, { userAliases, assistantAliases });
      if (Array.isArray(data.turns)) return normalizeTurnList(data.turns, { userAliases, assistantAliases });
      if (Array.isArray(data.history)) return normalizeTurnList(data.history, { userAliases, assistantAliases });
    } catch {
      /* fall through */
    }
  }

  // JSONL
  if (text.includes('\n') && text.split('\n').every((line) => !line.trim() || line.trim().startsWith('{'))) {
    const rows = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        rows.push(JSON.parse(s));
      } catch {
        /* skip bad line */
      }
    }
    if (rows.length) return normalizeTurnList(rows, { userAliases, assistantAliases });
  }

  return parsePlainTextLog(text, { userAliases, assistantAliases });
}

export function normalizeTurnList(list = [], { userAliases = [], assistantAliases = [] } = {}) {
  const out = [];
  const userSet = new Set(['user', 'human', 'me', '我', '对方', ...userAliases.map(String)]);
  const herSet = new Set(['assistant', 'ai', 'bot', 'her', 'she', '她', '可可', '小忆', ...assistantAliases.map(String)]);

  for (const item of list) {
    if (!item) continue;
    // pair form {user, assistant}
    if (item.user != null || item.assistant != null) {
      if (item.user != null && String(item.user).trim()) out.push({ role: 'user', content: String(item.user).trim() });
      if (item.assistant != null && String(item.assistant).trim()) {
        out.push({ role: 'assistant', content: String(item.assistant).trim() });
      }
      continue;
    }
    const roleRaw = String(item.role || item.from || item.sender || item.author || '').toLowerCase();
    const content = item.content ?? item.text ?? item.message ?? item.body;
    if (content == null || !String(content).trim()) continue;
    let role = null;
    if (userSet.has(roleRaw) || roleRaw === 'u') role = 'user';
    else if (herSet.has(roleRaw) || roleRaw === 'a') role = 'assistant';
    else if (item.role === 'user' || item.role === 'assistant') role = item.role;
    if (!role) continue;
    out.push({ role, content: String(content).trim() });
  }
  return out;
}

export function parsePlainTextLog(text = '', { userAliases = [], assistantAliases = [] } = {}) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  const userNames = ['user', '我', '对方', '人类', ...userAliases].map((s) => s.toLowerCase());
  const herNames = ['assistant', '她', 'ai', 'bot', '可可', '小忆', ...assistantAliases].map((s) => s.toLowerCase());

  let cur = null;
  const flush = () => {
    if (cur?.content?.trim()) out.push({ role: cur.role, content: cur.content.trim() });
    cur = null;
  };

  for (const line of lines) {
    const m = line.match(/^\s*([^\s:：]{1,20})\s*[:：]\s*(.*)$/);
    if (m) {
      const name = m[1].toLowerCase();
      const rest = m[2] || '';
      let role = null;
      if (userNames.includes(name) || /^u(ser)?$/i.test(m[1])) role = 'user';
      if (herNames.includes(name) || /^a(ssistant)?$/i.test(m[1])) role = 'assistant';
      if (role) {
        flush();
        cur = { role, content: rest };
        continue;
      }
    }
    // 续行
    if (cur) cur.content += (cur.content ? '\n' : '') + line;
  }
  flush();
  return out;
}

/**
 * 从文件路径读入并解析
 */
export function loadChatLogFile(filePath, opts = {}) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  return parseChatLog(raw, opts);
}

/**
 * 无 LLM 回放：会话线 + 场景锁 + 结构化计划 + 连贯/漂移
 * @returns {{ turns, thread, events, summary }}
 */
export function replayChatLog(turnsInput, opts = {}) {
  const turns = Array.isArray(turnsInput) ? turnsInput : parseChatLog(turnsInput, opts);
  let thread = emptySessionThread(opts.now ?? Date.now());
  const history = [];
  const events = [];
  let driftCount = 0;
  let nonSeqCount = 0;
  let wantPhotoCount = 0;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== 'user') continue;
    const userMessage = t.content;
    const next = turns[i + 1];
    const reply = next?.role === 'assistant' ? next.content : '';
    const locks = detectSceneLocks(userMessage, history, opts.intimacyPhase ?? null);
    const unfinished = sessionHooksToUnfinished(thread);
    const goals = buildConversationGoals({
      desires: opts.desires || {},
      storyBeat: opts.storyBeat || null,
      unfinished,
      userMessage,
      sceneLocks: locks,
    });
    const structured = planStructuredHeuristic({
      userMessage,
      sceneLocks: locks,
      goals,
      behavior: opts.behavior || { lengthHint: 'normal', partsBudget: 2 },
      unfinished,
      storyBeat: opts.storyBeat,
      intimacyPhase: opts.intimacyPhase,
    });
    if (structured.wantPhoto) wantPhotoCount++;

    thread = updateSessionThread(thread, {
      userMessage,
      reply,
      sceneLocks: locks,
      now: (opts.now ?? Date.now()) + i * 60_000,
    });

    let nonSeq = { bad: false, reasons: [] };
    let drift = { drift: false, reasons: [] };
    if (reply) {
      nonSeq = detectNonSequitur(reply, locks);
      drift = detectSessionDrift(reply, thread);
      if (nonSeq.bad) nonSeqCount++;
      if (drift.drift) driftCount++;
    }

    events.push({
      index: events.length,
      userMessage,
      reply,
      locks: locks.map((l) => l.id),
      structured: {
        attitude: structured.attitude,
        wantPhoto: structured.wantPhoto,
        mentionStory: structured.mentionStory,
      },
      primaryTopic: thread.primaryTopic,
      nonSequitur: nonSeq.bad ? nonSeq.reasons : [],
      sessionDrift: drift.drift ? drift.reasons : [],
    });

    history.push({ role: 'user', content: userMessage });
    if (reply) history.push({ role: 'assistant', content: reply });
  }

  const summary = {
    turnPairs: events.length,
    primaryTopic: thread.primaryTopic,
    topics: thread.topics,
    openQuestions: thread.openQuestions.map((q) => q.text),
    openCommitments: thread.commitments.filter((c) => c.status === 'open').map((c) => c.text),
    emotionalTone: thread.emotionalTone,
    driftCount,
    nonSequiturCount: nonSeqCount,
    wantPhotoCount,
    sessionPrompt: sessionThreadToPrompt(thread),
  };

  return { turns, thread, events, summary };
}

/**
 * 把回放结果格式化成可读报告
 */
export function formatReplayReport({ summary, events } = {}) {
  if (!summary) return '';
  const lines = [
    `回放完成：${summary.turnPairs} 轮`,
    `主话题：${summary.primaryTopic || '-'}（${(summary.topics || []).join('、') || '-'}）`,
    `情绪基调：${summary.emotionalTone}`,
    `开放问题：${summary.openQuestions?.length || 0} · 约定：${summary.openCommitments?.length || 0}`,
    `跳戏/非连贯：${summary.nonSequiturCount} · 会话漂移：${summary.driftCount} · 要图：${summary.wantPhotoCount}`,
  ];
  const flagged = (events || []).filter((e) => e.nonSequitur?.length || e.sessionDrift?.length);
  if (flagged.length) {
    lines.push('问题轮：');
    for (const e of flagged.slice(0, 8)) {
      lines.push(
        `  #${e.index + 1} user「${String(e.userMessage).slice(0, 24)}」→ ${[...(e.nonSequitur || []), ...(e.sessionDrift || [])].join('; ')}`,
      );
    }
  }
  return lines.join('\n');
}
