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

-- 原始情感锚 (feature/affect-origin-anchor): 记忆诞生时的情感, 写入后【不可变】(像 fact_core)。
-- 重构每次靠拢当下心情时也被它往回拉, 且漂移有硬上限 —— 长期负面心情也洗不黑一条本来温暖的记忆。
alter table memories add column if not exists affect_origin_valence   real;  -- 诞生时 valence, 不可变锚
alter table memories add column if not exists affect_origin_intensity real;  -- 诞生时 intensity, 不可变锚

-- 迁移期: 老数据 content 即事实核; 原始锚以当前情感回填 (best-effort)
update memories set fact_core = content where fact_core is null;
update memories set affect_origin_valence = affect_valence where affect_origin_valence is null;
update memories set affect_origin_intensity = affect_intensity where affect_origin_intensity is null;

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

-- ------------------------------------------------------------
--  多角色 (multi-companion): 同一 user 可拥有多个伴侣角色, 数据按 (user_id, companion_id) 隔离。
--  companion_id 默认 'default' —— 老数据与未传 companionId 的调用零行为变化 (见 src/companion.js)。
--  下面六张表统一加这一列; 状态/限流类表的主键随之升级为复合主键 (见各表)。
-- ------------------------------------------------------------
alter table memories                add column if not exists companion_id text not null default 'default';

-- #10 工程债 (事务与并发写入): 唯一约束防止两个并发 observe() 对同一指纹重复插入。
-- 后到的 insert 抛 23505, src/store.js 捕获后转去强化先到的那条 (乐观重试)。
-- 多角色后隔离维度从 user_id 扩到 (user_id, companion_id)。
-- 老库执行: drop index if exists memories_dedup_idx / memories_dedup_unique_idx; 再建下面这条即可平滑升级。
drop index if exists memories_dedup_idx;
drop index if exists memories_dedup_unique_idx;
create unique index if not exists memories_dedup_unique_idx on memories (user_id, companion_id, dedup_hash) where dedup_hash is not null and superseded_by is null;

drop index if exists memories_subject_idx;
create index if not exists memories_subject_idx on memories (user_id, companion_id, subject_kind) where superseded_by is null;

drop index if exists memories_user_idx;
create index if not exists memories_user_idx on memories (user_id, companion_id);
drop index if exists memories_active_idx;
create index if not exists memories_active_idx on memories (user_id, companion_id) where superseded_by is null;

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
-- 多角色: 加 companion_id 并把主键从 user_id 升级为 (user_id, companion_id)。
-- add primary key 非幂等, 用守卫保证整段脚本可重复执行。
alter table affective_state add column if not exists companion_id text not null default 'default';
alter table affective_state drop constraint if exists affective_state_pkey;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'affective_state_pkey' and contype = 'p') then
    alter table affective_state add primary key (user_id, companion_id);
  end if;
end $$;

-- ------------------------------------------------------------
--  L2 · 生命状态 (见 docs/appearance-life-design.md 第三部分)
--  一个用户一行: 身体状态 + 作息派生活动。读取时惰性应用饥饿/作息/健康衰减。
-- ------------------------------------------------------------
create table if not exists life_state (
  user_id          text primary key,
  energy           real not null default 0.6,
  satiety          real not null default 0.6,
  health           real not null default 1.0,
  current_activity text,
  last_slept_at    timestamptz,
  sick_until       timestamptz,
  updated_at       timestamptz not null default now()
);
-- 多角色: 同 affective_state, 加列 + 复合主键。
alter table life_state add column if not exists companion_id text not null default 'default';
alter table life_state drop constraint if exists life_state_pkey;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'life_state_pkey' and contype = 'p') then
    alter table life_state add primary key (user_id, companion_id);
  end if;
end $$;
-- P2 身体专属参数: 连续熬夜天数 + 最近一次熬夜的日期 (见 src/state/health.js updateLateNightStreak)。
alter table life_state add column if not exists late_night_streak int not null default 0;
alter table life_state add column if not exists last_late_night_day text;

-- 状态历史 (feature/state-history): affective_state 只存"当下", 这张表存"轨迹"。
-- 关系叙事(M4)与情感锚审计要看演变 —— 状态有显著变化时追加一条快照 (见 src/state/affect.js)。
create table if not exists affective_state_history (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null,
  mood         jsonb not null,
  relationship jsonb not null,
  event        text,                                  -- 触发这次快照的简述: 吵架/和好/变亲密...
  created_at   timestamptz not null default now()
);
-- 多角色: 历史表 id 是主键, 只需加列 + 扩索引。
alter table affective_state_history add column if not exists companion_id text not null default 'default';
drop index if exists affective_history_idx;
create index if not exists affective_history_idx on affective_state_history (user_id, companion_id, created_at desc);

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
-- 多角色: id 是主键, 加列 + 扩索引。
alter table prospective add column if not exists companion_id text not null default 'default';
drop index if exists prospective_pending_idx;
create index if not exists prospective_pending_idx on prospective (user_id, companion_id, status) where status = 'pending';

-- 主动消息限流状态: 跨进程共享 quiet hours / cooldown / max-per-day 的发送轨迹。
-- state 形如 {"sentAt":["2026-06-14T12:00:00.000Z"],"policy":{...}}。
create table if not exists proactive_rate_limits (
  user_id    text primary key,
  state      jsonb not null default '{"sentAt":[]}'::jsonb,
  updated_at timestamptz not null default now()
);
-- 多角色: 同 affective_state, 加列 + 复合主键 (每个角色独立限流)。
alter table proactive_rate_limits add column if not exists companion_id text not null default 'default';
alter table proactive_rate_limits drop constraint if exists proactive_rate_limits_pkey;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'proactive_rate_limits_pkey' and contype = 'p') then
    alter table proactive_rate_limits add primary key (user_id, companion_id);
  end if;
