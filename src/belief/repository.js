import { supabase } from '../config.js';
import { normalizeBelief, normalizeEvidence } from './ontology.js';
import { BeliefQuerySchema } from './schema.js';

/**
 * Supabase-backed temporal belief repository。
 * 所有查询强制带 (user_id, companion_id)，避免跨角色泄漏。
 */
export class BeliefRepository {
  constructor({ client = supabase } = {}) {
    this.client = client;
  }

  async project(userId, companionId = 'default', rawBelief, rawEvidence = {}, opts = {}) {
    assertScope(userId, companionId);
    const belief = normalizeBelief(rawBelief, {
      sourceKind: rawEvidence.sourceKind ?? rawEvidence.source_kind,
    });
    const evidence = normalizeEvidence(rawEvidence, {
      confidence: belief.confidence,
    });
    const now = evidence.observed_at;

    const existing = await this.findByKey(userId, companionId, belief.belief_key);
    if (existing) {
      const updated = await this.reinforce(existing, belief, now);
      await this.insertEvidence(userId, companionId, updated.id, evidence);
      return { belief: updated, created: false, reinforced: true, superseded: [] };
    }

    const row = {
      user_id: userId,
      companion_id: companionId,
      ...belief,
      first_observed_at: now,
      last_confirmed_at: now,
      observation_count: 1,
      status: 'active',
      updated_at: now,
    };
    const inserted = await insertOne(this.client, 'beliefs', row);
    const superseded = belief.slot_key && opts.supersedeSlot !== false
      ? await this.supersedeSlot(userId, companionId, belief.slot_key, inserted.id, now)
      : [];
    await this.insertEvidence(userId, companionId, inserted.id, evidence);
    return { belief: inserted, created: true, reinforced: false, superseded };
  }

  async current(userId, companionId = 'default', query = {}) {
    assertScope(userId, companionId);
    query = BeliefQuerySchema.parse(query);
    const at = query.at ?? new Date().toISOString();
    let request = this.client
      .from('beliefs')
      .select('*')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('status', 'active')
      .or(`valid_from.is.null,valid_from.lte.${at}`)
      .or(`valid_to.is.null,valid_to.gt.${at}`);
    if (query.subjectKey) request = request.eq('subject_key', query.subjectKey);
    if (query.predicate) request = request.eq('predicate', query.predicate);
    if (query.slotKey) request = request.eq('slot_key', query.slotKey);
    request = request.order('confidence', { ascending: false }).order('updated_at', { ascending: false });
    if (query.limit) request = request.limit(query.limit);
    const { data, error } = await request;
    if (error) throw error;
    return data ?? [];
  }

  async history(userId, companionId = 'default', query = {}) {
    assertScope(userId, companionId);
    query = BeliefQuerySchema.parse(query);
    let request = this.client
      .from('beliefs')
      .select('*')
      .eq('user_id', userId)
      .eq('companion_id', companionId);
    if (query.subjectKey) request = request.eq('subject_key', query.subjectKey);
    if (query.predicate) request = request.eq('predicate', query.predicate);
    if (query.slotKey) request = request.eq('slot_key', query.slotKey);
    request = request.order('created_at', { ascending: false });
    if (query.limit) request = request.limit(query.limit);
    const { data, error } = await request;
    if (error) throw error;
    return data ?? [];
  }

  async resolve(userId, companionId = 'default', query = {}) {
    const rows = await this.current(userId, companionId, query);
    if (rows.length === 0) {
      return {
        status: 'unknown',
        beliefs: [],
        confidence: 0,
        provenance: [],
      };
    }
    const beliefs = await Promise.all(
      rows.map(async (belief) => ({
        ...belief,
        evidence: await this.evidenceFor(userId, companionId, belief.id),
      })),
    );
    return {
      status: beliefs.some((row) => row.epistemic_status === 'asserted') ? 'current' : 'uncertain',
      beliefs,
      confidence: Math.max(...beliefs.map((row) => Number(row.confidence) || 0)),
      provenance: beliefs.flatMap((row) =>
        row.evidence.map((evidence) => ({
          beliefId: row.id,
          sourceKind: evidence.source_kind,
          sourceId: evidence.source_id,
          sourceMemoryId: evidence.source_memory_id,
          observedAt: evidence.observed_at,
          confidence: evidence.confidence,
        })),
      ),
    };
  }

  async findByKey(userId, companionId, beliefKey) {
    const { data, error } = await this.client
      .from('beliefs')
      .select('*')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('belief_key', beliefKey)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }

  async reinforce(existing, incoming, now) {
    const count = Number(existing.observation_count) || 1;
    const confidence = combineConfidence(existing.confidence, incoming.confidence);
    const { data, error } = await this.client
      .from('beliefs')
      .update({
        confidence,
        epistemic_status:
          existing.epistemic_status === 'asserted' || incoming.epistemic_status === 'asserted'
            ? 'asserted'
            : incoming.epistemic_status,
        observation_count: count + 1,
        last_confirmed_at: now,
        updated_at: now,
      })
      .eq('id', existing.id)
      .eq('user_id', existing.user_id)
      .eq('companion_id', existing.companion_id)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  async supersedeSlot(userId, companionId, slotKey, newId, now) {
    const { data, error } = await this.client
      .from('beliefs')
      .update({
        status: 'superseded',
        superseded_by: newId,
        valid_to: now,
        updated_at: now,
      })
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('slot_key', slotKey)
      .eq('status', 'active')
      .neq('id', newId)
      .select('id');
    if (error) throw error;
    return (data ?? []).map((row) => row.id);
  }

  async insertEvidence(userId, companionId, beliefId, evidence) {
    const row = {
      belief_id: beliefId,
      user_id: userId,
      companion_id: companionId,
      ...evidence,
    };
    const { data, error } = await this.client
      .from('belief_evidence')
      .upsert(row, { onConflict: 'belief_id,evidence_hash', ignoreDuplicates: true })
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return data ?? row;
  }

  async evidenceFor(userId, companionId, beliefId) {
    const { data, error } = await this.client
      .from('belief_evidence')
      .select('*')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('belief_id', beliefId)
      .order('observed_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  async forgetMemoryIds(userId, companionId = 'default', memoryIds = []) {
    assertScope(userId, companionId);
    const ids = [...new Set(
      (memoryIds ?? []).map(String).filter((id) => id.trim()),
    )];
    if (ids.length === 0) return { evidenceDeleted: 0, beliefsDeleted: [] };
    const { data, error } = await this.client.rpc('forget_memory_beliefs', {
      p_user_id: userId,
      p_companion_id: companionId,
      p_memory_ids: ids,
    });
    if (error) throw error;
    return {
      evidenceDeleted: Number(data?.evidence_deleted) || 0,
      beliefsDeleted: Array.isArray(data?.beliefs_deleted)
        ? data.beliefs_deleted.map(String)
        : [],
    };
  }
}

export function combineConfidence(a, b) {
  const left = clamp01(a);
  const right = clamp01(b);
  return Math.min(0.999, 1 - (1 - left) * (1 - right));
}

async function insertOne(client, table, row) {
  const { data, error } = await client.from(table).insert(row).select('*').single();
  if (error) throw error;
  return data;
}

function assertScope(userId, companionId) {
  if (!String(userId || '').trim()) throw new Error('belief query requires userId');
  if (!String(companionId || '').trim()) throw new Error('belief query requires companionId');
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}
