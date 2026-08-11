/**
 * M0 · Unified Continuous State.
 *
 * The engine keeps dates as ISO strings at the persistence boundary.  Every
 * public normalizer accepts Date/number/string inputs, so callers do not need
 * to care whether a state came from memory or Postgres.
 */

import {
  normalizeEmotionArcJournal,
  normalizeWeeklyDistribution,
} from './emotionArc.js';

export const CONTINUOUS_STATE_TABLE = 'companion_continuous_state';
export const DEFAULT_COMPANION_ID = 'default';

const MAX_COLLECTION_ITEMS = 100;

export function defaultContinuousState(now = Date.now()) {
  const at = validIso(now) ?? new Date().toISOString();
  return {
    emotional: {
      current_emotion: 'neutral',
      emotion_intensity: 0,
      valence: 0,
      persistence: 0,
      label: null,
      weekly_distribution: normalizeWeeklyDistribution(),
      emotion_history: [],
    },
    temporal: {
      longing: 0,
      anticipation: 0,
      fatigue: 0,
      last_interaction: at,
      expected_next: null,
      prediction_confidence: 0,
    },
    cognitive: {
      active_thoughts: [],
      unfinished_topics: [],
      memory_surfaced: null,
      attention_focus: null,
    },
    volitional: {
      proactive_desire: 0,
      desire_reason: null,
      contact_inhibit: 0,
    },
    self: {
      coherence_score: 1,
      identity_anchors: [],
      recent_drift: {},
    },
    updated_at: at,
  };
}

/**
 * Return a complete, bounded and detached state object.
 */
export function normalizeContinuousState(state = {}, { now = Date.now() } = {}) {
  const fallback = defaultContinuousState(now);
  const emotional = plainObject(state.emotional);
  const temporal = plainObject(state.temporal);
  const cognitive = plainObject(state.cognitive);
  const volitional = plainObject(state.volitional);
  const self = plainObject(state.self);
  const updatedAt = validIso(state.updated_at) ?? fallback.updated_at;

  return {
    emotional: {
      current_emotion: textOr(emotional.current_emotion, fallback.emotional.current_emotion),
      emotion_intensity: clamp01(emotional.emotion_intensity),
      valence: clamp(finite(emotional.valence, 0), -1, 1),
      persistence: Math.max(0, finite(emotional.persistence, 0)),
      label: typeof emotional.label === 'string' && emotional.label ? emotional.label : null,
      weekly_distribution: normalizeWeeklyDistribution(
        emotional.weekly_distribution,
      ),
      emotion_history: normalizeEmotionArcJournal(emotional.emotion_history),
    },
    temporal: {
      longing: clamp01(temporal.longing),
      anticipation: clamp01(temporal.anticipation),
      fatigue: clamp01(temporal.fatigue),
      last_interaction: validIso(temporal.last_interaction) ?? updatedAt,
      expected_next: validIso(temporal.expected_next),
      prediction_confidence: clamp01(temporal.prediction_confidence),
    },
    cognitive: {
      active_thoughts: safeArray(cognitive.active_thoughts),
      unfinished_topics: safeArray(cognitive.unfinished_topics),
      memory_surfaced: cloneNullable(cognitive.memory_surfaced),
      attention_focus: textOrNull(cognitive.attention_focus),
    },
    volitional: {
      proactive_desire: clamp01(volitional.proactive_desire),
      desire_reason: textOrNull(volitional.desire_reason),
      contact_inhibit: clamp01(volitional.contact_inhibit),
    },
    self: {
      coherence_score: clamp(
        finite(self.coherence_score, fallback.self.coherence_score),
        0,
        1,
      ),
      identity_anchors: safeArray(self.identity_anchors)
        .map((value) => textOrNull(value))
        .filter(Boolean),
      recent_drift: clonePlainObject(self.recent_drift),
    },
    updated_at: updatedAt,
  };
}

/**
 * A process-local store used by default and by the Supabase adapter as a
 * graceful fallback.  Values are cloned on both sides to prevent accidental
 * cross-request mutation.
 */
