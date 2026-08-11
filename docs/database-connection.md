# Supabase 数据库连接记录

最后核对：2026-08-11（Asia/Shanghai）

## 当前项目地址

| 用途 | 地址 | 端口 / 数据库 |
|---|---|---|
| Supabase HTTPS API / PostgREST | `https://vbrzgzsvuccymikgtzev.supabase.co` | `443` |
| PostgreSQL Supavisor pooler | `aws-1-ap-northeast-1.pooler.supabase.com` | `5432` / `postgres` |

Supabase project ref：`vbrzgzsvuccymikgtzev`。

> 本文档不保存密码、API key 或完整 DSN。实际凭证只存在仓库根目录的 `.env`；
> `.env` 已被 `.gitignore` 排除，禁止提交到 Git。

## 环境变量

| 变量 | 用途 | 注意事项 |
|---|---|---|
| `SUPABASE_URL` | Supabase HTTPS API 根地址 | 当前值应指向上面的项目地址 |
| `SUPABASE_KEY` | 服务端 Supabase 客户端鉴权 | 使用可访问 RLS 表和受限 RPC 的服务端 key；禁止放进浏览器或提交到仓库 |
| `DATABASE_URL` | PostgreSQL 完整连接串 | 仅供迁移/运维脚本使用，包含数据库凭证，禁止记录原值 |

连接串的无密钥形态：

```text
postgresql://<数据库用户>:<密码>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres
```

## 项目中的连接方式

应用读写走 `src/config.js` 创建的 Supabase 客户端：

```js
createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
```

SQL 迁移走 `scripts/run-sql.js`，从 `.env` 读取 `DATABASE_URL`，通过 `pg` 和 TLS
连接 pooler：

```bash
npm run db:sql -- sql/beliefs.sql
npm run db:sql -- sql/turn_events.sql
```

只读连通性检查示例：

```bash
npm run db:sql -- -e "select current_database(), current_user"
```

## 已应用迁移

2026-08-11 已在上述 Supabase 项目执行：

- `sql/beliefs.sql`
- `sql/turn_events.sql`

当前确认存在且启用 RLS：

- `beliefs`
- `belief_evidence`
- `turn_events`

当前确认可通过服务端调用：

- `supersede_belief_slot`
- `forget_memory_beliefs`
- `claim_turn_event`
- `renew_turn_event_lease`
- `checkpoint_turn_projection`

验收覆盖 belief 创建、同 slot 原子取代、当前/历史查询，以及 turn event 的 claim、
checkpoint、renew、complete 和重复 claim。验收使用独立探针 scope，结束后已确认
`beliefs`、`belief_evidence`、`turn_events` 均无探针数据残留。

## 运维约束

- 日常应用只使用 `SUPABASE_URL` + `SUPABASE_KEY`，不要给聊天进程数据库密码。
- 只有执行迁移或只读诊断时才使用 `DATABASE_URL`。
- 先运行独立幂等迁移；需要完整初始化时再运行 `sql/schema.sql`。
- 所有业务查询必须同时带 `user_id` 和 `companion_id`。
- 不确定连接目标时，只解析并核对 host / port / database，禁止打印完整 DSN。
