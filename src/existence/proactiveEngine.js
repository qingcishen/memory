/**
 * M2 · 主动存在引擎。
 *
 * 这里仅负责「想不想联系、现在合不合适、有没有真实理由」的决策。
 * 消息生成、限流和实际投递仍由上层调度器负责。所有 IO 都通过 deps 注入，
 * 因而纯决策可以离线测试，也不会因为 import 本模块而连接数据库或 LLM。
 */

export const DEFAULT_CONTACT_THRESHOLDS = Object.freeze({
  desire: 0.40,   // longing(0.3) + memory_surfaced(0.105) ≈ 0.405 at 3h → triggers naturally
  receptivity: 0.3,
  reasonQuality: 0.5,
  urgentDesire: 0.85,
});

export const DEFAULT_ACTIVITY_MODIFIERS = Object.freeze({
  working: 0.2,
  meeting: 0.1,
  driving: 0.05,
  sleeping: 0,
  exercising: 0.35,
  idle: 1.3,
});

/**
 * 从连续状态计算主动联系内驱力。输入不会被修改。
 *
 * 权重严格对应设计稿：思念 30%、未完话题 20%、浮现记忆 15%、
 * 期待 15%、情绪冲动 20%，最后扣掉克制感。
 */
export function computeDesire(state = {}) {
  const temporal = state?.temporal ?? {};
  const cognitive = state?.cognitive ?? {};
  const emotional = state?.emotional ?? {};
  const volitional = state?.volitional ?? {};

  const longing = unit(temporal.longing);
  const anticipation = unit(temporal.anticipation);
  const unfinishedCount = Array.isArray(cognitive.unfinished_topics)
    ? cognitive.unfinished_topics.length
    : 0;
  const unfinishedSignal = unit(unfinishedCount * 0.2);
  const memorySignal = cognitive.memory_surfaced ? 0.7 : 0;
  const emotionIntensity = unit(
    emotional.emotion_intensity ?? emotional.intensity,
  );
  const valence = signedUnit(emotional.valence);
  const emotionSignal = emotionIntensity * (valence > 0 ? 1 : 0.5);

  const raw =
    longing * 0.3 +
    unfinishedSignal * 0.2 +
    memorySignal * 0.15 +
    anticipation * 0.15 +
    emotionSignal * 0.2;

  return unit(raw - unit(volitional.contact_inhibit));
}

/**
 * 预测用户此刻接收主动消息的可能性。
 *
 * deps 支持：
 * - loadUserPattern(userId) 或 userPattern.load(userId)
 * - resolveCurrentActivity(userId, now) 或 beliefs.resolve(...)
 * - countTodayMessages(userId, now)
 *
 * 数据缺失时保守返回 0（fail closed），避免一个裸 cron 凭空发消息。
 */
export async function predictReceptivity(
  userId,
  now = new Date(),
  deps = {},
) {
  ({ now, deps } = normalizeNowAndDeps(now, deps));
  const at = validDate(now);
  if (!nonEmpty(userId)) {
    return {
      score: 0,
      reason: 'missing_user',
      factors: { base: 0, activity: null, activityModifier: 1, todayMessages: 0, densityModifier: 1 },
    };
  }

  const pattern = await loadPattern(userId, deps);
  const hour = resolveHour(at, deps);
  const base = hourlyScore(pattern, hour, deps.defaultReceptivity);
  const activity = await resolveActivity(userId, at, deps);
  const activityModifiers = {
    ...DEFAULT_ACTIVITY_MODIFIERS,
    ...(deps.activityModifiers ?? {}),
  };
  const activityModifier =
    activity == null
      ? 1
      : finiteOr(activityModifiers[normalizeActivity(activity)], 1);
  const todayMessages = Math.max(
    0,
    finiteOr(await loadTodayMessageCount(userId, at, deps), 0),
  );
  const densityModifier = Math.max(0.3, 1 - todayMessages * 0.05);
  const score = unit(base * activityModifier * densityModifier);

  return {
    score,
    reason: explainReceptivity({
      base,
      hour,
      activity,
      activityModifier,
      todayMessages,
      densityModifier,
      patternAvailable: Boolean(pattern),
    }),
    factors: {
      base,
      hour,
      activity,
      activityModifier,
      todayMessages,
      densityModifier,
      patternAvailable: Boolean(pattern),
    },
  };
}

