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
  projection_state jsonb not null default '{}'::jsonb,
  result         jsonb,
  attempts       int not null default 1 check (attempts >= 1),
  lease_token    text,
  lease_expires_at timestamptz,
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

alter table turn_events add column if not exists lease_token text;
alter table turn_events add column if not exists lease_expires_at timestamptz;
alter table turn_events add column if not exists projection_state jsonb not null default '{}'::jsonb;

create or replace function claim_turn_event(
  p_user_id text,
  p_companion_id text,
  p_event_id text,
  p_lease_token text,
  p_lease_seconds int default 120,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed turn_events%rowtype;
begin
  insert into turn_events (
    user_id, companion_id, event_id, event_type, status, payload,
    attempts, lease_token, lease_expires_at, updated_at
  ) values (
    p_user_id, coalesce(p_companion_id, 'default'), p_event_id, 'reply.commit',
    'processing', coalesce(p_payload, '{}'::jsonb), 1, p_lease_token,
    now() + make_interval(secs => greatest(10, least(coalesce(p_lease_seconds, 120), 3600))),
    now()
  )
  on conflict (user_id, companion_id, event_id) do update set
    status = 'processing',
    payload = excluded.payload,
    attempts = turn_events.attempts + 1,
    lease_token = excluded.lease_token,
    lease_expires_at = excluded.lease_expires_at,
    last_error = null,
    updated_at = now()
  where turn_events.status = 'failed'
     or (
       turn_events.status = 'processing'
       and turn_events.lease_expires_at is not null
       and turn_events.lease_expires_at <= now()
     )
  returning * into claimed;

  if claimed.id is not null then
    return jsonb_build_object('acquired', true, 'event', to_jsonb(claimed));
  end if;

  select * into claimed
  from turn_events
  where user_id = p_user_id
    and companion_id = coalesce(p_companion_id, 'default')
    and event_id = p_event_id;
  return jsonb_build_object('acquired', false, 'event', to_jsonb(claimed));
end;
$$;

revoke all on function claim_turn_event(text,text,text,text,int,jsonb) from public, anon, authenticated;
grant execute on function claim_turn_event(text,text,text,text,int,jsonb) to service_role;

create or replace function checkpoint_turn_projection(
  p_user_id text,
  p_companion_id text,
  p_event_id text,
  p_lease_token text,
  p_projection text,
  p_checkpoint jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  next_state jsonb;
begin
  update turn_events
  set projection_state = jsonb_set(
        coalesce(projection_state, '{}'::jsonb),
        array[p_projection],
        coalesce(p_checkpoint, '{}'::jsonb),
        true
      ),
      updated_at = now()
  where user_id = p_user_id
    and companion_id = coalesce(p_companion_id, 'default')
    and event_id = p_event_id
    and status = 'processing'
    and lease_token = p_lease_token
  returning projection_state into next_state;

  return jsonb_build_object(
    'updated', next_state is not null,
    'projection_state', coalesce(next_state, '{}'::jsonb)
  );
end;
$$;

revoke all on function checkpoint_turn_projection(text,text,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function checkpoint_turn_projection(text,text,text,text,text,jsonb)
  to service_role;

alter table public.turn_events enable row level security;
notify pgrst, 'reload schema';
