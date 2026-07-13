/**
 * 会话线 SessionThread · 本场跨轮状态（纯逻辑，可单测）
 *
 * 解决：单轮 plan 再强，也容易「换一句就换频道」。
 * 维护：主话题 / 对方未答完的问题 / 双方承诺 / 情绪基调。
 * 注入：【本场在聊】—— 接话优先顺着本场主线，不查岗、不念清单。
 */

import { detectEpisodeTopics } from './episode.js';
import { sanitizeForPrompt } from '../promptSafety.js';

const MAX_TOPICS = 4;
const MAX_QUESTIONS = 3;
const MAX_COMMITMENTS = 4;
const SESSION_IDLE_MS = 4 * 60 * 60 * 1000; // 与编排器清历史同档

export function emptySessionThread(now = Date.now()) {
  return {
    startedAt: now,
    updatedAt: now,
    turnCount: 0,
    topics: [],
    primaryTopic: null,
    openQuestions: [],
    commitments: [],
    lastUserFocus: '',
    emotionalTone: 'neutral',
  };
}

/**
 * 长时间沉默 → 新会话
 */
export function shouldResetSession(thread, now = Date.now(), idleMs = SESSION_IDLE_MS) {
  if (!thread?.updatedAt) return true;
  return now - Number(thread.updatedAt) >= idleMs;
}

/**
 * 从用户句抽「还在等答案」的开放问题
 */
export function extractOpenQuestions(userMessage = '') {
  const c = String(userMessage || '').trim();
  if (c.length < 3 || c.length > 100) return [];
  if (/[?？]$|吗[。!！]?$|呢[。!！]?$|怎么样|如何|行不行|可不可以|有没有/.test(c)) {
    return [{ text: c.slice(0, 60), kind: 'question' }];
  }
  return [];
}

/**
 * 从文本抽承诺/约定（双方）
 * who: 'user' | 'her'
 */
export function extractCommitments(text = '', who = 'user') {
  const c = String(text || '').trim();
  if (c.length < 4) return [];
  const out = [];
  // 时间约定 / 答应 / 等下做
  const patterns = [
    /(?:我|咱们|我们)?(?:周末|明天|今晚|等下|待会|回头|下次)[^。！？\n]{0,24}(?:有空|去|来|陪|约|见|做|说|回|等)/,
    /(?:答应|说好|记得|别忘了|一定|必须)[^。！？\n]{2,30}/,
    /(?:周末|明天|今晚).{0,16}(?:可以|行|好的|等你|等我)/,
    /(?:等你|等我)(?:来|回家|一起)?/,
  ];
  for (const re of patterns) {
    const m = c.match(re);
    if (m) {
      out.push({
        who,
        text: sanitizeForPrompt(m[0]).slice(0, 48),
        kind: 'commitment',
      });
      break; // 一句最多一条，避免噪声
    }
  }
  return out;
}

/**
 * 用户这句是否在回应某个开放问题 / 兑现承诺（启发式消解）
 */
export function resolveAgainstHooks(hooks = [], userMessage = '') {
  const msg = String(userMessage || '');
  if (!msg || !hooks.length) return { remaining: hooks, resolved: [] };
  const remaining = [];
  const resolved = [];
  for (const h of hooks) {
    const key = String(h.text || '')
      .replace(/[?？。！!]/g, '')
      .slice(0, 8);
    // 关键词重叠或用户明确「好的/行/到了/搞定」且 hook 很短
    const overlap =
      key.length >= 2 &&
      key.split('').filter((ch) => msg.includes(ch)).length >= Math.min(3, key.length);
    const ack = /^(好|行|嗯|可以|没问题|到了|搞定|忘了|不行|算了)/.test(msg.trim());
    if (overlap || (ack && h.kind === 'commitment')) {
      resolved.push(h);
    } else {
      remaining.push(h);
    }
  }
  return { remaining, resolved };
}

