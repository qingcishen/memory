import { BeliefRepository } from './repository.js';

/**
 * Temporal Belief Engine v1。
 * 只消费显式结构化 belief，不从自然语言静默猜三元组。
 */
export class BeliefEngine {
  constructor({ userId, companionId = 'default', repository } = {}) {
    if (!userId) throw new Error('BeliefEngine requires userId');
    this.userId = userId;
    this.companionId = companionId;
    this.repository = repository ?? new BeliefRepository();
  }

  project(belief, evidence, opts) {
    return this.repository.project(
      this.userId,
      this.companionId,
      belief,
      evidence,
      opts,
    );
  }

  async projectMemory(memory, opts = {}) {
    const candidates = explicitBeliefsFromMemory(memory);
    const results = [];
    for (const belief of candidates) {
      results.push(
        await this.project(
          belief,
          {
            sourceKind: memory.source?.speaker === 'user' ? 'user' : 'memory',
            sourceId: memory.source?.eventId ?? memory.source?.event_id ?? null,
            sourceMemoryId: memory.id ?? null,
            evidenceText: memory.fact_core ?? memory.content ?? '',
            observedAt: memory.created_at,
            confidence: belief.confidence,
          },
          opts,
        ),
      );
    }
    return results;
  }

  async projectEvent(event = {}, opts = {}) {
    const beliefs = Array.isArray(event.beliefs) ? event.beliefs : [];
    const results = [];
    for (const belief of beliefs) {
      results.push(
        await this.project(
          belief,
          {
            sourceKind: event.sourceKind ?? event.source_kind ?? 'inference',
            sourceId: event.id ?? event.eventId ?? event.event_id,
            evidenceText: event.evidenceText ?? event.evidence_text ?? event.text,
            observedAt: event.observedAt ?? event.observed_at ?? event.ts,
            confidence: belief.confidence ?? event.confidence,
          },
          opts,
        ),
      );
    }
    return results;
  }

  current(query = {}) {
    return this.repository.current(this.userId, this.companionId, query);
  }

  history(query = {}) {
    return this.repository.history(this.userId, this.companionId, query);
  }

  resolve(query = {}) {
    return this.repository.resolve(this.userId, this.companionId, query);
  }
}

export function explicitBeliefsFromMemory(memory = {}) {
  if (memory.belief && typeof memory.belief === 'object') return [memory.belief];
  if (Array.isArray(memory.beliefs)) return memory.beliefs;
  if (Array.isArray(memory.source?.beliefs)) return memory.source.beliefs;
  return [];
}

export {
  BELIEF_KINDS,
  EPISTEMIC_STATUSES,
  EVIDENCE_SOURCE_KINDS,
  beliefKey,
  normalizeBelief,
  normalizeEvidence,
  sameBelief,
} from './ontology.js';
export { BeliefRepository, combineConfidence } from './repository.js';
export {
  BeliefKindSchema,
  EpistemicStatusSchema,
  EvidenceSourceKindSchema,
  BeliefRecordSchema,
  BeliefEvidenceSchema,
  BeliefQuerySchema,
} from './schema.js';
