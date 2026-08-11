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
    sessionThread = resetSessionThread(sessionThread, now);
    sessionReset = true;
  } else if (
    input.sessionThreadEnabled !== false &&
    shouldResetSession(sessionThread, now)
  ) {
    sessionThread = resetSessionThread(sessionThread, now);
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

/**
 * loadSessionThread 可能已在首轮开始前识别旧会话，并把 48h working_memory 桥放进
 * 一个 turnCount=0 的新 thread。Perceive 随后还会因 >=4h 的物理现场过期再重置一次；
 * 这里仅携带这份“尚未消费”的桥，避免二次重置把它清空。
 *
 * 已经产生过 turn 的 thread 不携带旧 bridge，防止它跨到第三场会话。
 */
function resetSessionThread(thread, now) {
  const reset = emptySessionThread(now);
  const freshBridge =
    Number(thread?.turnCount) === 0 &&
    typeof thread?.crossSessionContext === 'string'
      ? thread.crossSessionContext.trim().slice(0, 200)
      : '';
  if (freshBridge) reset.crossSessionContext = freshBridge;
  return reset;
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