function inferEmotionalTone(userMessage = '', sceneLocks = [], prev = 'neutral') {
  const msg = String(userMessage || '');
  if (sceneLocks.some((l) => l.id === 'conflict')) return 'tense';
  if (sceneLocks.some((l) => l.id === 'intimate')) return 'intimate';
  if (sceneLocks.some((l) => l.id === 'sick')) return 'soft';
  if (/(生气|吵架|不理|讨厌)/.test(msg)) return 'tense';
  if (/(想你|爱你|亲亲|抱抱)/.test(msg)) return 'warm';
  if (/(累|烦|加班|难受)/.test(msg)) return 'tired';
  return prev === 'intimate' && msg.length < 6 ? prev : prev === 'tense' && msg.length < 4 ? prev : 'neutral';
}

/**
 * 每轮更新会话线
 * @param thread 上一状态（可 null）
 * @param ctx {{ userMessage, reply?, sceneLocks?, now? }}
 */
export function updateSessionThread(thread = null, ctx = {}) {
  const now = ctx.now ?? Date.now();
  let t = thread && !shouldResetSession(thread, now) ? { ...thread } : emptySessionThread(now);
  t.openQuestions = [...(t.openQuestions || [])];
  t.commitments = [...(t.commitments || [])];
  t.topics = [...(t.topics || [])];

  const userMessage = String(ctx.userMessage || '');
  const reply = String(ctx.reply || '');
  const sceneLocks = ctx.sceneLocks || [];

  // 消解旧钩子
  const qRes = resolveAgainstHooks(t.openQuestions, userMessage);
  t.openQuestions = qRes.remaining;
  const cRes = resolveAgainstHooks(
    t.commitments.filter((c) => c.status !== 'done'),
    userMessage,
  );
  const stillOpen = new Set(cRes.remaining.map((c) => c.text));
  t.commitments = t.commitments.map((c) =>
    c.status === 'done' || stillOpen.has(c.text) ? c : { ...c, status: 'done', resolvedAt: now },
  );

  // 新开放问题
  for (const q of extractOpenQuestions(userMessage)) {
    if (!t.openQuestions.some((x) => x.text === q.text)) {
      t.openQuestions.push({ ...q, at: now, status: 'open' });
    }
  }
  t.openQuestions = t.openQuestions.slice(-MAX_QUESTIONS);

  // 新承诺
  for (const c of extractCommitments(userMessage, 'user')) {
    if (!t.commitments.some((x) => x.text === c.text && x.status !== 'done')) {
      t.commitments.push({ ...c, at: now, status: 'open' });
    }
  }
  if (reply) {
    for (const c of extractCommitments(reply, 'her')) {
      if (!t.commitments.some((x) => x.text === c.text && x.status !== 'done')) {
        t.commitments.push({ ...c, at: now, status: 'open' });
      }
    }
  }
  t.commitments = t.commitments
    .filter((c) => c.status === 'open' || now - (c.at || 0) < SESSION_IDLE_MS)
    .slice(-MAX_COMMITMENTS * 2)
    .slice(-MAX_COMMITMENTS - 2);

  // 话题滚动
  const blob = `${userMessage} ${reply}`;
  const detected = detectEpisodeTopics(blob);
  for (const topic of detected) {
    t.topics = [topic, ...t.topics.filter((x) => x !== topic)].slice(0, MAX_TOPICS);
  }
  // 场景锁抬升主话题
  if (sceneLocks.some((l) => l.id === 'intimate')) t.topics = ['亲密', ...t.topics.filter((x) => x !== '亲密')].slice(0, MAX_TOPICS);
  if (sceneLocks.some((l) => l.id === 'conflict')) t.topics = ['情绪冲突', ...t.topics.filter((x) => x !== '情绪冲突')].slice(0, MAX_TOPICS);
  if (sceneLocks.some((l) => l.id === 'work')) t.topics = ['工作', ...t.topics.filter((x) => x !== '工作')].slice(0, MAX_TOPICS);
  if (sceneLocks.some((l) => l.id === 'travel')) t.topics = ['出行', ...t.topics.filter((x) => x !== '出行')].slice(0, MAX_TOPICS);

  // 粘性：强场景（亲密/冲突/出行/身体）不被「日常饮食/闲聊」挤掉；出行中夹开会仍优先出行
  const sticky = new Set(['亲密', '情绪冲突', '出行', '身体']);
  const prevPrimary = thread?.primaryTopic;
  if (prevPrimary && sticky.has(prevPrimary)) {
    const top = t.topics[0];
    if (!top || !sticky.has(top) || (prevPrimary === '出行' && top === '工作' && t.topics.includes('出行'))) {
      t.topics = [prevPrimary, ...t.topics.filter((x) => x !== prevPrimary)].slice(0, MAX_TOPICS);
    }
  }

  t.primaryTopic = t.topics[0] || null;
  t.lastUserFocus = userMessage.slice(0, 48);
  t.emotionalTone = inferEmotionalTone(userMessage, sceneLocks, t.emotionalTone);
  t.turnCount = (t.turnCount || 0) + 1;
  t.updatedAt = now;
  return t;
}

