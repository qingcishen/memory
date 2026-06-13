# Cyber Memory · 项目介绍与使用指南

Cyber Memory 是一个给 AI 伴侣、长期角色、个人助理使用的类人记忆系统。它不把每句聊天都粗暴塞进向量库,而是尝试模拟人类记忆的几个关键特征:选择性记住、逐渐淡忘、反复提起会强化、心情会影响想起什么、旧偏好被新偏好取代后仍留下变化痕迹。

它的核心目标不是做一个"什么都记得的数据库",而是让 AI 在长期关系里表现得更自然:记得重要的事,忘掉无意义寒暄,能主动关心未来事件,也能在合适的时候说出"你以前不是挺讨厌香菜的吗"。

## 适合场景

- AI 伴侣、AI 女友、AI 男友、长期陪伴角色
- 长期个人助理或私人秘书
- 需要关系记忆的角色扮演系统
- 需要记忆衰减、矛盾处理、反思总结的聊天应用
- 想在普通 RAG 之外实验"情绪状态 + 记忆重构"的项目

不适合的场景:

- 需要严格审计、绝对忠实引用的企业知识库
- 多用户共享知识库
- 只想做简单 top-k 向量检索的短期聊天机器人

## 核心能力

| 能力 | 说明 |
|---|---|
| 选择性提取 | 从对话里提取事实、偏好、事件、关系记忆,过滤寒暄 |
| 重要性评分 | 生日、承诺、共同经历比普通闲聊更重要 |
| 衰减与强化 | 记忆会随时间变淡,被反复想起会变强 |
| 加权检索 | 综合 similarity、recency、importance,不是只看向量相似度 |
| 矛盾取代 | 新偏好取代旧偏好时不删除旧记忆,而是保留 supersede 链 |
| 显式翻旧账 | 普通 recall 取当前事实;需要历史感时调用旧版本链 |
| 情绪状态机 | 维护 mood 与 relationship,影响召回和重构 |
| 心情门控 | 开心时更容易想起温暖记忆,受伤时更容易想起负面记忆 |
| 重构性记忆 | 想起旧事时,情感层会被当前心情轻微染色 |
| 共同记忆 | 区分 user / self / dyad,把"我们"作为独立记忆主体 |
| 预期记忆 | "你明天面试"会在明天或相关语境中主动回来关心 |
| 多模态入口 | 图片 caption、语音转写与语气可以进入同一套记忆系统 |
| 反思与遗忘 | 定期总结高层印象,找出低强度可遗忘记忆 |

## 基本架构

Cyber Memory 把每条记忆拆成两层:

```js
{
  fact_core: "诗雅以前讨厌香菜",       // 不可变事实核
  affect_valence: -0.4,               // 可重构情感正负
  affect_intensity: 0.6,              // 可重构情感强度
  narrative: "她当时真的很排斥那个味道", // 可重构主观解读
  subject_kind: "user"                // user / self / dyad
}
```

最重要的安全规则是:任何机制都不能改写 `fact_core`。系统允许情感和解读随状态变化,但事实核必须保持不变。

一次完整对话通常分成两步:

1. 回复前调用 `recall` / `recallAsPrompt`,取出相关记忆注入 LLM。
2. 回复后调用 `observe`,更新情绪状态、提取新记忆、处理矛盾、安排预期记忆。

## 快速开始

安装依赖:

```bash
npm install
```

准备环境变量:

```bash
cp .env.example .env
```

在 `.env` 中填写:

```bash
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=your_service_role_key

LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=your_deepseek_key
LLM_MODEL=deepseek-chat

EMBED_BASE_URL=https://api.openai.com/v1
EMBED_API_KEY=your_openai_key
EMBED_MODEL=text-embedding-3-small
```

注意:

- 不要提交真实 `.env`。
- `.env.example` 只能保留占位符。
- 如果更换 embedding 模型维度,需要同步修改 `sql/schema.sql` 里的 `vector(1536)`。

## 数据库初始化

项目使用 Supabase Postgres + pgvector。

