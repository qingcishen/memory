# Cyber Memory

给 AI 伴侣用的"类人"记忆系统。不是把对话一股脑塞进向量库,而是模拟人的记忆方式:**有选择地记、会遗忘、被反复提起会强化、偏好改变会留下痕迹、定期把碎片归纳成印象**。

架构参考斯坦福 Generative Agents 的记忆模型,针对伴侣场景做了改动(情绪保护衰减、矛盾不覆盖而是 supersede)。

完整介绍、接入流程和 API 说明见 [项目介绍与使用指南](docs/INTRODUCTION_AND_USAGE.md)。开发计划和架构验收见 [开发文档与路线图](docs/DEVELOPMENT.md)。

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

LLM 用 OpenAI 兼容接口,DeepSeek 直接可用;Embedding 默认 OpenAI `text-embedding-3-small`(1536 维)。换 embedding 模型记得同步改 schema 里的 `vector(维度)`。

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

const reply = await bot.reply(userMessage);
// 同步路径: persona/relationship/stateLayer/memory 的 toPrompt 拼成 system + 短期历史 + 当前消息 → 生成回复
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
| `src/modal/` | 多模态 (M6): `image`(vision caption + `recallMedia` 图搜图) / `audio`(ASR + 语气→affect) |
| `src/memory.js` | 门面类 `Memory` |
| `src/orchestrator/` | 编排器: `Orchestrator` 门面 + 把 Memory/persona/stateLayer/relationship 适配成统一 `toPrompt` 接口, `assemble` 纯本地拼接 prompt |

## 测试

全部为**纯逻辑**单测,不连网,覆盖各招牌机制的核心与红线(共 438 断言)。

```bash
npm test             # 全部 (M0~M7)
npm run test:state-layer   # L2 状态层: life 三维 + 作息/饥饿衰减 + 持久化锚定
npm run test:engine        # M2 心情门控: 开心 vs 受伤 recall 集合显著不同 + 万级 <20ms
npm run test:reconsolidate # M3 灵魂: 和好后旧怨回暖, 但 fact_core 一字未变
```

> **红线 (CI 必过)**:任何机制下 `fact_core` 永不改变。重构相关测试把这条不变式固化在 `ontology.assertFactCorePreserved`,越权篡改立即抛错。

## 建议落地顺序

别一次全上。先跑通 `extract + 向量检索`(纯相似度,把 rerank 权重设成只看 similarity),验证"她记得事";再开 `衰减/强化`,她就开始像人;最后补 `矛盾处理 + reflect`。前两步一个周末能搞定。
