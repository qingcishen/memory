-- Cyber Memory · K1 结构化知识图谱数据库迁移
-- 可在现有项目的 Supabase SQL Editor 中单独执行；脚本可重复执行。
-- 前置条件: sql/schema.sql 的 memories 表已存在，vector 扩展可用。

begin;

create extension if not exists vector;

create table if not exists knowledge_entities (
  id             uuid primary key default gen_random_uuid(),
  user_id        text not null,
  companion_id   text not null default 'default',
  entity_key     text not null,
  canonical_name text not null,
  entity_type    text not null default 'concept'
                 check (entity_type in ('person', 'place', 'organization', 'thing', 'event', 'concept')),
  aliases        jsonb not null default '[]'::jsonb,
  embedding      vector(1536),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, companion_id, entity_key)
);

create table if not exists knowledge_relations (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null,
  companion_id     text not null default 'default',
  source_entity_id uuid not null references knowledge_entities(id) on delete cascade,
  relation         text not null,
  target_entity_id uuid not null references knowledge_entities(id) on delete cascade,
  confidence       real not null default 0.7 check (confidence >= 0 and confidence <= 1),
  evidence         text,
  source_memory_id uuid references memories(id) on delete set null,
  status           text not null default 'active'
                   check (status in ('active', 'superseded', 'retracted')),
  valid_from       timestamptz,
  valid_to         timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (source_entity_id <> target_entity_id),
  unique (user_id, companion_id, source_entity_id, relation, target_entity_id)
);

create index if not exists knowledge_entities_scope_idx
  on knowledge_entities (user_id, companion_id, entity_key);
create index if not exists knowledge_entities_embedding_idx
  on knowledge_entities using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists knowledge_relations_source_idx
  on knowledge_relations (user_id, companion_id, source_entity_id) where status = 'active';
create index if not exists knowledge_relations_target_idx
  on knowledge_relations (user_id, companion_id, target_entity_id) where status = 'active';
create index if not exists knowledge_relations_memory_idx
  on knowledge_relations (source_memory_id) where source_memory_id is not null;

drop function if exists match_knowledge_entities(text, vector, int);
drop function if exists match_knowledge_entities(text, vector, text, int);
create or replace function match_knowledge_entities (
  p_user_id       text,
  query_embedding vector(1536),
  p_companion_id  text default 'default',
  match_count     int default 4
)
returns table (
  id             uuid,
  canonical_name text,
  entity_type    text,
  similarity     real
)
language sql stable
as $$
  select
    e.id,
    e.canonical_name,
    e.entity_type,
    (1 - (e.embedding <=> query_embedding))::real as similarity
  from knowledge_entities e
  where e.user_id = p_user_id
    and e.companion_id = p_companion_id
    and e.embedding is not null
  order by e.embedding <=> query_embedding
  limit greatest(0, least(coalesce(match_count, 4), 50));
$$;

commit;

-- 让 Supabase PostgREST 立即识别新表 / 新 RPC。
notify pgrst, 'reload schema';
