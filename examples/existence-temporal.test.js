// Continuous Existence Engine M0/M1 · pure/local contract tests.
import assert from 'node:assert/strict';
import {
  MemoryContinuousStateStore,
  SupabaseContinuousStateStore,
  continuousStateFromRow,
  continuousStateToRow,
  defaultContinuousState,
  normalizeContinuousState,
} from '../src/existence/continuousState.js';
import {
  TemporalPredictor,
  buildUserTimePattern,
  computeConfidence,
  computeTemporalAnomaly,
  computeUncertainty,
} from '../src/existence/temporalPredictor.js';
import {
  CircadianClock,
  blendClockWindow,
  circadianFatigue,
} from '../src/existence/circadianEntrainment.js';
import {
  applyAnomalyToState,
  inferTimeGap,
  markInteraction,
  temporalContextToPrompt,
} from '../src/existence/temporalPerception.js';
import {
  anticipationCurve,
  decayFactor,
  heartbeatStep,
  heartbeatTick,
  startHeartbeat,
} from '../src/existence/heartbeat.js';

const MINUTE = 60 * 1000;
let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  ✓', name);
  passed += 1;
};

console.log('Continuous state normalization and in-memory isolation');
{
  const at = Date.parse('2026-07-01T10:00:00.000Z');
  const normalized = normalizeContinuousState(
    {
      emotional: {
        current_emotion: '',
        emotion_intensity: Infinity,
        valence: -9,
        persistence: -3,
      },
      temporal: {
        longing: 3,
        fatigue: Number.NaN,
        last_interaction: 'not-a-date',
      },
      self: { coherence_score: Number.NaN },
      updated_at: 'also-not-a-date',
    },
    { now: at },
  );
  ok(
    'malformed scalars and dates are bounded',
    normalized.emotional.emotion_intensity >= 0 &&
      normalized.emotional.emotion_intensity <= 1 &&
      normalized.emotional.valence === -1 &&
      normalized.emotional.persistence === 0 &&
      normalized.temporal.longing === 1 &&
      normalized.temporal.fatigue === 0 &&
      normalized.temporal.last_interaction ===
        '2026-07-01T10:00:00.000Z' &&
      normalized.self.coherence_score === 1,
  );

  const store = new MemoryContinuousStateStore({ clock: () => at });
  const initial = defaultContinuousState(at);
  initial.cognitive.active_thoughts.push({ content: '等他到家' });
  await store.save(initial, { userId: 'u-a', companionId: 'c-a' });
  const first = await store.load({ userId: 'u-a', companionId: 'c-a' });
  first.cognitive.active_thoughts[0].content = 'mutated outside';
  const second = await store.load({ userId: 'u-a', companionId: 'c-a' });
  const other = await store.load({ userId: 'u-a', companionId: 'c-b' });
  ok(
    'memory store clones values and scopes by user/companion',
    second.cognitive.active_thoughts[0].content === '等他到家' &&
      other.cognitive.active_thoughts.length === 0,
  );
}

console.log('Supabase-style persistence mapping and fallback');
{
  const at = Date.parse('2026-07-01T10:00:00.000Z');
  const state = defaultContinuousState(at);
  state.emotional.persistence = 42;
  state.temporal.last_interaction = '2026-07-01T08:30:00.000Z';
  state.cognitive.attention_focus = '等他安全到家';
  state.self.identity_anchors = ['我会认真等在意的人'];
  state.self.recent_drift = { authenticity: 0.02 };

  const row = continuousStateToRow('u-db', 'c-db', state);
  const roundTrip = continuousStateFromRow(row, { now: at });
  ok(
    'all five extended SQL fields survive row round-trip',
    row.emotion_persistence === 42 &&
      row.last_interaction_at === '2026-07-01T08:30:00.000Z' &&
      row.attention_focus === '等他安全到家' &&
      row.identity_anchors[0] === '我会认真等在意的人' &&
      row.recent_drift.authenticity === 0.02 &&
      roundTrip.emotional.persistence === 42 &&
      roundTrip.temporal.last_interaction ===
        '2026-07-01T08:30:00.000Z' &&
      roundTrip.cognitive.attention_focus === '等他安全到家' &&
      roundTrip.self.identity_anchors.length === 1 &&
      roundTrip.self.recent_drift.authenticity === 0.02,
  );

  const fake = createFakeSupabase();
  const dbStore = new SupabaseContinuousStateStore({
    client: fake.client,
    clock: () => at,
    strict: true,
  });
  await dbStore.save(state, { userId: 'u-db', companionId: 'c-db' });
  const loaded = await dbStore.load({
    userId: 'u-db',
    companionId: 'c-db',
  });
  ok(
    'Supabase-style adapter performs a full state round-trip',
    fake.row.user_id === 'u-db' &&
      loaded.temporal.last_interaction ===
        '2026-07-01T08:30:00.000Z' &&
      loaded.cognitive.attention_focus === '等他安全到家' &&
      loaded.self.recent_drift.authenticity === 0.02,
  );

  const fallback = new SupabaseContinuousStateStore({
    client: { from() { throw new Error('offline'); } },
    clock: () => at,
  });
  state.temporal.longing = 0.4;
  await fallback.save(state, { userId: 'offline', companionId: 'default' });
  const offline = await fallback.load({
    userId: 'offline',
    companionId: 'default',
  });
  ok(
    'database failure falls back to isolated memory',
    offline.temporal.longing === 0.4,
  );
}

