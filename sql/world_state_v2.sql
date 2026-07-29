-- World State v2 — structured facts (W-1)
-- Idempotent: safe to run multiple times.
-- Adds stable_facts (location, season override, upcoming events) to world_state.

alter table world_state
  add column if not exists stable_facts jsonb not null default '{}'::jsonb;

-- Ensure weather cache column exists for in-DB weather caching (W-3 optional)
alter table world_state
  add column if not exists weather_cache jsonb;
