import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schemaSql = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const beliefSql = readFileSync(new URL('../sql/beliefs.sql', import.meta.url), 'utf8');
const turnEventSql = readFileSync(new URL('../sql/turn_events.sql', import.meta.url), 'utf8');
const continuousStateSql = readFileSync(
  new URL('../sql/continuous_state.sql', import.meta.url),
  'utf8',
);
const memoryCompressionSql = readFileSync(
  new URL('../sql/memory_compression.sql', import.meta.url),
  'utf8',
);

describe('SQL migration contract parity', () => {
  it('keeps temporal belief interval constraints in both install paths', () => {
    for (const sql of [schemaSql, beliefSql]) {
      expect(sql).toContain('constraint beliefs_valid_interval_check');
      expect(sql).toContain('valid_to > valid_from');
      expect(sql).toContain('function supersede_belief_slot(');
      expect(sql).toContain("valid_from + interval '1 microsecond'");
      expect(sql).toContain('function forget_memory_beliefs(');
      expect(sql).toContain('delete from belief_evidence');
      expect(sql).toContain('delete from beliefs');
    }
  });

  it('keeps turn-event renewal and expiry fencing in both install paths', () => {
    for (const sql of [schemaSql, turnEventSql]) {
      expect(sql).toContain('function renew_turn_event_lease(');
      expect(sql).toContain('and lease_expires_at > now()');
      expect(sql).toContain(
        'grant execute on function renew_turn_event_lease(text,text,text,text,int)',
      );
    }
  });

  it('keeps continuous-existence tables and silence dedupe in both install paths', () => {
    for (const sql of [schemaSql, continuousStateSql]) {
      expect(sql).toContain('companion_continuous_state');
      expect(sql).toContain('companion_private_memory');
      expect(sql).toContain('companion_personality');
      expect(sql).toContain('companion_private_memory_silence_unique_idx');
      expect(sql).toContain('last_interaction_at');
      expect(sql).toContain('coherence_score');
    }
  });

  it('keeps atomic memory compression in both install paths', () => {
    for (const sql of [schemaSql, memoryCompressionSql]) {
      expect(sql).toContain('function commit_memory_compression(');
      expect(sql).toContain("type in ('episode', 'fact')");
      expect(sql).toContain('set superseded_by = v_summary_id');
      expect(sql).toContain(
        'grant execute on function commit_memory_compression(text,text,uuid[],jsonb)',
      );
    }
  });
});
