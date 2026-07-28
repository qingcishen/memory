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
alter table beliefs drop constraint if exists beliefs_valid_interval_check;
alter table beliefs add constraint beliefs_valid_interval_check
  check (valid_from is null or valid_to is null or valid_to > valid_from);

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

create or replace function forget_memory_beliefs(
  p_user_id text,
  p_companion_id text,
  p_memory_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_evidence_count int := 0;
  deleted_belief_ids uuid[] := '{}'::uuid[];
begin
  with affected as (
    select distinct belief_id
    from belief_evidence
    where user_id = p_user_id
      and companion_id = coalesce(p_companion_id, 'default')
      and source_memory_id = any(coalesce(p_memory_ids, '{}'::uuid[]))
  ),
  removed as (
    delete from belief_evidence
    where user_id = p_user_id
      and companion_id = coalesce(p_companion_id, 'default')
      and source_memory_id = any(coalesce(p_memory_ids, '{}'::uuid[]))
    returning belief_id
  ),
  evidence_count as (
    select count(*)::int as count from removed
  ),
  orphaned as (
    select affected.belief_id
    from affected
    cross join (select count(*) from removed) removed_barrier
    where not exists (
      select 1 from belief_evidence
      where belief_evidence.belief_id = affected.belief_id
        and (
          belief_evidence.source_memory_id is null
          or not (
            belief_evidence.source_memory_id =
            any(coalesce(p_memory_ids, '{}'::uuid[]))
          )
        )
    )
  ),
  deleted_beliefs as (
    delete from beliefs
    using orphaned
    where beliefs.id = orphaned.belief_id
      and beliefs.user_id = p_user_id
      and beliefs.companion_id = coalesce(p_companion_id, 'default')
    returning beliefs.id
  )
  select
    evidence_count.count,
    coalesce(array_agg(deleted_beliefs.id) filter (where deleted_beliefs.id is not null), '{}'::uuid[])
  into deleted_evidence_count, deleted_belief_ids
  from evidence_count
  left join deleted_beliefs on true
  group by evidence_count.count;

  return jsonb_build_object(
    'evidence_deleted', deleted_evidence_count,
    'beliefs_deleted', to_jsonb(deleted_belief_ids)
  );
end;
$$;

revoke all on function forget_memory_beliefs(text,text,uuid[])
  from public, anon, authenticated;
grant execute on function forget_memory_beliefs(text,text,uuid[])
  to service_role;

alter table public.beliefs enable row level security;
alter table public.belief_evidence enable row level security;
