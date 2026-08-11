const sharedRows = new Map();

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function normalizeEnvelope(envelope = {}) {
  if (envelope.visibility !== 'private') {
    throw new Error('private memory store rejects non-private visibility');
  }
  const userId = String(envelope.scope?.userId || '').trim();
  const companionId = String(envelope.scope?.companionId || 'default').trim();
  const content = String(envelope.record?.content || '').trim();
  const key = String(envelope.idempotencyKey || '').trim();
  if (!userId || !companionId || !content || !key) {
    throw new Error('private memory requires scope, content and idempotencyKey');
  }
  const sourceTurnIds = Array.isArray(envelope.metadata?.sourceTurnIds)
    ? envelope.metadata.sourceTurnIds.map(String).filter(Boolean)
    : [];
  return {
    user_id: userId,
    companion_id: companionId,
    type: envelope.record?.type ?? 'inner_monologue',
    content,
    emotional_valence: clampSigned(envelope.record?.emotional_valence),
    created_during_silence: envelope.record?.created_during_silence === true,
    silence_window_key: key,
    source_turn_ids: sourceTurnIds,
    metadata: {
      ...(envelope.metadata ?? {}),
      visibility: 'private',
    },
    created_at: validIso(envelope.metadata?.createdAt) ?? new Date().toISOString(),
  };
}

function rowKey(row) {
  return `${row.user_id}::${row.companion_id}::${row.silence_window_key}`;
}

export function createMemoryPrivateMemoryStore({ shared = false } = {}) {
  const rows = shared ? sharedRows : new Map();
  return {
    async save(envelope) {
      const row = normalizeEnvelope(envelope);
      const key = rowKey(row);
      if (rows.has(key)) return clone(rows.get(key));
      rows.set(key, clone(row));
      return clone(row);
    },
    async list({ userId, companionId = 'default' } = {}) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.user_id === String(userId) &&
            row.companion_id === String(companionId),
        )
        .map(clone);
    },
  };
}

export function createSupabasePrivateMemoryStore({
  client,
  table = 'companion_private_memory',
  fallback = createMemoryPrivateMemoryStore({ shared: true }),
} = {}) {
  if (!client?.from) return fallback;
  return {
    async save(envelope) {
      const row = normalizeEnvelope(envelope);
      try {
        const { data, error } = await client
          .from(table)
          .insert(row)
          .select('*')
          .single();
        if (error) {
          if (error.code === '23505') {
            const existing = await loadExisting(client, table, row);
            if (existing) return existing;
          }
          throw error;
        }
        await fallback.save(envelope);
        return data;
      } catch (error) {
        if (error?.code === '23505') {
          const existing = await loadExisting(client, table, row).catch(() => null);
          if (existing) return existing;
        }
        return fallback.save(envelope);
      }
    },
    async list({ userId, companionId = 'default', limit = 50 } = {}) {
      try {
        const { data, error } = await client
          .from(table)
          .select('*')
          .eq('user_id', userId)
          .eq('companion_id', companionId)
          .order('created_at', { ascending: false })
          .limit(Math.max(1, Math.min(200, Number(limit) || 50)));
        if (error) throw error;
        return data ?? [];
      } catch {
        return fallback.list({ userId, companionId });
      }
    },
  };
}

async function loadExisting(client, table, row) {
  const { data, error } = await client
    .from(table)
    .select('*')
    .eq('user_id', row.user_id)
    .eq('companion_id', row.companion_id)
    .eq('silence_window_key', row.silence_window_key)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

function validIso(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampSigned(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-1, Math.min(1, number));
}