export class MemoryContinuousStateStore {
  constructor({ initial = [], clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.rows = new Map();
    for (const entry of Array.isArray(initial) ? initial : []) {
      const userId = entry?.userId ?? entry?.user_id;
      const companionId = entry?.companionId ?? entry?.companion_id ?? DEFAULT_COMPANION_ID;
      if (!scopeText(userId)) continue;
      const state = entry?.state ?? entry;
      this.rows.set(scopeKey(userId, companionId), normalizeContinuousState(state, { now: this.clock() }));
    }
  }

  async load(scope = {}) {
    const { userId, companionId } = normalizeScope(scope);
    if (!userId) return defaultContinuousState(this.clock());
    const row = this.rows.get(scopeKey(userId, companionId));
    return normalizeContinuousState(row ?? {}, { now: this.clock() });
  }

  async save(state, scope = {}) {
    const { userId, companionId } = normalizeScope(scope);
    assertScope(userId, companionId);
    const normalized = normalizeContinuousState(state, { now: this.clock() });
    this.rows.set(scopeKey(userId, companionId), normalized);
    return normalizeContinuousState(normalized, { now: this.clock() });
  }

  async delete(scope = {}) {
    const { userId, companionId } = normalizeScope(scope);
    if (!userId) return false;
    return this.rows.delete(scopeKey(userId, companionId));
  }

  clear() {
    this.rows.clear();
  }
}

/**
 * Adapter for a Supabase/PostgREST-style client.
 *
 * The columns intentionally match the table declared by the design document.
 * Fields that are not columns in that first schema revision keep their
 * normalized defaults when a row is loaded.  `strict: false` makes missing
 * tables/network failures fall back to memory, which keeps imports and pure
 * local runs credential-free.
 */
export class SupabaseContinuousStateStore {
  constructor({
    client,
    table = CONTINUOUS_STATE_TABLE,
    fallback = null,
    strict = false,
    clock = () => Date.now(),
  } = {}) {
    this.client = client;
    this.table = table;
    this.fallback = fallback ?? new MemoryContinuousStateStore({ clock });
    this.strict = Boolean(strict);
    this.clock = clock;
    // Per-scope version cache for optimistic locking: scopeKey → version (integer)
    this._versions = new Map();
  }

  async load(scope = {}) {
    const normalizedScope = normalizeScope(scope);
    const { userId, companionId } = normalizedScope;
    if (!userId) return defaultContinuousState(this.clock());
    if (!this.client?.from) return this.fallback.load(normalizedScope);

    try {
      const request = this.client
        .from(this.table)
        .select('*')
        .eq('user_id', userId)
        .eq('companion_id', companionId)
        .maybeSingle();
      const { data, error } = await request;
      if (error) throw error;
      if (!data) return this.fallback.load(normalizedScope);
      // Cache the DB version for use in the next optimistic save.
      if (typeof data.version === 'number') {
        this._versions.set(scopeKey(userId, companionId), data.version);
      }
      const state = continuousStateFromRow(data, { now: this.clock() });
      await this.fallback.save(state, normalizedScope);
      return state;
    } catch (error) {
      if (this.strict) throw error;
      return this.fallback.load(normalizedScope);
    }
  }

  async save(state, scope = {}) {
    const normalizedScope = normalizeScope(scope);
    const { userId, companionId } = normalizedScope;
    assertScope(userId, companionId);
    const normalized = normalizeContinuousState(state, { now: this.clock() });
    await this.fallback.save(normalized, normalizedScope);
    if (!this.client?.from) return normalized;

    const key = scopeKey(userId, companionId);
    const knownVersion = this._versions.get(key) ?? null;
    const nextVersion = (knownVersion ?? 0) + 1;
    const row = { ...continuousStateToRow(userId, companionId, normalized), version: nextVersion };

    try {
      let result;
      if (knownVersion !== null) {
        // Optimistic update: only write if version hasn't changed since our last load/save.
        const updateResult = await this.client
          .from(this.table)
          .update(row)
          .eq('user_id', userId)
          .eq('companion_id', companionId)
          .eq('version', knownVersion)
          .select('*')
          .maybeSingle();
        if (updateResult.error) throw updateResult.error;
        if (updateResult.data === null) {
          // version mismatch → another process wrote newer data; log and return latest DB state.
          console.warn(`[state] optimistic lock conflict (${userId}/${companionId}) knownVersion=${knownVersion}; reloading from DB`);
          return this.load(normalizedScope);
        }
        result = updateResult;
      } else {
        // No cached version yet: use upsert for the first write from this process.
        let req = this.client
          .from(this.table)
          .upsert(row, { onConflict: 'user_id,companion_id' });
        if (typeof req?.select === 'function') req = req.select('*');
        if (typeof req?.maybeSingle === 'function') req = req.maybeSingle();
        else if (typeof req?.single === 'function') req = req.single();
        const upsertResult = await req;
        if (upsertResult?.error) throw upsertResult.error;
        result = upsertResult;
      }

      const saved = result?.data
        ? continuousStateFromRow(
            { ...row, ...result.data },
            { now: this.clock() },
          )
        : normalized;
      // Cache the version we just wrote (use the DB-returned version if available).
      this._versions.set(key, result?.data?.version ?? nextVersion);
      await this.fallback.save(saved, normalizedScope);
      return saved;
    } catch (error) {
      if (this.strict) throw error;
      console.error(`[state] DB write failed (${userId}/${companionId}):`, error?.message ?? error);
      return normalized;
    }
  }
}

export function createMemoryContinuousStateStore(options) {
  return new MemoryContinuousStateStore(options);
}

export const InMemoryContinuousStateStore = MemoryContinuousStateStore;

export function createInMemoryContinuousStateStore(options) {
  return new MemoryContinuousStateStore(options);
}

export function createSupabaseContinuousStateStore(options) {
  return new SupabaseContinuousStateStore(options);
}

export function createContinuousStateStore({ client, ...options } = {}) {
  return client
    ? new SupabaseContinuousStateStore({ client, ...options })
    : new MemoryContinuousStateStore(options);
}

let defaultStore = new MemoryContinuousStateStore();

export function getDefaultContinuousStateStore() {
  return defaultStore;
}

export function setDefaultContinuousStateStore(store) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('continuous state store requires load() and save()');
  }
  defaultStore = store;
  return defaultStore;
}

