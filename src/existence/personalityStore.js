import { normalizePersonalitySystem } from './personalityCompiler.js';

const memoryRows = new Map();

function scopeKey(userId, companionId = 'default') {
  if (!String(userId || '').trim()) throw new Error('personality store requires userId');
  if (!String(companionId || '').trim()) throw new Error('personality store requires companionId');
  return `${userId}::${companionId}`;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function personalityFromRow(row = {}) {
  if (!row) return null;
  return normalizePersonalitySystem({
    core_values: row.core_values,
    behavioral_patterns: row.behavioral_patterns,
    emotional_signature: row.emotional_signature,
    drift_history: row.drift_history,
    self_model: row.self_model,
    version: row.version,
    updated_at: row.updated_at,
  });
}

export function personalityToRow(userId, companionId = 'default', personality = {}, now = new Date()) {
  const normalized = normalizePersonalitySystem(personality);
  return {
    user_id: String(userId),
    companion_id: String(companionId),
    core_values: normalized.core_values,
    behavioral_patterns: normalized.behavioral_patterns,
    emotional_signature: normalized.emotional_signature,
    drift_history: normalized.drift_history ?? [],
    self_model: normalized.self_model ?? {},
    version: Math.max(1, Number(normalized.version) || 1),
    updated_at: new Date(now).toISOString(),
  };
}

export function createMemoryPersonalityStore(initial = []) {
  const rows = new Map();
  for (const item of initial ?? []) {
    if (!item?.user_id) continue;
    rows.set(scopeKey(item.user_id, item.companion_id), clone(item));
  }
  return {
    async load({ userId, companionId = 'default' } = {}) {
      const row = rows.get(scopeKey(userId, companionId));
      return row ? personalityFromRow(clone(row)) : null;
    },
    async save(personality, { userId, companionId = 'default', now = new Date() } = {}) {
      const row = personalityToRow(userId, companionId, personality, now);
      rows.set(scopeKey(userId, companionId), clone(row));
      return personalityFromRow(row);
    },
    async clear({ userId, companionId = 'default' } = {}) {
      rows.delete(scopeKey(userId, companionId));
    },
  };
}

export function createSharedMemoryPersonalityStore() {
  return {
    async load({ userId, companionId = 'default' } = {}) {
      const row = memoryRows.get(scopeKey(userId, companionId));
      return row ? personalityFromRow(clone(row)) : null;
    },
    async save(personality, { userId, companionId = 'default', now = new Date() } = {}) {
      const row = personalityToRow(userId, companionId, personality, now);
      memoryRows.set(scopeKey(userId, companionId), clone(row));
      return personalityFromRow(row);
    },
  };
}

export function createSupabasePersonalityStore({
  client,
  table = 'companion_personality',
  fallback = createSharedMemoryPersonalityStore(),
} = {}) {
  if (!client?.from) return fallback;
  return {
    async load({ userId, companionId = 'default' } = {}) {
      scopeKey(userId, companionId);
      try {
        const { data, error } = await client
          .from(table)
          .select('*')
          .eq('user_id', userId)
          .eq('companion_id', companionId)
          .maybeSingle();
        if (error) throw error;
        return data ? personalityFromRow(data) : null;
      } catch {
        return fallback.load({ userId, companionId });
      }
    },
    async save(personality, { userId, companionId = 'default', now = new Date() } = {}) {
      const row = personalityToRow(userId, companionId, personality, now);
      try {
        const { data, error } = await client
          .from(table)
          .upsert(row, { onConflict: 'user_id,companion_id' })
          .select('*')
          .single();
        if (error) throw error;
        await fallback.save(personalityFromRow(data), { userId, companionId, now });
        return personalityFromRow(data);
      } catch {
        return fallback.save(personality, { userId, companionId, now });
      }
    },
  };
}
