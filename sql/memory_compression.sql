-- ============================================================
--  M-3 · 长期记忆分层压缩原子提交
--  一次事务内创建 reflection 摘要并把来源 episode/fact 链到摘要。
-- ============================================================

create or replace function commit_memory_compression(
  p_user_id text,
  p_companion_id text,
  p_source_ids uuid[],
  p_summary jsonb
)
returns table(summary_id uuid, linked_count int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_summary_id uuid;
  v_source_count int;
  v_subject_count int;
  v_distinct_ids int;
  v_dedup_hash text;
  v_content text;
  v_subject_kind text;
begin
  if nullif(trim(p_user_id), '') is null or nullif(trim(p_companion_id), '') is null then
    raise exception 'memory compression requires a scoped user and companion';
  end if;
  if p_source_ids is null or cardinality(p_source_ids) < 3 then
    raise exception 'memory compression requires at least three source memories';
  end if;

  select count(distinct source_id)
    into v_distinct_ids
  from unnest(p_source_ids) as source_id;
  if v_distinct_ids <> cardinality(p_source_ids) then
    raise exception 'memory compression source ids must be unique';
  end if;

  v_dedup_hash := nullif(trim(p_summary ->> 'dedup_hash'), '');
  v_content := nullif(trim(coalesce(p_summary ->> 'content', p_summary ->> 'fact_core')), '');
  v_subject_kind := coalesce(nullif(trim(p_summary ->> 'subject_kind'), ''), 'user');
  if v_dedup_hash is null or v_content is null then
    raise exception 'memory compression summary requires content and dedup_hash';
  end if;
  if v_subject_kind not in ('user', 'self', 'dyad') then
    raise exception 'invalid memory compression subject_kind';
  end if;

  select id
    into v_summary_id
  from memories
  where user_id = p_user_id
    and companion_id = p_companion_id
    and dedup_hash = v_dedup_hash
    and superseded_by is null
  limit 1;

  if v_summary_id is null then
    insert into memories (
      user_id, companion_id, type, content, fact_core, narrative, subject_kind,
      affect_valence, affect_intensity, affect_origin_valence,
      affect_origin_intensity, importance, emotion, embedding, dedup_hash,
      source, created_at
    ) values (
      p_user_id,
      p_companion_id,
      'reflection',
      v_content,
      coalesce(nullif(trim(p_summary ->> 'fact_core'), ''), v_content),
      coalesce(nullif(trim(p_summary ->> 'narrative'), ''), v_content),
      v_subject_kind,
      coalesce((p_summary ->> 'affect_valence')::real, 0),
      coalesce((p_summary ->> 'affect_intensity')::real, 0),
      coalesce((p_summary ->> 'affect_origin_valence')::real, 0),
      coalesce((p_summary ->> 'affect_origin_intensity')::real, 0),
      coalesce((p_summary ->> 'importance')::real, 5),
      coalesce((p_summary ->> 'emotion')::real, 0),
      case
        when jsonb_typeof(p_summary -> 'embedding') = 'array'
          then (p_summary -> 'embedding')::text::vector(1536)
        else null
      end,
      v_dedup_hash,
      coalesce(p_summary -> 'source', '{}'::jsonb),
      coalesce((p_summary ->> 'created_at')::timestamptz, now())
    )
    returning id into v_summary_id;
  end if;

  select count(*), count(distinct subject_kind)
    into v_source_count, v_subject_count
  from memories
  where id = any(p_source_ids)
    and user_id = p_user_id
    and companion_id = p_companion_id
    and type in ('episode', 'fact')
    and (superseded_by is null or superseded_by = v_summary_id)
    and subject_kind = v_subject_kind;

  if v_source_count <> cardinality(p_source_ids) or v_subject_count <> 1 then
    raise exception 'memory compression source scope, type, subject, or state mismatch';
  end if;

  update memories
  set superseded_by = v_summary_id
  where id = any(p_source_ids)
    and user_id = p_user_id
    and companion_id = p_companion_id
    and superseded_by is null;

  return query select v_summary_id, v_source_count;
end;
$$;

grant execute on function commit_memory_compression(text,text,uuid[],jsonb)
  to authenticated, service_role;

notify pgrst, 'reload schema';
