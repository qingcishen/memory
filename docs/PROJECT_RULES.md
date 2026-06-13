# Cyber Memory · Project Rules

这份文档记录本项目的长期协作规则。目标很简单: `main` 始终稳定,每个功能有清晰边界,任何人或 AI 接手时都能知道该从哪里开始、怎么提交、怎么合并。

## 分支规则

- `main` 是稳定主线,只放已经验证过、可以作为基准继续开发的代码。
- 不直接在 `main` 上开发新功能、修 bug 或做大文档改动。
- 每个独立功能使用一个独立分支。
- 一个分支只解决一个主题,不要把无关重构、文档、功能混在一起。
- 分支完成后通过 PR 或显式合并回 `main`。

## 分支命名

| 类型 | 命名 | 例子 |
|---|---|---|
| 新功能 | `feature/<short-name>` | `feature/state-history` |
| 修 bug | `fix/<short-name>` | `fix/supersede-race` |
| 文档 | `docs/<short-name>` | `docs/project-rules` |
| 测试 | `test/<short-name>` | `test/e2e-memory-scenes` |
| 重构 | `refactor/<short-name>` | `refactor/store-transaction` |
| 实验 | `experiment/<short-name>` | `experiment/media-search` |

推荐使用短横线英文名,保持简短、可搜索。

## 开发流程

1. 从最新 `main` 开始:

   ```bash
   git switch main
   git pull --ff-only
   git switch -c feature/state-history
   ```

2. 小步提交,每次提交保持一个清楚意图。
3. 提交前运行相关测试。影响核心逻辑时运行完整测试:

   ```bash
   npm test
   ```

4. 推送功能分支:

   ```bash
   git push -u origin feature/state-history
   ```

5. 合并前确认:

   - 工作区干净。
   - 没有真实 `.env`、密钥、token、私钥、数据库导出进入提交。
   - README / DEVELOPMENT / schema 与代码行为一致。
   - 新增能力有测试或明确说明为什么暂不测试。

## 提交规则

- 提交信息用祈使句或简短描述,例如 `Add state history log`。
- 一个提交做一件事。
- 不提交 `node_modules/`、构建产物、日志和本地 `.env`。
- 不把真实凭证写入代码、文档、测试快照或交接记录。

## 测试规则

- 纯逻辑改动优先补 `examples/*.test.js`。
- 改动以下模块时默认跑 `npm test`:
  - `src/store.js`
  - `src/retrieve.js`
  - `src/state/affect.js`
  - `src/memory/reconsolidate.js`
  - `src/engine/*`
  - `sql/schema.sql`
- 涉及 Supabase / LLM / Embedding 的改动,要保留无凭证可 import、纯逻辑测试可运行的退路。

## 文档规则

- README 写面向使用者的说明。
- `docs/DEVELOPMENT.md` 写架构、路线图、诚实缺口和验收标准。
- `docs/PROJECT_RULES.md` 写协作与仓库规则。
- 当代码行为与文档承诺不一致时,优先修正文档或实现,不要留下"看起来已经完成"的半成品描述。

## 当前优先队列

1. `feature/state-history`: 新增状态历史表,让关系叙事看到时间轨迹。
2. `feature/affect-origin-anchor`: 给重构性记忆增加原始情感锚与漂移审计。
3. `feature/media-search`: 闭环 `media_embedding`,补图搜图或跨图检索。
4. `feature/semantic-dedup`: 在精确 `dedup_hash` 之外补近义去重。
5. `fix/store-transaction`: 收敛并发写入和 supersede 竞态。

