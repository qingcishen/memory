import {
  emptySessionThread,
  shouldResetSession,
} from '../companion/sessionThread.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Perceive 阶段的纯逻辑：规范化输入、计算真实会话间隔，并结束过期物理现场。
 * 不写 history store，不持久化 session。
 */
export function perceiveTurn(input = {}) {
  const now = Number(input.now ?? Date.now());
  const history = Array.isArray(input.history) ? [...input.history] : [];
  const userMessage = String(input.userMessage ?? '');
  const historyUserMessage = String(input.historyUserMessage ?? userMessage);
  const memoryGap = input.lastUserMessageAt
    ? Math.max(0, (now - Number(input.lastUserMessageAt)) / HOUR_MS)
    : null;
  const storedGap = input.storedLastUserMessageAt != null
    ? hoursSinceTimestamp(input.storedLastUserMessageAt, now)
    : null;
  const gapHours = maxKnownGap(memoryGap, storedGap);
  const physicalSceneExpired = gapHours != null && gapHours >= 4;
  const historyReset = physicalSceneExpired && history.length > 0;

  let sessionThread = input.sessionThread ?? emptySessionThread(now);
  let sessionReset = false;
  if (historyReset) {
    sessionThread = emptySessionThread(now);
    sessionReset = true;
  } else if (
    input.sessionThreadEnabled !== false &&
    shouldResetSession(sessionThread, now)
  ) {
    sessionThread = emptySessionThread(now);
    sessionReset = true;
  }

  return {
    normalizedMessage: userMessage,
    historyUserMessage,
    history: historyReset ? [] : history,
    gapHours,
    physicalSceneExpired,
    historyReset,
    sessionThread,
    sessionReset,
    previousSceneType: physicalSceneExpired ? null : input.previousSceneType ?? null,
    perceivedAt: now,
  };
}

export function maxKnownGap(a, b) {
  const values = [a, b].filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function hoursSinceTimestamp(value, now) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now - timestamp) / HOUR_MS);
}