/**
 * 从内部状态提取「为什么是现在想找他」。
 *
 * 只有状态中真实存在的材料才会成为候选；不会生成「在吗」「想聊一句」
 * 之类模板理由。用户模式 IO 通过 deps 注入。
 */
export async function extractContactReason(state = {}, userId, deps = {}) {
  const cognitive = state?.cognitive ?? {};
  const temporal = state?.temporal ?? {};
  const candidates = [];

  const recurringThought = (Array.isArray(cognitive.active_thoughts)
    ? cognitive.active_thoughts
    : [])
    .map((thought) => ({
      thought,
      count: Math.max(
        0,
        finiteOr(thought?.recurrence_count ?? thought?.recurrenceCount, 0),
      ),
      content: cleanContent(thought?.content ?? thought?.text),
    }))
    .filter(
      ({ count, content }) =>
        count >= 3 && isSpecificContent(content),
    )
    .sort((a, b) => b.count - a.count)[0];

  if (recurringThought) {
    candidates.push({
      type: 'recurring_thought',
      content: recurringThought.content,
      weight: unit(recurringThought.count / 5),
      evidence: { recurrence_count: recurringThought.count },
    });
  }

  const surfaced = cognitive.memory_surfaced;
  const surfacedContent = cleanContent(
    surfaced?.summary ?? surfaced?.content ?? surfaced?.narrative,
  );
  if (surfaced && isSpecificContent(surfacedContent)) {
    candidates.push({
      type: 'memory_surfaced',
      content: surfacedContent,
      weight: unit(
        surfaced.emotional_weight ??
          surfaced.emotionalWeight ??
          surfaced.weight ??
          0.7,
      ),
      evidence: surfaced.id ? { memory_id: surfaced.id } : undefined,
    });
  }

  const pattern = await loadPattern(userId, deps);
  const silenceDelta = await resolveSilenceDelta(state, pattern, deps);
  if (silenceDelta > 1.5) {
    candidates.push({
      type: 'concern',
      content: '今天比平时安静',
      weight: unit(silenceDelta - 1),
      evidence: { silence_delta: silenceDelta },
    });
  }

  const unfinished = (Array.isArray(cognitive.unfinished_topics)
    ? cognitive.unfinished_topics
    : [])
    .map((topic, index) => {
      const content = cleanContent(
        topic?.summary ?? topic?.content ?? topic?.text ?? topic,
      );
      return {
        content,
        weight: unit(topic?.weight ?? topic?.importance ?? 0.6),
        index,
      };
    })
    .filter(({ content }) => isSpecificContent(content))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)[0];

  if (unfinished) {
    candidates.push({
      type: 'unfinished_topic',
      content: unfinished.content,
      weight: unfinished.weight,
    });
  }

  const longing = unit(temporal.longing);
  if (longing > 0.8) {
    candidates.push({
      type: 'pure_longing',
      content: null,
      weight: longing,
    });
  }

  if (candidates.length === 0) return null;
  // 若存在质量足够的具体理由，pure_longing 退为兜底，避免高 longing 权重覆盖更自然的触达原因。
  const specificQualified = candidates.filter(
    (c) => c.type !== 'pure_longing' && scoreReasonQuality(c) >= 0.5,
  );
  const pool = specificQualified.length > 0 ? specificQualified : candidates;
  return pool.sort(
    (a, b) =>
      reasonRank(b) - reasonRank(a) ||
      b.weight - a.weight,
  )[0];
}

/**
 * 评估触发理由是否足够具体、自然。
 *
 * pure_longing 是真实理由，但带宽较低：只有内驱力接近极限时才值得直接
 * 打断用户。空内容、模板开场和未知理由不会获得可发送分数。
 */