/**
 * 注入 system 的【本场在聊】
 */
export function sessionThreadToPrompt(thread = null) {
  if (!thread || !thread.turnCount) return '';
  const lines = ['【本场在聊】'];
  if (thread.primaryTopic) {
    lines.push(`主线话题：${thread.primaryTopic}${thread.topics.length > 1 ? `（旁支：${thread.topics.slice(1).join('、')}）` : ''}。`);
  }
  if (thread.lastUserFocus) {
    lines.push(`对方刚在意的点：${sanitizeForPrompt(thread.lastUserFocus)}。`);
  }
  const openQ = (thread.openQuestions || []).filter((q) => q.status !== 'done').slice(0, 2);
  if (openQ.length) {
    lines.push(`对方还悬着的问题（别假装没看见，也别审讯）：${openQ.map((q) => q.text).join('；')}。`);
  }
  const openC = (thread.commitments || []).filter((c) => c.status === 'open').slice(0, 3);
  if (openC.length) {
    lines.push(
      `本场提过的约定（时机自然再提，别查岗）：${openC
        .map((c) => `${c.who === 'her' ? '你说过' : '对方提过'}「${c.text}」`)
        .join('；')}。`,
    );
  }
  if (thread.emotionalTone && thread.emotionalTone !== 'neutral') {
    const toneMap = { tense: '紧绷', intimate: '亲昵', soft: '放软', warm: '黏暖', tired: '有点累' };
    lines.push(`本场情绪基调偏「${toneMap[thread.emotionalTone] || thread.emotionalTone}」，别无故整场跳到相反语气。`);
  }
  lines.push('接话优先顺着本场主线；对方主动换题再跟。不要复述本段清单。');
  return lines.join('\n');
}

/**
 * 把会话线钩子并入 unfinished，供 goals / structured plan
 */
export function sessionHooksToUnfinished(thread = null) {
  if (!thread) return [];
  const out = [];
  for (const q of (thread.openQuestions || []).slice(0, 2)) {
    if (q?.text) out.push({ kind: 'unfinished', text: q.text, source: 'session_question' });
  }
  for (const c of (thread.commitments || []).filter((x) => x.status === 'open').slice(0, 2)) {
    if (c?.text) {
      out.push({
        kind: 'unfinished',
        text: c.text,
        source: c.who === 'her' ? 'session_her_commitment' : 'session_user_commitment',
      });
    }
  }
  return out;
}

/**
 * 粗检：回复是否相对本场主线硬跳（给评测/可选检改）
 */
export function detectSessionDrift(replyText = '', thread = null) {
  if (!thread?.primaryTopic || !replyText) return { drift: false, reasons: [] };
  const text = String(replyText);
  const reasons = [];
  const topic = thread.primaryTopic;
  // 主线亲密时硬插上课/早饭
  if (topic === '亲密' && /(明天上课|记得吃早饭|写作业)/.test(text)) {
    reasons.push('session: 亲密主线硬插日程');
  }
  if (topic === '情绪冲突' && /(想要你|来做一次|脱掉)/.test(text)) {
    reasons.push('session: 冲突主线硬推亲密');
  }
  if (topic === '工作' && /(出去浪|通宵蹦)/.test(text) && !/(加班|累|会)/.test(text)) {
    reasons.push('session: 工作主线硬跳狂欢');
  }
  return { drift: reasons.length > 0, reasons };
}

export { SESSION_IDLE_MS };