end $$;

-- ------------------------------------------------------------
--  多角色 · 人设配置表 (见 src/companion.js)
--  每个 (user_id, companion_id) 一行: 名字 + 完整 CompanionConfig (zod 校验后序列化) + 外貌描述。
--  运行时可 upsert 改配置, 无需重新部署。self 设定记忆仍走 memories 表 (subject_kind='self')。
-- ------------------------------------------------------------
create table if not exists companions (
  user_id      text not null,
  companion_id text not null,
  name         text not null,                       -- 她的名字 / 称呼 (= orchestrator companionName)
  config       jsonb not null default '{}'::jsonb,  -- personality/traits/speechStyle/seedFacts
  appearance   text,                                -- 外貌描述 (注入 prompt, 不做图像生成); 冗余出来便于查询
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, companion_id)
);

-- ------------------------------------------------------------
--  A1 外貌/自拍 图库 (见 src/appearance/, docs/appearance-life-design.md 第二部分)
--  出图为仓库外基建 (SD/ComfyUI); 这里只存"已生成的自拍": url + 状态标签(生病/健身后/心情好...) + seed。
--  selfie() 先按状态 tags 命中复用, miss 再调 provider 生成入库。
-- ------------------------------------------------------------
create table if not exists appearance_assets (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null,
  companion_id text not null default 'default',
  url          text not null,
  tags         text[] not null default '{}',        -- 状态标签: sick / post-workout / happy / home ...
  prompt       text,
  seed         text,
  meta         jsonb default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists appearance_assets_idx on appearance_assets (user_id, companion_id, created_at desc);
create index if not exists appearance_assets_tags_idx on appearance_assets using gin (tags);

-- ------------------------------------------------------------
--  M5 扛量 · 持久化任务队列 (见 src/queue/jobs.js)
--  把回复后的后台活 (observe / evolve / 主动性 / reflect) 落成 job, 进程重启不丢;
--  worker 轮询 claim → 跑 handler → done/失败重试(指数退避), 超次进 failed。
-- ------------------------------------------------------------
create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null,
  companion_id text not null default 'default',
  kind         text not null,                      -- observe / evolve / proactive / reflect / dedupe ...
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending',    -- pending / running / done / failed
  attempts     int  not null default 0,
  run_after    timestamptz not null default now(), -- 退避: 重试时推到未来
  last_error   text,
  result       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- 取活: 按 (status, run_after) 捞到期的 pending; 顺带带上 user 维度便于按角色排空。
create index if not exists jobs_claim_idx on jobs (status, run_after) where status = 'pending';
create index if not exists jobs_owner_idx on jobs (user_id, companion_id, status);

-- ------------------------------------------------------------
--  短期对话历史 (见 src/orchestrator/historyStore.js)
--  长期记忆在 memories 里; 但"刚才聊的几轮"是 Orchestrator 实例内存里的, 进程重启就丢。
--  这张表把短期历史落库, 让重启/多实例也能接上最近的对话。
-- ------------------------------------------------------------
create table if not exists chat_history (
  id           bigint generated always as identity primary key,
  user_id      text not null,
  companion_id text not null default 'default',
  role         text not null,                       -- user / assistant
  content      text not null,
  created_at   timestamptz not null default now()
);
create index if not exists chat_history_idx on chat_history (user_id, companion_id, created_at desc);

-- ------------------------------------------------------------
--  世界观系统 (worldview): 动态世界状态 —— 背景剧情线/氛围随对话推进缓慢演变,
--  不是写死的设定文档。大多数寻常对话不推进, 只有出现值得记的世界级进展才更新
--  (见 src/world/index.js WorldDimension.evolve)。
-- ------------------------------------------------------------
create table if not exists world_state (
  user_id      text not null,
  companion_id text not null default 'default',
  arc          text not null default '',   -- 背景剧情线简述 (如"她刚搬家, 还在适应新工作")
  atmosphere   text not null default '',   -- 当前世界氛围基调 (如"平静日常" / "暗流涌动")
  last_event   text not null default '',   -- 最近一次世界推进带来的事件
  updated_at   timestamptz not null default now(),
  primary key (user_id, companion_id)
);

-- ------------------------------------------------------------
--  向量检索函数: 只返回未被取代的记忆, 按余弦相似度排序取 top N。
--  应用层拿到后再用 recency + importance 做二次重排 (见 retrieve.js)。
-- ------------------------------------------------------------
-- 多角色: 追加 p_companion_id 参数 = 改变函数签名, create or replace 无法加新参数, 必须先 drop 旧签名。
drop function if exists match_memories(text, vector, int);
-- 注意参数顺序: 带默认值的参数 (p_companion_id/match_count) 必须排在无默认值的 (p_user_id/query_embedding) 之后,
-- 否则 Postgres 报 42P13。supabase-js 按【参数名】调用, 顺序不影响 JS 端。
create or replace function match_memories (
  p_user_id       text,
  query_embedding vector(1536),
  p_companion_id  text default 'default',
  match_count     int default 30
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
  affect_origin_valence   real,   -- 原始情感锚, 给 recall 命中时的重构回弹用
  affect_origin_intensity real,
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
    m.affect_origin_valence, m.affect_origin_intensity,
    m.embedding,
    1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where m.user_id = p_user_id
    and m.companion_id = p_companion_id
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
drop function if exists match_memory_history(text, vector, int);
create or replace function match_memory_history (
  p_user_id       text,
  query_embedding vector(1536),
  p_companion_id  text default 'default',
  match_count     int default 30
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
    and m.companion_id = p_companion_id
    and m.embedding is not null
  order by m.embedding <=> query_embedding
  limit match_count;
$$;
