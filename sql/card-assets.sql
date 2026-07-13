-- ============================================================
--  穿搭卡片 + 穿搭相册资产
--  元数据 / 提示词 → Supabase
--  图片本体 → Cloudflare R2（url + r2_key）
--  在 Supabase SQL Editor 执行本文件即可（幂等）。
-- ============================================================

create table if not exists companion_card_assets (
  id            uuid primary key default gen_random_uuid(),
  companion_id  text not null default 'default',
  collection    text not null check (collection in ('outfit', 'album')),
  card_id       text not null,
  prompt        text,
  mime          text,
  url           text,                                 -- R2 公网 URL
  r2_key        text,                                 -- R2 对象 key，删除时用
  image_base64  text,                                 -- 兼容旧数据；新上传不再写入
  meta          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (companion_id, collection, card_id)
);

alter table companion_card_assets add column if not exists url text;
alter table companion_card_assets add column if not exists r2_key text;

create index if not exists companion_card_assets_idx
  on companion_card_assets (companion_id, collection);

create index if not exists companion_card_assets_updated_idx
  on companion_card_assets (companion_id, collection, updated_at desc);

-- 相册自定义场景卡（不绑衣橱 look）
create table if not exists album_custom_entries (
  id            text not null,
  companion_id  text not null default 'default',
  title         text not null,
  subtitle      text,
  summary       text,
  context       text,
  style         text,
  prompt        text,
  tags          text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (companion_id, id)
);

-- RLS：与其它伴侣表一致，应用用 service_role 绕过
alter table companion_card_assets enable row level security;
alter table album_custom_entries enable row level security;

notify pgrst, 'reload schema';