export function scoreReasonQuality(reason) {
  if (!reason || typeof reason !== 'object') return 0;
  const type = String(reason.type ?? '');
  const weight = unit(reason.weight);
  const baseByType = {
    prospective: 0.72,
    recurring_thought: 0.58,
    memory_surfaced: 0.62,
    unfinished_topic: 0.56,
    concern: 0.5,
    pure_longing: 0.34,
  };
  const base = finiteOr(baseByType[type], 0.25);

  if (type === 'pure_longing') return unit(base + weight * 0.12);

  const content = cleanContent(reason.content);
  if (!isSpecificContent(content)) return 0;

  const length = Array.from(content).length;
  const specificity =
    (length >= 4 ? 0.05 : 0) +
    (length >= 8 ? 0.04 : 0) +
    (length >= 16 ? 0.03 : 0);
  const evidenceBoost =
    reason.evidence && Object.keys(reason.evidence).length > 0 ? 0.03 : 0;
  return unit(base + weight * 0.12 + specificity + evidenceBoost);
}

/**
 * 做一次无副作用的主动联系决策。
 */
export async function decideContact(
  userId,
  companionId = 'default',
  state = {},
  deps = {},
) {
  const thresholds = {
    ...DEFAULT_CONTACT_THRESHOLDS,
    ...(deps.thresholds ?? {}),
  };
  const storedDesire = Number(state?.volitional?.proactive_desire);
  const desire = unit(
    Number.isFinite(storedDesire) ? storedDesire : computeDesire(state),
  );

  if (desire < unit(thresholds.desire)) {
    return {
      contact: false,
      reason: 'desire_insufficient',
      desire,
    };
  }

  const now = validDate(
    typeof deps.now === 'function' ? deps.now() : deps.now ?? new Date(),
  );
  let receptivity;
  try {
    receptivity = deps.predictReceptivity
      ? await deps.predictReceptivity(userId, now, deps)
      : await predictReceptivity(userId, now, deps);
  } catch (error) {
    return {
      contact: false,
      reason: 'receptivity_unavailable',
      desire,
      error: String(error?.message ?? error),
    };
  }
  const receptivityScore = unit(
    typeof receptivity === 'number' ? receptivity : receptivity?.score,
  );
  const normalizedReceptivity =
    typeof receptivity === 'number'
      ? { score: receptivityScore, reason: 'injected_score' }
      : { ...(receptivity ?? {}), score: receptivityScore };

  if (receptivityScore < unit(thresholds.receptivity)) {
    return {
      contact: false,
      reason: 'bad_timing',
      desire,
      receptivity: normalizedReceptivity,
    };
  }

  let contactReason;
  try {
    contactReason = deps.extractContactReason
      ? await deps.extractContactReason(state, userId, deps)
      : await extractContactReason(state, userId, deps);
  } catch (error) {
    return {
      contact: false,
      reason: 'contact_reason_unavailable',
      desire,
      receptivity: normalizedReceptivity,
      error: String(error?.message ?? error),
    };
  }
  if (!contactReason) {
    return {
      contact: false,
      reason: 'no_contact_reason',
      desire,
      receptivity: normalizedReceptivity,
    };
  }

  const qualityFn = deps.scoreReasonQuality ?? scoreReasonQuality;
  let reasonQuality;
  try {
    reasonQuality = unit(await qualityFn(contactReason));
  } catch (error) {
    return {
      contact: false,
      reason: 'reason_quality_unavailable',
      desire,
      receptivity: normalizedReceptivity,
      contactReason,
      error: String(error?.message ?? error),
    };
  }
  if (reasonQuality <= 0) {
    return {
      contact: false,
      reason: 'invalid_contact_reason',
      desire,
      receptivity: normalizedReceptivity,
      contactReason,
      reasonQuality,
    };
  }
  if (
    reasonQuality < unit(thresholds.reasonQuality) &&
    desire < unit(thresholds.urgentDesire)
  ) {
    return {
      contact: false,
      reason: 'waiting_for_better_trigger',
      desire,
      receptivity: normalizedReceptivity,
      contactReason,
      reasonQuality,
    };
  }

  return {
    contact: true,
    reason: contactReason,
    desire,
    receptivity: normalizedReceptivity,
    reasonQuality,
    userId,
    companionId,
  };
}

/**
 * 心跳入口。默认只返回决策；注入 onContact/deliver/sendProactive 后才产生投递
 * 副作用。回调只会收到已经通过真实理由与接收窗口门控的请求。
 */