export async function loadState(
  userId,
  companionId = DEFAULT_COMPANION_ID,
  options = {},
) {
  const store = resolveStore(options);
  const now = options?.now ?? Date.now();
  const state = await store.load({ userId, companionId });
  return normalizeContinuousState(state, { now: resolveNow(now) });
}

export async function saveState(
  userId,
  companionId = DEFAULT_COMPANION_ID,
  state,
  options = {},
) {
  const store = resolveStore(options);
  const now = options?.now ?? Date.now();
  const normalized = normalizeContinuousState(state, { now: resolveNow(now) });
  return store.save(normalized, { userId, companionId });
}

export function continuousStateFromRow(row = {}, { now = Date.now() } = {}) {
  const updatedAt = validIso(row.updated_at) ?? validIso(now) ?? new Date().toISOString();
  return normalizeContinuousState(
    {
      emotional: {
        current_emotion: row.current_emotion,
        emotion_intensity: row.emotion_intensity,
        valence: row.valence,
        persistence: row.emotion_persistence ?? row.persistence,
        label: row.emotion_label ?? null,
        weekly_distribution: row.weekly_distribution,
        emotion_history: row.emotion_history,
      },
      temporal: {
        longing: row.longing,
        anticipation: row.anticipation,
        fatigue: row.fatigue,
        last_interaction: row.last_interaction_at ?? row.last_interaction ?? updatedAt,
        expected_next: row.expected_next_message_at ?? row.expected_next,
        prediction_confidence: row.prediction_confidence,
      },
      cognitive: {
        active_thoughts: row.active_thoughts,
        unfinished_topics: row.unfinished_topics,
        memory_surfaced: row.memory_surfaced,
        attention_focus: row.attention_focus,
      },
      volitional: {
        proactive_desire: row.proactive_desire,
        desire_reason: row.desire_reason,
        contact_inhibit: row.contact_inhibit,
      },
      self: {
        coherence_score: row.coherence_score,
        identity_anchors: row.identity_anchors,
        recent_drift: row.recent_drift,
      },
      updated_at: updatedAt,
    },
    { now },
  );
}

export function continuousStateToRow(userId, companionId, state) {
  assertScope(userId, companionId);
  const normalized = normalizeContinuousState(state);
  return {
    user_id: String(userId),
    companion_id: String(companionId),
    current_emotion: normalized.emotional.current_emotion,
    emotion_intensity: normalized.emotional.emotion_intensity,
    valence: normalized.emotional.valence,
    emotion_persistence: normalized.emotional.persistence,
    emotion_label: normalized.emotional.label ?? null,
    weekly_distribution: normalized.emotional.weekly_distribution,
    emotion_history: normalized.emotional.emotion_history,
    longing: normalized.temporal.longing,
    anticipation: normalized.temporal.anticipation,
    fatigue: normalized.temporal.fatigue,
    last_interaction_at: normalized.temporal.last_interaction,
    expected_next_message_at: normalized.temporal.expected_next,
    prediction_confidence: normalized.temporal.prediction_confidence,
    active_thoughts: normalized.cognitive.active_thoughts,
    unfinished_topics: normalized.cognitive.unfinished_topics,
    memory_surfaced: normalized.cognitive.memory_surfaced,
    attention_focus: normalized.cognitive.attention_focus,
    proactive_desire: normalized.volitional.proactive_desire,
    desire_reason: normalized.volitional.desire_reason,
    contact_inhibit: normalized.volitional.contact_inhibit,
    coherence_score: normalized.self.coherence_score,
    identity_anchors: normalized.self.identity_anchors,
    recent_drift: normalized.self.recent_drift,
    updated_at: normalized.updated_at,
  };
}

function resolveStore(options) {
  if (options && typeof options.load === 'function' && typeof options.save === 'function') {
    return options;
  }
  return options?.store ?? defaultStore;
}

function normalizeScope(scope) {
  if (typeof scope === 'string') {
    return { userId: scopeText(scope), companionId: DEFAULT_COMPANION_ID };
  }
  return {
    userId: scopeText(scope?.userId ?? scope?.user_id),
    companionId:
      scopeText(scope?.companionId ?? scope?.companion_id) ?? DEFAULT_COMPANION_ID,
  };
}

function assertScope(userId, companionId) {
  if (!scopeText(userId)) throw new Error('continuous state requires userId');
  if (!scopeText(companionId)) throw new Error('continuous state requires companionId');
}

function scopeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function scopeKey(userId, companionId) {
  return JSON.stringify([String(userId), String(companionId)]);
}

function safeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_COLLECTION_ITEMS).map(cloneValue);
}

function cloneNullable(value) {
  return value == null ? null : cloneValue(value);
}

function clonePlainObject(value) {
  return cloneValue(plainObject(value));
}

function cloneValue(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validIso(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function resolveNow(value) {
  const resolved = typeof value === 'function' ? value() : value;
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  return Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
}

function textOr(value, fallback) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function textOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value) {
  return clamp(finite(value, 0), 0, 1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
