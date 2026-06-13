-- ============================================================
--  Cyber Memory · Supabase / Postgres schema
--  在 Supabase SQL Editor 里整段执行即可。
--  embedding 维度默认 1536 (OpenAI text-embedding-3-small)。
--  若换用其它 embedding 模型,改下面的 vector(1536) 维度。
-- ============================================================

create extension if not exists vector;

create table if not exists memories (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  type          text not null default 'fact',   -- fact / episode / preference / relationship / reflection
  content       text not null,                  -- 提取后的自然语言, 如 "诗雅讨厌香菜"
  embedding     vector(1536),
  importance    real not null default 5,         -- 1-10, 由模型评分
  emotion       real not null default 0,         -- 0-1, 情绪强度越高衰减越慢
  created_at    timestamptz not null default now(),
  last_accessed timestamptz not null default now(),
  access_count  int not null default 0,
  superseded_by uuid references memories(id),    -- 被新记忆取代时指向新记忆, 不删除
  source        jsonb default '{}'::jsonb         -- 原始出处 / 调试信息
);

-- ------------------------------------------------------------
--  M0 · 两层记忆本体 + 关系主体 (见 docs/DEVELOPMENT.md §1.6)
--  fact_core: 不可变事实核 (生日/名字/承诺都在这层, 任何机制禁止改写)
--  affect_*/narrative: 可被情绪重构的情感层
--  subject_kind: user(关于你) / self(关于她自己=persona) / dyad(我们共有)
--  老库执行下面的 alter 即可平滑升级, 无需重建。
-- ------------------------------------------------------------
alter table memories add column if not exists fact_core            text;
alter table memories add column if not exists affect_valence       real    not null default 0;   -- -1..1, 可重构
alter table memories add column if not exists affect_intensity     real    not null default 0;   -- 0..1, 可重构
alter table memories add column if not exists narrative            text;                          -- 她当下的解读, 可重构
alter table memories add column if not exists subject_kind         text    not null default 'user'; -- user/self/dyad
alter table memories add column if not exists fact_locked          boolean not null default false;  -- true=连情感层也尽量别动(生日等硬事实)
alter table memories add column if not exists reconsolidation_count int     not null default 0;
alter table memories add column if not exists access_log           jsonb   not null default '[]'::jsonb; -- 历次唤起时间戳, 给 base-level 用

-- 迁移期: 老数据 content 即事实核
update memories set fact_core = content where fact_core is null;

-- ------------------------------------------------------------
--  M6 · 多模态 (见 docs/DEVELOPMENT.md M6): 图片 + 语音。
--  图片 = vision caption(进 content/embedding 走文本召回) + 可选 CLIP 向量(media_embedding);
--  语音 = ASR 转写(进 content) + 语气(进 affect)。统一复用两层本体/状态/重构/引擎。
-- ------------------------------------------------------------
alter table memories add column if not exists modality        text    not null default 'text'; -- text/image/audio
alter table memories add column if not exists media_embedding vector(512);                      -- 图片 CLIP 等媒体向量 (可选)
alter table memories add column if not exists media_ref       text;                             -- 原始媒体出处 (url/路径)

-- M7 去重: 规范化指纹。同一件事被反复说不再存多条, 而是命中后强化 (见 src/dedup.js)。
alter table memories add column if not exists dedup_hash      text;
create index if not exists memories_dedup_idx on memories (user_id, dedup_hash) where superseded_by is null;

create index if not exists memories_subject_idx on memories (user_id, subject_kind) where superseded_by is null;

create index if not exists memories_user_idx on memories (user_id);
create index if not exists memories_active_idx on memories (user_id) where superseded_by is null;

-- 向量索引 (cosine)。数据量大后建议调 lists 参数。
create index if not exists memories_embedding_idx
  on memories using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ------------------------------------------------------------