export async function checkProactiveContact(
  userId,
  companionId = 'default',
  state = {},
  deps = {},
) {
  const decide = deps.decideContact ?? decideContact;
  const decision = await decide(userId, companionId, state, deps);
  if (!decision?.contact) return decision;

  const dispatch =
    deps.onContact ?? deps.deliver ?? deps.sendProactive ?? null;
  if (typeof dispatch !== 'function') {
    return { ...decision, dispatched: false };
  }

  const payload = {
    userId,
    companionId,
    state,
    decision,
    reason: decision.reason,
    receptivity: decision.receptivity,
  };
  const delivery = await dispatch(payload);
  return {
    ...decision,
    // async callback 没有显式 return（undefined）也代表已正常执行；只有明确
    // 返回 false 才表示上层拒绝投递。
    dispatched: delivery !== false,
    delivery: delivery ?? null,
  };
}

/** 创建一个绑定好依赖的轻量门面，方便心跳或测试复用。 */
export function createProactiveEngine(deps = {}) {
  return {
    computeDesire,
    predictReceptivity: (userId, now) =>
      predictReceptivity(userId, now, deps),
    extractContactReason: (state, userId) =>
      extractContactReason(state, userId, deps),
    scoreReasonQuality,
    decideContact: (userId, companionId, state) =>
      decideContact(userId, companionId, state, deps),
    checkProactiveContact: (userId, companionId, state) =>
      checkProactiveContact(userId, companionId, state, deps),
  };
}

async function loadPattern(userId, deps) {
  try {
    if (typeof deps.loadUserPattern === 'function') {
      return (await deps.loadUserPattern(userId)) ?? null;
    }
    if (typeof deps.userPattern?.load === 'function') {
      return (await deps.userPattern.load(userId)) ?? null;
    }
  } catch {
    return null;
  }
  return deps.pattern ?? null;
}

async function resolveActivity(userId, now, deps) {
  try {
    if (typeof deps.resolveCurrentActivity === 'function') {
      return activityValue(await deps.resolveCurrentActivity(userId, now));
    }
    if (typeof deps.beliefs?.resolve === 'function') {
      return activityValue(
        await deps.beliefs.resolve('current_activity', {
          userId,
          at: now,
        }),
      );
    }
  } catch {
    return null;
  }
  return activityValue(deps.currentActivity);
}

async function loadTodayMessageCount(userId, now, deps) {
  try {
    if (typeof deps.countTodayMessages === 'function') {
      return await deps.countTodayMessages(userId, now);
    }
    if (typeof deps.messageHistory?.countToday === 'function') {
      return await deps.messageHistory.countToday({ userId, now });
    }
  } catch {
    return 0;
  }
  return 0;
}

async function resolveSilenceDelta(state, pattern, deps) {
  const direct = Number(
    state?.temporal?.silence_delta ?? state?.temporal?.silenceDelta,
  );
  if (Number.isFinite(direct) && direct >= 0) return direct;

  const lastInteraction =
    state?.temporal?.last_interaction ??
    state?.temporal?.lastInteraction ??
    null;
  if (typeof deps.computeSilenceDelta === 'function') {
    try {
      const result = await deps.computeSilenceDelta(
        lastInteraction,
        pattern,
        {
          now:
            typeof deps.now === 'function'
              ? deps.now()
              : deps.now ?? new Date(),
          state,
        },
      );
      return Math.max(0, finiteOr(result, 0));
    } catch {
      return 0;
    }
  }

  const lastMs = dateMs(lastInteraction);
  if (lastMs == null || !pattern) return 0;
  const nowMs = validDate(
    typeof deps.now === 'function' ? deps.now() : deps.now ?? new Date(),
  ).getTime();
  const elapsedMinutes = Math.max(0, (nowMs - lastMs) / 60_000);
  const typicalMinutes = typicalSilenceMinutes(pattern);
  if (!(typicalMinutes > 0)) return 0;
  return elapsedMinutes / typicalMinutes;
}

function typicalSilenceMinutes(pattern) {
  const direct = [
    pattern.typical_silence_minutes,
    pattern.typicalSilenceMinutes,
    pattern.average_gap_minutes,
    pattern.averageGapMinutes,
    pattern.gap_distribution?.median,
    pattern.gapDistribution?.median,
    pattern.gap_distribution?.typical,
    pattern.gapDistribution?.typical,
  ]
    .map(Number)
    .find((value) => Number.isFinite(value) && value > 0);
  return direct ?? 0;
}

