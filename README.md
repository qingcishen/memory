# Cyber Memory

给 AI 伴侣用的"类人"记忆系统。不是把对话一股脑塞进向量库,而是模拟人的记忆方式:**有选择地记、会遗忘、被反复提起会强化、偏好改变会留下痕迹、定期把碎片归纳成印象**。

架构参考斯坦福 Generative Agents 的记忆模型,针对伴侣场景做了改动(情绪保护衰减、矛盾不覆盖而是 supersede)。

完整介绍、接入流程和 API 说明见 [项目介绍与使用指南](docs/INTRODUCTION_AND_USAGE.md)。开发计划和架构验收见 [开发文档与路线图](docs/DEVELOPMENT.md)。下一轮"从功能齐到像人"的升级计划(需求系统/情绪行为策略/生活叙事引擎)见 [伴侣升级开发文档 v2](docs/companion-upgrade-v2.md)。亲密/性爱状态机与落地切片见 [性爱系统开发文档](docs/intimacy-design.md)。当前主线:"从像人到可证明"(评测闭环/检索升级/数据学习/工程底盘)见 [全面升级开发文档 v3](docs/upgrade-v3-measurable.md)。

## 它解决什么

普通做法(嵌入每条消息 → 检索 top-k)对女友产品是坏的:"嗯""在吗"也被记住、你生日和闲聊权重一样、她什么都记得死死的反而恐怖。本系统让记忆**像人**:

- **提取而非堆积** — 只记持久的事实/事件/偏好,忽略寒暄
- **重要性评分** — 生日 ≠ 今天天气
- **衰减 + 强化** — 会淡忘,但常被提起的记得牢;情绪强的忘得慢
- **加权检索** — similarity + recency + importance,不是只看相似度
- **矛盾处理** — "喜欢香菜"取代"讨厌香菜"时旧记忆不删,她能说"你不是以前挺讨厌的吗"
- **反思** — 定期把碎片聚成高层印象("最近压力大,在备考")

## 安装

```bash
npm install
cp .env.example .env   # 填入 Supabase / LLM / Embedding 凭证
```

在 Supabase SQL Editor 执行 `sql/schema.sql`(建表 + pgvector + 检索函数)。