1. 打开 Supabase SQL Editor。
2. 执行:

   ```sql
   -- 复制并执行 sql/schema.sql 全文
   ```

3. 确认已启用 `vector` extension,并创建 `memories`、`affective_state`、`prospective` 等表。

本地代码只负责调用 Supabase;schema 变更以 `sql/schema.sql` 为准。

## 最小使用示例

```js
import { Memory } from 'cyber-memory';

const mem = new Memory({
  userId: 'user_123',
  subjectName: '诗雅',
});

const userMessage = '我明天有面试, 有点紧张。';

// 1. 回复前: 取相关记忆
const memoryBlock = await mem.recallAsPrompt(userMessage);

// 2. 把 memoryBlock 注入你的 LLM system prompt
// const reply = await yourLLM([...]);
const reply = '明天面试前早点休息, 我会记得问你结果。';

// 3. 回复后: 观察本轮对话,更新状态并提取记忆
const result = await mem.observe([
  { role: 'user', content: userMessage },
  { role: 'assistant', content: reply },
]);

console.log(result.stored);
console.log(result.scheduled);
```

## 推荐对话集成流程

```js
async function handleTurn(userId, subjectName, userMessage, history) {
  const mem = new Memory({ userId, subjectName });

  const [memoryBlock, personaBlock, dueProspectives] = await Promise.all([
    mem.recallAsPrompt(userMessage),
    mem.persona(),
    mem.checkProspective({ query: userMessage }),
  ]);

  const prompt = [
    '你是一个长期陪伴型 AI。',
    personaBlock,
    memoryBlock,
    dueProspectives.length > 0
      ? `可以自然提起这些待关心的事:\n${dueProspectives.map((p) => `- ${p.content}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  const reply = await callYourLLM({ prompt, history, userMessage });

  await mem.observe([
    { role: 'user', content: userMessage },
    { role: 'assistant', content: reply },
  ]);

  if (dueProspectives.length > 0) {
    await mem.dismissProspective(dueProspectives.map((p) => p.id));
  }

  return reply;
}
```

## 常用 API

### `new Memory({ userId, subjectName })`

创建某个用户的记忆门面。所有记忆按 `userId` 隔离。

```js
const mem = new Memory({ userId: 'u_1', subjectName: '诗雅' });
```

### `observe(turns, opts)`

在一轮回复结束后调用。它会:

- 更新情绪/关系状态
- 从对话中提取记忆
- 存储新记忆
- 处理矛盾 supersede
- 自动排预期记忆

```js
await mem.observe([
  { role: 'user', content: '我不喜欢香菜' },
  { role: 'assistant', content: '好, 我记住了。' },
]);
```

### `recall(query, opts)`

回复前检索相关记忆,返回结构化记忆数组。

```js
const hits = await mem.recall('今晚吃什么');
```

默认走自研激活引擎。传 `{ engine: false }` 可以回退到旧的 pgvector + rerank 路径。

### `recallAsPrompt(query, opts)`

检索后直接格式化成可注入 LLM 的文本。

```js
const block = await mem.recallAsPrompt('今晚吃什么');
```

### `recallHistory(query, opts)`

显式检索被 supersede 的旧版本链。适合"以前/曾经/不是以前"这种历史语境。

```js
const history = await mem.recallHistory('香菜');
```

### `recallHistoryAsPrompt(query, opts)`

把旧版本链格式化成 prompt:

```js
const block = await mem.recallHistoryAsPrompt('香菜');
```

输出类似:

```text
你记得诗雅以前说法/偏好的变化:
- 以前: 诗雅讨厌香菜; 后来更新为: 诗雅现在喜欢香菜
```

### `state()` / `mood()` / `settle()`

读取和维护当前情绪状态。

```js
const state = await mem.state();
const mood = await mem.mood();
await mem.settle();
```

### `reconsolidate(opts)`

按当前状态批量重构最近记忆的情感层。常用于和好后、夜间任务或定期维护。

```js
await mem.reconsolidate();
```

### `seedPersona(facts)` / `persona(opts)`

写入和读取 AI 自身设定。`self` 记忆与用户记忆隔离。

```js
await mem.seedPersona([
  '我有点社恐',
  '我喜欢雨天和甜食',
]);

const personaBlock = await mem.persona();
```

### `story(opts)`

把 dyad 共同记忆和关系状态合成为"我们的故事"。

```js
await mem.story();
```

### `checkProspective(ctx, now)` / `dismissProspective(ids)`

检查是否有该主动提起的未来事项,并在提起后标记 fired。

```js
const due = await mem.checkProspective({ query: '面试怎么样' });
await mem.dismissProspective(due.map((p) => p.id));
```

### `seeImage(opts)` / `hearVoice(opts)`

多模态入口。缺少外部 vision / ASR 凭证时会降级为空结果,不应影响主流程。

```js
await mem.seeImage({ url: imageUrl });

await mem.hearVoice({
  transcript: '我没事',
  prosody: { tone: 'crying' },
});
```

### `reflect(opts)` / `forgettable(threshold, opts)`

定期反思和遗忘。

```js
await mem.reflect();
const weak = await mem.forgettable(0.05);
await mem.forgettable(0.05, { purge: true });
```

## 定时任务建议

可以按应用需要设置后台任务:

| 频率 | 建议调用 | 目的 |
|---|---|---|
| 每几小时 | `settle()` | 心情向基线回落 |
| 每晚 | `reconsolidate()` | 旧记忆情感层轻微回暖或变淡 |
| 每晚 | `reflect()` | 从碎片合成高层印象 |
| 每周 | `story()` | 更新关系叙事 |
| 每周 | `forgettable()` | 找出可遗忘记忆 |

## 脚本命令

```bash
npm test
npm run test:engine
npm run test:reconsolidate
npm run inspect <userId>
npm run demo
```

测试是纯逻辑单测,默认不连网、不需要真实 Supabase 或 LLM 凭证。

## 目录结构

```text
src/
  memory.js                 # Memory 门面类
  extract.js                # 对话提取记忆
  store.js                  # 存储、去重、矛盾 supersede
  retrieve.js               # 检索、强化、历史链召回
  state/affect.js           # 情绪/关系状态机
  engine/                   # 自研激活引擎
  memory/reconsolidate.js   # 重构性记忆
  memory/prospective.js     # 预期记忆
  modal/                    # 图片/语音入口
  narrative.js              # 共同记忆与关系叙事
  persona.js                # self/persona 域
sql/schema.sql              # Supabase + pgvector schema
examples/*.test.js          # 纯逻辑测试
docs/DEVELOPMENT.md         # 架构与路线图
```

## 常见问题

### 为什么不用普通向量库 top-k?

伴侣记忆不是知识库检索。普通 top-k 会把"相似"当成唯一标准,但长期关系里还需要新近性、重要性、情绪强度、关系主体、心情门控和共同经历底色。

### 为什么旧记忆被取代后不删除?

因为"偏好变化"本身是有意义的。当前回答应使用新事实,但历史语境里旧事实能让 AI 表现出关系连续性。

### 重构性记忆会不会改错事实?

不应该。系统的红线是 `fact_core` 不可变。重构只允许影响 `affect_valence`、`affect_intensity` 和 `narrative`。

### 没有 LLM / Supabase 凭证能跑测试吗?

可以。测试覆盖的是纯逻辑层,默认不连网。真正调用 `observe`、`recall` 等 IO 路径才需要配置服务。

### 图片检索现在完整吗?

图片会以 caption 文本进入普通记忆召回。`media_embedding` 字段已经预留,但图搜图/跨图检索仍在后续队列里。

## 上线前检查

- `.env` 没有进入 git。
- Supabase 已执行最新 `sql/schema.sql`。
- embedding 模型维度与 schema 一致。
- `npm test` 通过。
- 回复层区分普通 recall 与显式历史 recall。
- prompt 注入前对记忆文本做必要过滤和转义。