function hourlyScore(pattern, hour, fallback) {
  const distribution =
    pattern?.hourly_receptivity ??
    pattern?.hourlyReceptivity ??
    pattern?.hourly_distribution ??
    pattern?.hourlyDistribution;
  let value;
  if (Array.isArray(distribution)) value = distribution[hour];
  else if (distribution && typeof distribution === 'object') {
    value = distribution[hour] ?? distribution[String(hour)];
  }
  value ??=
    pattern?.default_receptivity ??
    pattern?.defaultReceptivity ??
    fallback ??
    0;
  return unit(value);
}

function activityValue(result) {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (typeof result.value === 'string') return result.value;
  if (typeof result.activity === 'string') return result.activity;
  if (typeof result.belief?.value === 'string') return result.belief.value;
  const beliefs = Array.isArray(result.beliefs) ? result.beliefs : [];
  return beliefs.find((belief) => typeof belief?.value === 'string')?.value ?? null;
}

function normalizeActivity(activity) {
  const value = String(activity ?? '').trim().toLowerCase();
  const aliases = {
    工作: 'working',
    开会: 'meeting',
    开车: 'driving',
    驾驶: 'driving',
    睡觉: 'sleeping',
    睡眠: 'sleeping',
    运动: 'exercising',
    空闲: 'idle',
    发呆: 'idle',
  };
  return aliases[value] ?? value;
}

function explainReceptivity({
  base,
  hour,
  activity,
  activityModifier,
  todayMessages,
  densityModifier,
  patternAvailable,
}) {
  if (!patternAvailable && base === 0) return 'no_user_pattern';
  if (activityModifier === 0) return `activity_blocked:${normalizeActivity(activity)}`;
  return [
    `hour=${hour}`,
    `base=${round(base)}`,
    activity ? `activity=${normalizeActivity(activity)}:${round(activityModifier)}` : null,
    `today_messages=${todayMessages}:${round(densityModifier)}`,
  ]
    .filter(Boolean)
    .join(',');
}

function reasonRank(reason) {
  // 强度决定“有多想说”，质量决定“现在说是否自然”。两者共同排序，
  // 防止 0.9 的纯思念盖过 0.8 的具体未完话题，最后只能退化成模板开场。
  return unit(reason?.weight) * 0.55 + scoreReasonQuality(reason) * 0.45;
}

function isSpecificContent(value) {
  const content = cleanContent(value);
  if (!content) return false;
  const compact = content.replace(/\s+/g, '').toLowerCase();
  if (
    /^(在吗|忙吗|干嘛呢|聊聊|想聊一句|想主动找(对方|你)聊一句|hi|hello|hey|ping|test|测试)$/.test(
      compact,
    )
  ) {
    return false;
  }
  if (/^\{.*\}$/.test(compact) || /^(null|undefined|n\/a)$/.test(compact)) {
    return false;
  }
  return Array.from(compact).length >= 2;
}

function cleanContent(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeNowAndDeps(now, deps) {
  if (
    now &&
    typeof now === 'object' &&
    !(now instanceof Date) &&
    !Array.isArray(now) &&
    dateMs(now) == null
  ) {
    return {
      now:
        typeof now.now === 'function'
          ? now.now()
          : now.now ?? new Date(),
      deps: now,
    };
  }
  return { now, deps: deps ?? {} };
}

function resolveHour(now, deps) {
  if (typeof deps.getHour === 'function') {
    const hour = Math.trunc(finiteOr(deps.getHour(now), now.getHours()));
    return ((hour % 24) + 24) % 24;
  }
  return now.getHours();
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function dateMs(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function signedUnit(value) {
  return Math.min(1, Math.max(-1, finiteOr(value, 0)));
}

function unit(value) {
  return Math.min(1, Math.max(0, finiteOr(value, 0)));
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonEmpty(value) {
  return String(value ?? '').trim().length > 0;
}

function round(value) {
  return Math.round(finiteOr(value, 0) * 1000) / 1000;
}