--  M1 · 关系-情感状态机 (见 docs/DEVELOPMENT.md §1.1, M1)
--  一个用户一行: 她当下的心情 + 你俩关系的状态。
--  写入与读取见 src/state/affect.js; mood 随时间回落, relationship 主要被事件改变。
-- ------------------------------------------------------------
create table if not exists affective_state (
  user_id      text primary key,
  mood         jsonb not null default '{"valence":0,"arousal":0.3}'::jsonb,
  relationship jsonb not null default '{"closeness":0.5,"tension":0,"repair_debt":0,"trust":0.5}'::jsonb,
  updated_at   timestamptz not null default now()
);

-- ------------------------------------------------------------
--  M5 · 预期记忆 (见 docs/DEVELOPMENT.md M5, 招牌④)
--  面向未来: "你上次说今天面试, 怎么样了?" —— 她主动在未来某刻/某线索把事捞回来。
--  time 型: 到 trigger_at 触发; cue 型: 语境向量与 cue_embedding 相近时触发。
-- ------------------------------------------------------------
create table if not exists prospective (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  content       text not null,                 -- "问问他面试结果"
  trigger_kind  text not null,                 -- time / cue
  trigger_at    timestamptz,                   -- time 型: 触发时刻
  cue_embedding vector(1536),                  -- cue 型: 语境线索向量
  status        text not null default 'pending', -- pending / fired / cancelled / expired
  created_at    timestamptz not null default now()
);
create index if not exists prospective_pending_idx on prospective (user_id, status) where status = 'pending';

-- ------------------------------------------------------------
--  向量检索函数: 只返回未被取代的记忆, 按余弦相似度排序取 top N。
--  应用层拿到后再用 recency + importance 做二次重排 (见 retrieve.js)。
-- ------------------------------------------------------------
create or replace function match_memories (
  p_user_id     text,
  query_embedding vector(1536),
  match_count   int default 30
)
returns table (
  id               uuid,
  type             text,
  content          text,
  fact_core        text,
  affect_valence   real,
  affect_intensity real,
  narrative        text,
  subject_kind     text,
  fact_locked      boolean,
  importance       real,
  emotion          real,
  created_at       timestamptz,
  last_accessed    timestamptz,
  access_count     int,
  access_log       jsonb,
  embedding        vector(1536),  -- M2 自研引擎要靠它在进程内做联想扩散
  similarity       real
)
language sql stable
as $$
  select
    m.id, m.type, m.content,
    m.fact_core, m.affect_valence, m.affect_intensity, m.narrative,
    m.subject_kind, m.fact_locked,
    m.importance, m.emotion,
    m.created_at, m.last_accessed, m.access_count, m.access_log,
    m.embedding,
    1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where m.user_id = p_user_id
    and m.superseded_by is null
    and m.embedding is not null
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

-- ------------------------------------------------------------
--  显式"翻旧账"检索辅助: 包含已被 supersede 的历史记忆。
--  普通 match_memories 仍只返回当前有效事实;需要"你以前不是..."这种历史感时,
--  应用层可调用本函数或沿 superseded_by 链反查旧版本。
-- ------------------------------------------------------------
create or replace function match_memory_history (
  p_user_id     text,
  query_embedding vector(1536),
  match_count   int default 30
)
returns table (
  id               uuid,
  type             text,
  content          text,
  fact_core        text,
  affect_valence   real,
  affect_intensity real,
  narrative        text,
  subject_kind     text,
  fact_locked      boolean,
  importance       real,
  emotion          real,
  created_at       timestamptz,
  last_accessed    timestamptz,
  access_count     int,
  access_log       jsonb,
  superseded_by    uuid,
  similarity       real
)
language sql stable
as $$
  select
    m.id, m.type, m.content,
    m.fact_core, m.affect_valence, m.affect_intensity, m.narrative,
    m.subject_kind, m.fact_locked,
    m.importance, m.emotion,
    m.created_at, m.last_accessed, m.access_count, m.access_log,
    m.superseded_by,
    1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where m.user_id = p_user_id
    and m.embedding is not null
  order by m.embedding <=> query_embedding
  limit match_count;
$$;