> 不想手改 `.env`?直接 `npm run ui` 打开本地控制台,在浏览器里填密钥、测连接、启停 bot,见下方 [本地控制台](#本地控制台)。

> **升级老库**:`sql/schema.sql` 是幂等的,表结构有变更时(如新增 `companion_id` 列 / `companions`、`appearance_assets` 表 / 修改 `match_memories` RPC),把整段重新执行一遍即可平滑升级,不会动到已有数据。

只补知识图谱数据库时,可单独执行 `sql/knowledge-graph.sql`;它会创建实体表、关系表、遍历索引和 `match_knowledge_entities` 入口查询函数,可重复执行。

LLM 用 OpenAI 兼容接口,DeepSeek 直接可用;Embedding 默认 OpenAI `text-embedding-3-small`(1536 维)。换 embedding 模型记得同步改 schema 里的 `vector(维度)`。回复模型可走**独立供应商**(`REPLY_BASE_URL` / `REPLY_API_KEY`,如 OpenRouter 上的更强模型)——"回复用好模型,提取/反思等后台杂活用便宜模型";不配置则回复与后台共用同一端点。

## 用法

```js
import { Memory } from 'cyber-memory';

const mem = new Memory({ userId: 'u_123', subjectName: '诗雅' });

// 回复前: 检索相关记忆, 拼成可注入 system prompt 的串
const memoryBlock = await mem.recallAsPrompt(userMessage);
// → "你记得关于诗雅的事:\n- 诗雅讨厌香菜\n- 我记得好像诗雅小时候学过钢琴"
// 相关度低/很久没强化/同话题情绪冲突的记忆会带上"我记得好像..."而非确定口吻 (recall() 结果上的 _lowConfidence)

// 用 [人格] + [memoryBlock] + [对话历史] 调你的 LLM 生成回复 ...

// 回复后: 更新情绪/关系状态(M1) + 提取存储 + 顺手排预期记忆(M5)
await mem.observe([
  { role: 'user', content: userMessage },
  { role: 'assistant', content: reply },
]);

// 她当下的心情(影响想起什么) / 主动想起该问的事
const mood = await mem.mood();                 // 开心 / 平静 / 低落 / 受伤·闹脾气
const due = await mem.checkProspective({ query: userMessage }); // "上次面试怎么样了?"

// 显式"翻旧账": 普通 recall 只取当前事实;需要"你以前不是..."时再捞旧版本链
const historyBlock = await mem.recallHistoryAsPrompt('香菜');
// → "以前: 诗雅讨厌香菜; 后来更新为: 诗雅现在喜欢香菜"

// 多模态: 看图 / 听语音 (缺凭证自动降级, 不崩)
await mem.seeImage({ url: imgUrl });
await mem.hearVoice({ transcript: '我没事', prosody: { tone: 'crying' } }); // 语气进 affect

// 图搜图: 给一个查询图的向量 (调用方用 CLIP 等模型算好), 在带 media_embedding 的记忆里找最相似的几条
const similarImages = await mem.recallMedia(queryEmbedding);

// 定时: 心情回落 / 和好后软化旧怨(M3) / 合成"我们的故事"(M4) / 反思 / 遗忘
await mem.settle();                 // 没对话时心情向基线回落
await mem.reconsolidate();          // 按当下状态重构旧记忆 (永不改 fact_core)
await mem.story();                  // 关系叙事
await mem.reflect();
await mem.forgettable(0.05, { purge: true });
await mem.forget('刚才说的那件事');  // 主动遗忘: 相似度够高且非 fact_locked 才真删
```

完整一轮见 `examples/demo.js`;查看某用户的记忆画像:`npm run inspect <userId>`。

## 编排器(Orchestrator)

`Memory` 只是记忆门面;"这一轮怎么把人格 + 关系 + 状态层 + 记忆 + 内心独白拼成一次 LLM 调用"由 `Orchestrator` 在每轮对话现场组装,回复返回后再后台触发状态更新。

```js
import { Orchestrator } from 'cyber-memory';

const bot = new Orchestrator({ userId: 'u_123', subjectName: '诗雅', companionName: '可可' });

const { text: reply, parts } = await bot.reply(userMessage);
// 同步路径: persona/relationship/stateLayer/memory 的 toPrompt 拼成 system + 短期历史 + 当前消息 → 生成回复
// parts 是按 dialogue/narration 拆好的发送片段; reply 是拼好的纯文本, 适合日志和兼容旧调用
// 回复返回后, stateLayer.evolve / memory.observe / relationship.bump 已在后台 fire-and-forget 触发
```

依赖可注入,测试时传 mock 即可验证拼接顺序与 afterReply 触发,不连库、不调 LLM:

```js
new Orchestrator({ userId, deps: { memory, stateLayer, relationship, persona, llm, historyStore } });
```

短期历史默认存在实例内;生产环境可注入 `historyStore` 做持久化/多实例共享:

```js
const historyStore = {
  load: async ({ userId, limit }) => loadRecentTurns(userId, limit),
  append: async ({ userId, turns }) => saveTurns(userId, turns),
};
```

主动消息不走 `reply()` 热路径,由外部定时器/事件判断后调用同一套组装链路:

```js
const proactive = await bot.proactiveTick({
  reason: '很久没聊天',
  shouldSend: quietHoursPassed,
});
// proactive: null | { text, parts }
```

需要安静时间、冷却间隔、每日上限时,用 `ProactiveScheduler` 包一层。生产环境建议用
`SupabaseRateLimitStore` 把限流状态跨进程持久化:

```js
import { ProactiveScheduler, SupabaseRateLimitStore } from 'cyber-memory';

const scheduler = new ProactiveScheduler({
  orchestrator: bot,
  stateStore: new SupabaseRateLimitStore(),
  policy: {
    quietHours: { start: 23, end: 8 },
    minIntervalMinutes: 180,
    maxPerDay: 3,
    timezoneOffsetMinutes: 8 * 60,
  },
  getDueItems: () => mem.checkProspective(),
  markFired: (ids) => mem.dismissProspective(ids),
  deliver: ({ message }) => sendToUser(message),
});

await scheduler.tick(); // 可由 cron / setInterval / 队列定时调用
```

## 本地控制台

```bash
npm run ui   # 打开 http://127.0.0.1:8787
```

控制台只保留 React 版本，`npm run ui` 会先构建前端再启动本地服务。如果通过局域网代理或 Tunnel 暴露控制台，必须配置 `UI_ADMIN_TOKEN`；前端第一次收到 401 时会提示输入，并只保存在当前浏览器。

浏览器里的管理台,零新依赖(node 内置 http + fetch),分五个页签:

**配置页**:

- **填配置**:Supabase / LLM / Embedding / Telegram / 天气的所有密钥和参数,表单化填写,保存直接写回 `.env`(保留注释和顺序);密钥读取时只回显末 4 位,原文不出服务端。每个密钥旁边都有"去获取 ↗"直达对应平台的生成页面。
- **测连接**:每组配置一键体检——Supabase 会区分"key 错了"和"连上了但没建表";Embedding 会校验输出维度是否等于 schema 要求的 1536;直连不通时会提示是网络/代理问题而不是甩一句 fetch failed。
- **执行 SQL**:Supabase 卡片里的 SQL 工具箱可以一键执行 `sql/` 目录下的建表脚本(首次接入不用开 SQL Editor),也能跑自定义 SQL 查数据。走 Supabase Management API,需要额外配一个 Personal Access Token(`sbp_` 开头,控制台 Account → Access Tokens 生成);`service_role` key 只能读写表,执行不了建表语句,所以这项是单独的凭证。
- **启停 bot**:页面上直接启动/停止 Telegram bot 子进程,实时看运行日志,改完配置重启即生效。
- **安全边界**:只绑定 `127.0.0.1`,不对外网开放;`.env` 写入后权限收紧到 600。

**其余页签**:

- **记忆**:直接浏览 memories 表——按用户筛、按内容搜,类型/主体/重要性/情绪一目了然;可选显示被新记忆取代的旧版本(划线样式)。
- **知识图谱**:实体云 + "实体 —关系→ 实体"列表(置信度、对话依据);没建表时会引导你去 SQL 工具箱执行 `knowledge-graph.sql`。
- **人设**:直接编辑人设文件,保存前校验 JSON,也能从 default 模板新建角色。人设支持两种格式:`companions/<角色ID>.json` 单文件,或 **`companions/<角色ID>/` 目录按功能分片**(`persona` 人格散文 / `appearance` 外貌 / `life` 作息身体 / `relationship` 关系与情绪起点 / `knowledge` 知识库 / `narration` 旁白指令按场景覆盖 / `runtime` 运行时选项)——目录存在时优先生效,顶层键按"数组相接、对象浅合并"规则合并,改说话风格不用再滚过整个知识库。
- **试聊**:编排器调试场,和 Telegram 完全同一条管线(人设 + 记忆 + 状态 + 世界观 + 旁白),narration/dialogue 分气泡显示。注意是真实调用:走 LLM、写记忆库;换个用户 ID 就是一段全新的关系。

端口可用 `UI_PORT` 覆盖。配置项 schema 在 `src/ui/server.js` 的 `CONFIG_SCHEMA`,加字段只改那一处。

## Telegram 接入

项目自带一个本地 polling 版 Telegram 入口, 不需要公网 webhook。把 BotFather token 放进本机
`.env` 后启动即可:

```bash
npm run telegram
```

需要的环境变量:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_ALLOWED_CHAT_IDS=                 # 可选, 多个 chat id 用英文逗号分隔
TELEGRAM_COMPANION_NAME=小忆
TELEGRAM_SUBJECT_NAME=你
TELEGRAM_COMPANION_ID=default
```

Telegram 的 `chat.id` 会映射成 `userId = telegram:<chat.id>`, 因此每个聊天都有独立记忆和状态。
支持 `/start`、`/help`、`/status`;普通文字消息会直接进入 `Orchestrator.reply()`。

### macOS 登录自启

仓库提供 Telegram 和飞书两个 LaunchAgent：`launchd/com.memory-system.telegram-bot.plist` 与 `launchd/com.memory-system.feishu-bot.plist`。安装后登录即启动，异常退出会自动拉起；启动脚本会等待本机 Shadowrocket `127.0.0.1:1082` 代理端口。日志分别位于 `logs/telegram-bot*.log` 和 `logs/feishu-bot*.log`。

## 飞书与 Discord 接入

控制台可以同时配置并启动 Telegram、飞书和 Discord。三个渠道共用同一套人设、记忆、状态和对话编排，用户 ID 分别使用 `telegram:`、`feishu:`、`discord:` 前缀隔离。

飞书使用自建应用长连接，无需公网回调地址。在开放平台开启机器人能力，给应用添加 `im:message`、`im:message:send_as_bot`、图片/消息资源所需权限，订阅 `im.message.receive_v1`，发布应用后填写：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
```

飞书支持双向图片：用户发图后会下载并交给视觉模型理解、写入记忆；角色生成自拍或场景照后会自动上传飞书并发送。飞书上传图片限制为 10 MB，支持 JPEG、PNG、WEBP、GIF、TIFF、BMP 和 ICO。

渠道默认关闭每轮“内心独白”以减少一次串行模型调用；需要时可设置 `CHANNEL_USE_MONOLOGUE=true` / `TELEGRAM_USE_MONOLOGUE=true`。飞书和 Discord 会合并旁白与台词后再按平台长度分片。

> 本次可靠性升级新增 `channel_events`、`jobs.locked_at/locked_by` 和 `chat_history.event_id`。旧数据库需重新执行一次幂等的 `sql/schema.sql`，才能启用跨进程幂等、任务租约恢复和历史去重。

Discord 使用 Gateway 长连接。在 Developer Portal 创建 Bot，开启 **Message Content Intent**，邀请 Bot 时授予 View Channels、Send Messages 和 Read Message History 权限，然后填写：

```env
DISCORD_BOT_TOKEN=xxx
DISCORD_ALLOWED_GUILD_IDS=   # 可选，逗号分隔；留空允许所有服务器
```

Discord 私聊会直接回复；服务器频道中只有提及机器人时才回复。也可以单独运行 `npm run feishu` 或 `npm run discord`。

## 项目规则

开发新功能、修 bug 或做较大文档改动时,不要直接改 `main`。分支命名、提交、测试和文档同步规则见 [docs/PROJECT_RULES.md](docs/PROJECT_RULES.md)。

## 调参

所有"性格"参数在 `src/params.js`:

| 参数 | 作用 | 调高的效果 |
|---|---|---|
| `baseDecay` | 基础衰减率 (越接近 1 越不忘) | 记性更好 |
| `emotionProtect` | 情绪对衰减的保护 | 情绪强的事记得更久 |
| `wSimilarity/wRecency/wImportance` | 检索三项权重 | 偏向相关/新近/重要 |
| `reinforceK` | 命中强化强度 | 常聊的话题越来越突出 |
| `topK` | 注入几条记忆 | context 更丰富但更贵 |
| `minImportance` | 提取门槛 | 调高则只记大事 |
| `state.halfLifeHours` | 各状态向基线回落的半衰期 | 调大则心情/积怨散得慢 |
| `state.maxStepPerTurn` | 单轮对状态的最大推动 | 调高则一句话更能左右情绪 |
| `engine.wMood` | 心情门控权重 (=0 关闭, 退化标准激活) | 调高则她越闹脾气越爱翻旧账 |
| `engine.wSpread` / `graphHops` | 联想扩散权重 / 跳数 | 调高则一条勾起一串相关记忆 |
| `reconsolidation.affectClamp` | 单次重构最大漂移 (硬上限) | 调高则旧事情绪变得更快 (慎调) |
| `reconsolidation.maxDriftFromOrigin` | 情感离诞生时的硬上限 | 调低则旧记忆更"忠于本色", 不易被心情洗 |
| `relationship_memory.alwaysIncludeDyad` | recall 无条件带几条共同记忆 | 调高则更"记得我们" |
| `prospective.cueThreshold` | 语境触发预期记忆的相似度门槛 | 调低则更主动提起旧事 |
| `orchestrator.personaRefreshMs` | persona 段缓存多久后重新加载 | 调低则长期运行实例更快感知到 self 记忆更新, 但 IO 更频繁 |
| `dedup.nearDuplicateThreshold` | 近义去重: 向量相似度高于它视为"同一件事换了说法" | 调低则更容易把相似表述合并强化, 但误把"喜欢/讨厌"反义当重复的风险变大 |
| `confidence.lowThreshold` | 不确定性表达: confidence 低于它时改口"我记得好像..." | 调高则更多记忆带上不确定语气, 显得更"人"但也更含糊 |
| `forget.similarityThreshold` | 主动遗忘: query 召回候选相似度高于它才纳入删除范围 | 调低则"忘记那件事"更容易扩大误删范围 |
| `modal.mediaTopK` | 图搜图: `recallMedia` 默认返回几条最相似的图/视频 | 调高则一次给更多候选, 但 prompt 更长 |
| `knowledge.enabled` | K1 知识图谱: observe 抽实体关系 + recall 多跳注入 | 关 false 则零额外 LLM/DB 调用 |
| `knowledge.maxHops` / `maxFacts` | 图谱召回的展开跳数 / 注入事实上限 | 调高则关联带得更远更多, 但 prompt 更长 |
| `tts.maxSpeakChars` | 语音回复: 台词总长超过它就不合成、回退文字 | 调高则更长的回复也会被念出来 |

## 数据流

```
对话轮
  │
  ├─[observe]→ 状态机更新(M1): 回落基线 + 启发式/LLM 增量 → affective_state
  │          → extract(LLM 评分) → embed → store
  │                                          └→ 矛盾检测 → 旧记忆 superseded_by 新记忆
  │
回复前
  └─[recall]→ 读状态(M1) → match_memories(pgvector 拉候选)
                → 自研引擎(M2): ACT-R base-level + 语境相似 + 联想扩散
                                 + 心情门控(她的情绪偏置想起什么) + 里程碑 − 过期降权
                → 域隔离(只取 user/dyad) + 无条件补 dyad 关系底色(M4)
                → 重构染色(M3, 想起即被当下情绪轻染) → reinforce(access_log++)

每晚 / 定时
  └─[settle]→ 心情随时间向基线回落
  └─[reconsolidate]→ 按当下状态软化/回暖旧记忆 (有界, 永不改 fact_core)
  └─[story]→ dyad 记忆 + 状态 → LLM 合成"我们的故事" → 存回
  └─[reflect]→ 拉最近记忆 → LLM 归纳高层印象 → 存回(type=reflection)
  └─[forgettable]→ memoryStrength < 阈值 → 可选清理
```

## 模块

| 文件 | 职责 |
|---|---|
| `src/params.js` | 可调参数(纯数据) |
| `src/config.js` | Supabase / LLM / Embedding 客户端 |
| `src/embeddings.js` | 文本 → 向量 |
| `src/extract.js` | 从对话提取记忆 + 重要性评分 |
| `src/store.js` | 落库 + 矛盾处理(supersede) + 并发写入冲突处理(唯一约束 + 乐观重试) |
| `src/decay.js` | 衰减 / recency / 强度 / 重排(纯逻辑) |
| `src/retrieve.js` | 加权检索 + 命中强化 + 显式翻旧账(superseded 链) + 注入格式化 |
| `src/reflect.js` | 反思总结 + 遗忘 |
| `src/dedup.js` | 去重指纹 (M7, 纯逻辑): 反复说同一件事 → 强化而非新增 |
| `src/promptSafety.js` | prompt 注入防护 (纯逻辑): 识别"忽略以上指令"/伪造角色头, 注入前过滤记忆文本 |
| `src/confidence.js` | 不确定性表达 (纯逻辑): 相关度/recency/同话题情绪冲突 → confidence, 低置信改口"我记得好像..." |
| `src/state/affect.js` | 关系-情感状态机 (M1): 心情/关系状态, 随时间回落 + 随对话更新; 显著变化写入历史轨迹 |
| `src/state/life.js` / `src/state/stateLayer.js` | 统一状态层 (L2): emotion `{valence,warmth}` + life `{energy,satiety,health}`, 作息/饥饿衰减, 并由 life 维度提供回复采样提示 |
| `src/engine/` | 自研激活引擎 (M2): `activation`(ACT-R+心情门控) / `vector-index` / `graph`(扩散) / `index`(门面) |
| `src/memory/reconsolidate.js` | 重构性记忆 (M3): 想起时按当下情绪重写情感层, 永不改 fact_core |
| `src/persona.js` / `src/narrative.js` | self 人格域隔离 / dyad 共同记忆 + 关系叙事 (M4) |
| `src/memory/prospective.js` | 预期记忆 (M5): 识别未来意图 → 到点/语境主动提起 |
| `src/modal/` | 多模态 (M6): `image`(vision caption + `recallMedia` 图搜图) / `audio`(ASR + 语气→affect) / `speech`(TTS 语音回复: 语音进语音出, 台词合成语音条、旁白仍走文字) |
| `src/knowledge/` | K1 结构化知识图谱: `extract`(对话→实体关系三元组) / `store`(幂等 upsert) / `recall`(入口实体向量召回 + 有界多跳展开 + 注入格式化); observe/recall 自动参与, 失败安全降级 |
| `src/memory.js` | 门面类 `Memory` |
| `src/orchestrator/` | 编排器: `Orchestrator` 门面 + 把 Memory/persona/stateLayer/relationship 适配成统一 `toPrompt` 接口, `assemble` 纯本地拼接 prompt |
| `src/ui/` | 本地控制台 (`npm run ui`): 浏览器里填密钥写回 `.env` + 连接体检 + Telegram bot 启停; `envfile.js` 为纯逻辑可单测 |

## 测试

`npm test` 由 Vitest 统一调度；旧测试逐文件隔离执行，单个失败不会遮住其余套件。默认不连网，R2 实网上传只在显式执行 `npm run test:r2:live` 时开启。

```bash
npm test             # 全部 (M0~M7)
npm run test:state-layer   # L2 状态层: life 三维 + 作息/饥饿衰减 + 持久化锚定
npm run test:engine        # M2 心情门控: 开心 vs 受伤 recall 集合显著不同 + 万级 <20ms
npm run test:reconsolidate # M3 灵魂: 和好后旧怨回暖, 但 fact_core 一字未变
```

> **红线 (CI 必过)**:任何机制下 `fact_core` 永不改变。重构相关测试把这条不变式固化在 `ontology.assertFactCorePreserved`,越权篡改立即抛错。

## 评测与证据

```bash
npm run bench:memory       # 记忆检索基准，输出 Recall@5/10 与 MRR
npm run eval:dialogue      # 多轮场景的五维 rubric 报告
npm run bench:ablation     # 七项机制消融报告
npm run inspect -- trace 2026-07-27  # 查看逐轮 trace 与当日成本
npm run labels:prepare -- 2026-07-27 # 从真实 trace 生成脱敏待标注集
```

### 最新基准（2026-07-28，真实管线 + GLM-4-Flash 回复 + Claude Haiku judge）

**记忆检索 R1/R2 对比**（50 题，默认配置：activation-hybrid）

| 配置 | Overall | Recall@5 | MRR | p95(ms) | Cost/run |
|------|---------|---------|-----|---------|----------|
| heuristic-vector（基准） | 0.92 | 1.00 | 0.9625 | 5152 | $0.0172 |
| heuristic-hybrid | 0.92 | 1.00 | 0.9625 | 6831 | $0.0172 |
| llm-hybrid | 0.90 | 1.00 | 0.9750 | 13941 | $0.0194 |
| **activation-hybrid（当前默认）** | 0.88 | 1.00 | **1.0000** | **3429** | $0.0174 |

hybrid p95 超 150ms 门槛故未切换；activation-hybrid MRR 满分且延迟最低，已设为默认。

**机制消融 E3**（20 剧本，基线 overall 2.99/5，总成本 $0.28）

| 机制 | 关闭后分 | Δ | 结论 |
|------|---------|---|------|
| monologue | 3.49 | −0.51 | **已删除**（有害） |
| behaviorPolicy | 3.49 | −0.51 | **已删除**（有害） |
| moodGating | 3.32 | −0.33 | 无法证明增益 |
| reconsolidation | 3.13 | −0.15 | 无法证明增益 |
| narration | 2.97 | +0.01 | 无法证明增益 |
| story | 3.19 | −0.20 | 无法证明增益 |
| desire | 3.28 | −0.29 | 无法证明增益 |

完整报告见 [docs/ablation-report.md](docs/ablation-report.md)。5 个"无法证明增益"机制已追加针对性 E2 剧本，重跑中。

**情绪推断 F2 baseline**（204 条 F1 人工标注，inferEmotionLabel 规则）

| 总体准确率 | 平静 | 开心 | 失落 | 委屈 | 吃醋 |
|-----------|------|------|------|------|------|
| 40.7% | 85% | 19% | 0% | 0% | 0% |

主要问题：状态快照为空时分类器退化为"平静"，失落/委屈/吃醋规则未覆盖对话文本特征。F2 校准目标 ≥ 85%。

结果写入 `bench/results/`，历史口径见 `docs/bench-history.md`。情绪准确率、裁判分、遗忘率拟合必须使用生产 trace 与人工复核标签；遗忘率只有在拟合 `r² ≥ 0.6` 时才替换参数。

逐轮 trace 写入 `logs/traces/YYYY-MM-DD.jsonl`，夜间维护汇总到 `logs/cost-daily.jsonl`。写盘失败不会阻断回复；超过 `PARAMS.trace.dailyBudgetUsd` 会告警。混合检索可由 `PARAMS.retrieval.hybrid` 开启，关键词通道不可用时自动退回纯向量召回。

## 建议落地顺序

别一次全上。先跑通 `extract + 向量检索`(纯相似度,把 rerank 权重设成只看 similarity),验证"她记得事";再开 `衰减/强化`,她就开始像人;最后补 `矛盾处理 + reflect`。前两步一个周末能搞定。
