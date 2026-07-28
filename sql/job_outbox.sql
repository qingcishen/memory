-- ============================================================
--  Cyber Memory · Jobs Outbox Idempotency
--  为已有 jobs 队列增加事件级去重。可独立重复执行。
-- ============================================================

alter table jobs add column if not exists idempotency_key text;

create unique index if not exists jobs_idempotency_unique_idx
  on jobs (user_id, companion_id, kind, idempotency_key);

notify pgrst, 'reload schema';