console.log('Temporal predictor and prediction errors');
{
  // 31 daily user messages at 20:00 Asia/Shanghai (12:00 UTC).
  const messages = Array.from({ length: 31 }, (_, index) => ({
    role: 'user',
    created_at: new Date(Date.UTC(2026, 3, 1 + index, 12, 0)).toISOString(),
  }));
  const pattern = buildUserTimePattern(messages, {
    timezoneOffsetMinutes: 8 * 60,
  });
  ok(
    'learned pattern has a 20:00 peak and daily median gap',
    pattern.hourly_distribution.indexOf(
      Math.max(...pattern.hourly_distribution),
    ) === 20 &&
      pattern.gap_distribution.median_minutes === 1440 &&
      computeConfidence(pattern) > 0.6 &&
      computeUncertainty(pattern) <= 20,
  );

  const predictor = new TemporalPredictor({
    getRecentMessages: async () => messages,
    timezoneOffsetMinutes: 8 * 60,
  });
  const prediction = await predictor.predictNextMessage(
    'u-pattern',
    messages.at(-1).created_at,
  );
  const expected = Date.parse(messages.at(-1).created_at) + 24 * 60 * MINUTE;
  ok(
    'next-message prediction is future, calibrated and within one bucket',
    Math.abs(Date.parse(prediction.expected_at) - expected) <= 10 * MINUTE &&
      prediction.confidence > 0.6 &&
      prediction.sample_count === 31,
  );

  const predicted = '2026-07-01T10:30:00.000Z';
  ok(
    'driving threshold distinguishes early, normal and late arrivals',
    computeTemporalAnomaly(
      predicted,
      '2026-07-01T10:20:00.000Z',
      'driving',
    ).type === 'too_fast' &&
      computeTemporalAnomaly(
        predicted,
        '2026-07-01T10:40:00.000Z',
        '开车',
      ).type === 'normal' &&
      computeTemporalAnomaly(
        predicted,
        '2026-07-01T11:00:00.000Z',
        'driving',
      ).type === 'too_slow',
  );
  ok(
    'invalid timestamps degrade to a finite normal anomaly',
    computeTemporalAnomaly('bad', 'also-bad').type === 'normal' &&
      Number.isFinite(computeTemporalAnomaly('bad', 'also-bad').magnitude),
  );
}

console.log('Dead reckoning and anomaly-to-emotion bridge');
{
  const now = new Date('2026-07-01T10:00:00.000Z');
  const store = new MemoryContinuousStateStore({
    clock: () => now.getTime(),
  });
  const state = defaultContinuousState(now);
  state.temporal.last_interaction = new Date(
    now.getTime() - 30 * MINUTE,
  ).toISOString();
  state.updated_at = new Date(now.getTime() - 5 * MINUTE).toISOString();
  await store.save(state, { userId: 'driver', companionId: 'default' });
  const context = await inferTimeGap('driver', 'default', now, {
    store,
    activityResolver: async () => ({ value: 'driving' }),
  });
  ok(
    '30-minute drive is inferred as likely completed',
    context.elapsed_minutes === 30 &&
      context.inferences[0]?.type === 'activity_likely_completed' &&
      context.inferences[0]?.confidence >= 0.7 &&
      context.active_activity === 'driving',
  );
  ok(
    'temporal narrative carries waiting texture without “too fast”',
    context.narrative.includes('30分钟') &&
      context.narrative.includes('应该已经结束') &&
      !context.narrative.includes('这么快'),
  );

  const worried = defaultContinuousState(now);
  applyAnomalyToState(
    { type: 'too_slow', magnitude: 45 },
    worried,
  );
  const surprised = defaultContinuousState(now);
  applyAnomalyToState(
    { type: 'too_fast', magnitude: 15 },
    surprised,
  );
  ok(
    'prediction errors drive bounded worry/surprise',
    worried.emotional.current_emotion === 'worried' &&
      worried.emotional.emotion_intensity === 0.75 &&
      surprised.emotional.current_emotion === 'surprised_pleasant' &&
      surprised.emotional.emotion_intensity === 0.5,
  );

  const marked = markInteraction(worried, now, {
    expected_at: '2026-07-01T10:45:00.000Z',
    confidence: 0.8,
  });
  ok(
    'markInteraction resets longing and anchors the next prediction',
    marked.temporal.longing === 0 &&
      marked.temporal.last_interaction === now.toISOString() &&
      marked.temporal.expected_next ===
        '2026-07-01T10:45:00.000Z' &&
      marked.temporal.prediction_confidence === 0.8,
  );
  ok(
    'temporal prompt translates context instead of exposing numbers alone',
    temporalContextToPrompt(context).includes('时间感知'),
  );
}

