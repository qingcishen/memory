-- ============================================================
--  Cyber Memory · Turn Event Ledger v1
--  跨进程 Commit 竞争仲裁与可审计状态。可独立重复执行。
-- ============================================================

create table if not exists turn_events (
  id             bigint generated always as identity primary key,
  user_id        text not null,
  companion_id   text not null default 'default',
  event_id       text not null,
  event_type     text not null default 'reply.commit',
  status         text not null default 'processing'
                 check (status in ('processing','committed','failed')),
  payload        jsonb not null default '{}'::jsonb,
  result         jsonb,
  attempts       int not null default 1 check (attempts >= 1),
  last_error     text,
  committed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, companion_id, event_id)
);

create index if not exists turn_events_status_idx
  on turn_events (status, updated_at);
create index if not exists turn_events_scope_idx
  on turn_events (user_id, companion_id, created_at desc);

alter table public.turn_events enable row level security;
notify pgrst, 'reload schema';
