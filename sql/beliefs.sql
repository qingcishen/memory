-- ============================================================
--  Cyber Memory · Temporal Belief Engine v1
--  可独立重复执行。依赖 sql/schema.sql 已创建 memories 表。
--  与 schema.sql 中的 B4 段保持同步。
-- ============================================================

create table if not exists beliefs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            text not null,
  companion_id       text not null default 'default',
  belief_key         text not null,
  slot_key           text,
  subject_key        text not null,
  subject_label      text not null,
  predicate          text not null,
  object_value       jsonb not null,
  object_text        text not null,
  belief_kind        text not null default 'general'
                     check (belief_kind in ('identity','preference','event','commitment','relationship','general')),
  epistemic_status   text not null default 'asserted'
                     check (epistemic_status in ('asserted','inferred','uncertain')),
  confidence         real not null default 0.7 check (confidence >= 0 and confidence <= 1),
  status             text not null default 'active'
                     check (status in ('active','superseded','retracted')),
  valid_from         timestamptz,
  valid_to           timestamptz,
  first_observed_at  timestamptz not null default now(),
  last_confirmed_at  timestamptz not null default now(),
  observation_count  int not null default 1 check (observation_count >= 1),
  superseded_by      uuid references beliefs(id) on delete set null,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table beliefs drop constraint if exists beliefs_user_id_companion_id_belief_key_key;

create table if not exists belief_evidence (
  id                 uuid primary key default gen_random_uuid(),
  belief_id          uuid not null references beliefs(id) on delete cascade,
  user_id            text not null,
  companion_id       text not null default 'default',
  source_kind        text not null
                     check (source_kind in ('user','assistant','external','inference','memory','system')),
  source_id          text,
  source_memory_id   uuid references memories(id) on delete set null,
  evidence_text      text,
  evidence_hash      text not null,
  supports           boolean not null default true,
  confidence         real not null default 0.7 check (confidence >= 0 and confidence <= 1),
  observed_at        timestamptz not null default now(),
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (belief_id, evidence_hash)
);

create index if not exists beliefs_current_subject_idx
  on beliefs (user_id, companion_id, subject_key, predicate, updated_at desc)
  where status = 'active';
create unique index if not exists beliefs_current_key_unique_idx
  on beliefs (user_id, companion_id, belief_key)
  where status = 'active';
create index if not exists beliefs_current_slot_idx
  on beliefs (user_id, companion_id, slot_key, updated_at desc)
  where status = 'active' and slot_key is not null;
create index if not exists beliefs_history_idx
  on beliefs (user_id, companion_id, subject_key, predicate, created_at desc);
create index if not exists belief_evidence_belief_idx
  on belief_evidence (belief_id, observed_at desc);
create index if not exists belief_evidence_source_idx
  on belief_evidence (user_id, companion_id, source_kind, source_id);

alter table public.beliefs enable row level security;
alter table public.belief_evidence enable row level security;
