import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schemaSql = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const beliefSql = readFileSync(new URL('../sql/beliefs.sql', import.meta.url), 'utf8');
const turnEventSql = readFileSync(new URL('../sql/turn_events.sql', import.meta.url), 'utf8');

describe('SQL migration contract parity', () => {
  it('keeps temporal belief interval constraints in both install paths', () => {
    for (const sql of [schemaSql, beliefSql]) {
      expect(sql).toContain('constraint beliefs_valid_interval_check');
      expect(sql).toContain('valid_to > valid_from');
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
});
