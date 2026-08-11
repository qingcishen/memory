-- Continuous Existence Engine v1
-- Idempotent migration for the shared inner state, private memory and
-- parameterized personality model described in docs/continuous-existence-engine.md.

create extension if not exists pgcrypto;

create table if not exists companion_continuous_state (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  text not null,
  companion_id             text not null default 'default',

  current_emotion          text not null default 'neutral',
  emotion_intensity        real not null default 0 check (emotion_intensity between 0 and 1),
  valence                  real not null default 0 check (valence between -1 and 1),
  emotion_persistence      real not null default 30 check (emotion_persistence >= 0),

  longing                  real not null default 0 check (longing between 0 and 1),
  anticipation             real not null default 0 check (anticipation between 0 and 1),
  fatigue                  real not null default 0 check (fatigue between 0 and 1),
  last_interaction_at      timestamptz not null default now(),
  expected_next_message_at timestamptz,
  prediction_confidence    real not null default 0 check (prediction_confidence between 0 and 1),

  active_thoughts          jsonb not null default '[]'::jsonb,
  unfinished_topics        jsonb not null default '[]'::jsonb,
  memory_surfaced          jsonb,
  attention_focus          text,

  proactive_desire         real not null default 0 check (proactive_desire between 0 and 1),
  desire_reason            text,
  contact_inhibit          real not null default 0 check (contact_inhibit between 0 and 1),

  coherence_score          real not null default 1 check (coherence_score between 0 and 1),
  identity_anchors         jsonb not null default '[]'::jsonb,
  recent_drift             jsonb not null default '{}'::jsonb,

  version                  int not null default 1 check (version >= 1),
  updated_at               timestamptz not null default now(),
  unique (user_id, companion_id)
);
alter table companion_continuous_state
  add column if not exists emotion_persistence real not null default 30;
alter table companion_continuous_state
  add column if not exists last_interaction_at timestamptz not null default now();
alter table companion_continuous_state
  add column if not exists attention_focus text;
alter table companion_continuous_state
  add column if not exists identity_anchors jsonb not null default '[]'::jsonb;
alter table companion_continuous_state
  add column if not exists recent_drift jsonb not null default '{}'::jsonb;
alter table companion_continuous_state
  add column if not exists version int not null default 1;
-- E-2: 持久情绪标签（EMOTION_LABELS 中文），跨重启恢复情绪残差。
alter table companion_continuous_state
  add column if not exists emotion_label text;
-- E-4: 7-day emotion arc plus the compact journal projection used to rebuild it.
alter table companion_continuous_state
  add column if not exists weekly_distribution jsonb not null
  default '{"labels":{},"dominant":"平静","trend":"stable"}'::jsonb;
alter table companion_continuous_state
  add column if not exists emotion_history jsonb not null default '[]'::jsonb;

create index if not exists companion_continuous_state_updated_idx
  on companion_continuous_state (updated_at);
create index if not exists companion_continuous_state_interaction_idx
  on companion_continuous_state (user_id, companion_id, last_interaction_at desc);

create table if not exists companion_private_memory (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  text not null,
  companion_id             text not null default 'default',
  type                     text not null
                           check (type in ('inner_monologue', 'consolidation', 'self_reflection')),
  content                  text not null check (length(trim(content)) > 0),
  emotional_valence        real check (emotional_valence between -1 and 1),
  created_during_silence   boolean not null default false,
  silence_window_key       text,
  source_turn_ids          jsonb not null default '[]'::jsonb,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now()
);
alter table companion_private_memory
  add column if not exists silence_window_key text;
alter table companion_private_memory
  add column if not exists source_turn_ids jsonb not null default '[]'::jsonb;
alter table companion_private_memory
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists companion_private_memory_scope_idx
  on companion_private_memory (user_id, companion_id, created_at desc);
create unique index if not exists companion_private_memory_silence_unique_idx
  on companion_private_memory (user_id, companion_id, silence_window_key)
  where silence_window_key is not null;

create table if not exists companion_personality (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  text not null,
  companion_id             text not null default 'default',
  core_values              jsonb not null default '{}'::jsonb,
  behavioral_patterns      jsonb not null default '{}'::jsonb,
  emotional_signature      jsonb not null default '{}'::jsonb,
  drift_history            jsonb not null default '[]'::jsonb,
  self_model               jsonb not null default '{}'::jsonb,
  version                  int not null default 1 check (version >= 1),
  updated_at               timestamptz not null default now(),
  unique (user_id, companion_id)
);

create index if not exists companion_personality_updated_idx
  on companion_personality (updated_at);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'companion_continuous_state',
    'companion_private_memory',
    'companion_personality'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
