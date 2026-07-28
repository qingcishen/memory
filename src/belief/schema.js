import { z } from 'zod';

export const BeliefKindSchema = z.enum([
  'identity',
  'preference',
  'event',
  'commitment',
  'relationship',
  'general',
]);

export const EpistemicStatusSchema = z.enum(['asserted', 'inferred', 'uncertain']);
export const EvidenceSourceKindSchema = z.enum([
  'user',
  'assistant',
  'external',
  'inference',
  'memory',
  'system',
]);

export const BeliefRecordSchema = z.object({
  belief_key: z.string().min(32),
  slot_key: z.string().min(1).nullable(),
  subject_key: z.string().min(1),
  subject_label: z.string().min(1),
  predicate: z.string().min(1),
  object_value: z.unknown(),
  object_text: z.string().min(1),
  belief_kind: BeliefKindSchema,
  epistemic_status: EpistemicStatusSchema,
  confidence: z.number().min(0).max(1),
  valid_from: z.string().datetime().nullable(),
  valid_to: z.string().datetime().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const BeliefEvidenceSchema = z.object({
  source_kind: EvidenceSourceKindSchema,
  source_id: z.string().min(1).nullable(),
  source_memory_id: z.string().min(1).nullable(),
  evidence_text: z.string().min(1).nullable(),
  evidence_hash: z.string().length(64),
  supports: z.boolean(),
  confidence: z.number().min(0).max(1),
  observed_at: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()),
});

export const BeliefQuerySchema = z.object({
  subjectKey: z.string().min(1).optional(),
  predicate: z.string().min(1).optional(),
  slotKey: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