console.log('Circadian entrainment and fatigue');
{
  ok(
    'deep night and wind-down are more tiring than afternoon',
    circadianFatigue(3) > circadianFatigue(14) &&
      circadianFatigue(23) > circadianFatigue(14),
  );
  const circular = blendClockWindow([23, 1], [1, 3], 0.5);
  ok(
    'clock blending follows the short path across midnight',
    circular[0] === 0 && circular[1] === 2,
  );

  const lateHistory = Array.from({ length: 91 }, (_, index) => ({
    role: 'user',
    // 15:00 UTC = 23:00 Asia/Shanghai.
    created_at: new Date(Date.UTC(2026, 0, 1 + index, 15, 0)).toISOString(),
  }));
  const clock = new CircadianClock({
    timezoneOffsetMinutes: 8 * 60,
  });
  const personal = await clock.entrain('night-owl', lateHistory);
  ok(
    '90-day night-owl rhythm pulls social peak later',
    personal.entrainment_weight >= 0.59 &&
      personal.social_peak[0] > 21 &&
      personal.user_rhythm.peak_hour === 23,
  );
}

console.log('Heartbeat transition and lifecycle');
{
  const now = new Date('2026-07-01T10:00:00.000Z');
  const store = new MemoryContinuousStateStore({
    clock: () => now.getTime(),
  });
  const state = defaultContinuousState(
    new Date(now.getTime() - 10 * MINUTE),
  );
  state.emotional.current_emotion = 'happy';
  state.emotional.emotion_intensity = 1;
  state.emotional.valence = 0.8;
  state.temporal.expected_next = now.toISOString();
  state.volitional.contact_inhibit = 0.8;
  await store.save(state, { userId: 'pulse', companionId: 'default' });
  let checked = false;
  const next = await heartbeatTick('pulse', 'default', {
    store,
    now,
    checkProactiveContact: async (_userId, _companionId, liveState) => {
      checked = liveState.temporal.longing > 0;
    },
  });
  const persisted = await store.load({
    userId: 'pulse',
    companionId: 'default',
  });
  ok(
    'heartbeat decays emotion/inhibition and grows longing',
    next.emotional.emotion_intensity < 1 &&
      next.emotional.emotion_intensity >= 0 &&
      next.temporal.longing > 0 &&
      next.temporal.longing <= 1 &&
      next.volitional.contact_inhibit < 0.8,
  );
  ok(
    'heartbeat updates circadian/anticipation, checks contact and persists',
    next.temporal.anticipation === 1 &&
      next.temporal.fatigue >= 0 &&
      next.temporal.fatigue <= 1 &&
      checked &&
      persisted.updated_at === now.toISOString(),
  );
  const detailed = await heartbeatStep('pulse', 'default', {
    store,
    now: new Date(now.getTime() + 30_000),
    checkProactiveContact: async () => ({
      contact: true,
      reason: { type: 'pure_longing' },
    }),
  });
  ok(
    'heartbeatStep exposes state and proactive decision for runtime adapters',
    detailed.state?.updated_at ===
      new Date(now.getTime() + 30_000).toISOString() &&
      detailed.contactDecision?.contact === true &&
      detailed.elapsed_minutes === 0.5,
  );
  ok(
    'decay and anticipation helpers stay bounded on extreme inputs',
    decayFactor(-10) === 1 &&
      decayFactor(Infinity) === 0 &&
      decayFactor(0, Infinity) === 1 &&
      anticipationCurve(Infinity) === 0 &&
      anticipationCurve(0) === 1,
  );

  let scheduled = null;
  let cancelled = false;
  let ticks = 0;
  const controller = startHeartbeat('pulse', 'default', {
    intervalMs: 5,
    tick: async () => {
      ticks += 1;
      return null;
    },
    setIntervalFn(callback, intervalMs) {
      scheduled = { callback, intervalMs, unref() {} };
      return scheduled;
    },
    clearIntervalFn(timer) {
      cancelled = timer === scheduled;
    },
  });
  await controller.tick();
  controller.stop();
  ok(
    'startHeartbeat exposes a stoppable, non-overlapping controller',
    scheduled.intervalMs === 5 &&
      ticks === 1 &&
      cancelled &&
      controller.stopped,
  );
}

console.log(`\nContinuous Existence M0/M1 all ${passed} assertions passed`);

function createFakeSupabase() {
  const holder = { row: null };
  const client = {
    from() {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        upsert(row) {
          holder.row = structuredClone(row);
          return query;
        },
        maybeSingle() {
          return Promise.resolve({
            data: holder.row == null ? null : structuredClone(holder.row),
            error: null,
          });
        },
        single() {
          return query.maybeSingle();
        },
      };
      return query;
    },
  };
  return {
    client,
    get row() {
      return holder.row;
    },
  };
}
