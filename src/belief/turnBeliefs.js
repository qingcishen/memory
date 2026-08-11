const MINUTE_MS = 60 * 1000;

export const CURRENT_ACTIVITY_TTL_MINUTES = Object.freeze({
  driving: 120,
  eating: 60,
  sleeping: 720,
  working: 600,
  exercising: 120,
  showering: 60,
  idle: 240,
});

const ACTIVITY_LABELS = Object.freeze({
  driving: '开车',
  eating: '吃饭',
  sleeping: '睡觉',
  working: '工作',
  exercising: '运动',
  showering: '洗澡',
  idle: '休息',
});

const CHINESE_ACTIVITY_PATTERNS = Object.freeze([
  ['driving', /我(?:现在|这会儿|这会|此刻|目前)?(?:正?在|正在)(?:开车|驾车|路上)/u],
  ['driving', /我(?:开车|驾车|在路上)(?:呢|中|ing)/iu],
  ['eating', /我(?:现在|这会儿|这会|此刻|目前)?(?:正?在|正在)(?:吃饭|吃东西|用餐)/u],
  ['eating', /我(?:去)?(?:吃饭|用餐)(?:了|呢)/u],
  ['sleeping', /我(?:现在|这会儿|这会|此刻|目前)?(?:正?在|正在)(?:睡觉|午睡)/u],
  ['working', /我(?:现在|这会儿|这会|此刻|目前)?(?:正?在|正在)(?:工作|上班|开会|加班)/u],
  ['working', /我(?:工作|上班|开会|加班)(?:呢|中|ing)/iu],
  ['exercising', /我(?:现在|这会儿|这会|此刻|目前)?(?:正?在|正在)(?:运动|健身|跑步|锻炼)/u],
  ['exercising', /我(?:运动|健身|跑步|锻炼)(?:呢|中|ing)/iu],
  ['showering', /我(?:现在|这会儿|这会|此刻|目前)?(?:正?在|正在)(?:洗澡|淋浴)/u],
  ['showering', /我(?:去)?(?:洗澡|淋浴)(?:了|呢)/u],
  ['idle', /我(?:现在|这会儿|这会|此刻|目前)?(?:正?在|正在)(?:休息|歇着|发呆)/u],
  ['idle', /我(?:休息|歇着|发呆)(?:呢|中)/u],
]);

const ENGLISH_ACTIVITY_PATTERNS = Object.freeze([
  ['driving', /\b(?:i am|i'm)\s+(?:currently\s+)?driving\b/i],
  ['eating', /\b(?:i am|i'm)\s+(?:currently\s+)?(?:eating|having (?:lunch|dinner|breakfast))\b/i],
  ['sleeping', /\b(?:i am|i'm)\s+(?:currently\s+)?(?:sleeping|napping)\b/i],
  ['working', /\b(?:i am|i'm)\s+(?:currently\s+)?(?:working|in a meeting)\b/i],
  ['exercising', /\b(?:i am|i'm)\s+(?:currently\s+)?(?:exercising|working out|running)\b/i],
  ['showering', /\b(?:i am|i'm)\s+(?:currently\s+)?(?:showering|taking a shower)\b/i],
  ['idle', /\b(?:i am|i'm)\s+(?:currently\s+)?(?:resting|taking a break)\b/i],
]);

/**
 * 从本轮 user 原话中提取极窄的显式活动声明。
 * 这里只接受“我正在……”一类现在时表达；计划、过去式、助手陈述和泛化事实都不投影。
 */
export function extractExplicitTurnBeliefs(turns = [], {
  eventId = null,
  observedAt = Date.now(),
  subjectName = '对方',
} = {}) {
  const userTurns = (turns ?? [])
    .filter((turn) => turn?.role === 'user')
    .map((turn) => String(turn.content ?? '').trim())
    .filter(Boolean);
  for (let index = userTurns.length - 1; index >= 0; index -= 1) {
    const evidenceText = userTurns[index];
    const activity = detectExplicitCurrentActivity(evidenceText);
    if (!activity) continue;
    const observed = normalizeTimestamp(observedAt);
    const validTo = new Date(
      Date.parse(observed) + CURRENT_ACTIVITY_TTL_MINUTES[activity] * MINUTE_MS,
    ).toISOString();
    return [{
      ...(eventId ? { id: `${String(eventId)}:belief:current_activity` } : {}),
      sourceKind: 'user',
      evidenceText: evidenceText.slice(0, 500),
      observedAt: observed,
      beliefs: [{
        subjectKey: 'user',
        subjectLabel: String(subjectName || '对方'),
        predicate: 'current_activity',
        objectValue: activity,
        objectText: ACTIVITY_LABELS[activity],
        beliefKind: 'event',
        epistemicStatus: 'asserted',
        confidence: 0.95,
        slotKey: 'user:current_activity',
        validFrom: observed,
        validTo,
        metadata: { extractor: 'explicit_activity_v1' },
      }],
    }];
  }
  return [];
}

export function detectExplicitCurrentActivity(message) {
  const text = String(message ?? '').normalize('NFKC').trim();
  if (!text) return null;
  for (const [activity, pattern] of [
    ...CHINESE_ACTIVITY_PATTERNS,
    ...ENGLISH_ACTIVITY_PATTERNS,
  ]) {
    if (pattern.test(text)) return activity;
  }
  return null;
}

function normalizeTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
