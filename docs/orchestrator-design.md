# 编排器设计方案 · Orchestrator

> AI 伴侣(可可)的运行时调度中枢。本文只描述编排器,记忆 / 情绪 / 人格 / 关系等子系统通过**接口契约**对接,各自内部实现不在本文范围内。
>
> **v2 已落地**:编排器已对接统一的 `stateLayer` 门面(`snapshot/toPrompt/samplingHints/evolve`,`src/state/stateLayer.js`),情绪是其内部维度、`life`(精力/作息/健康)也已并入。`relationship` 门面不受影响。此外已补:多角色隔离(`companion_id`,见 `src/companion.js`)、L3 生活模拟、L4 健康/生病闭环(身心耦合在 `Memory.observe` 统一演变)、A1 拍照分享(自拍 + 随手拍风景/猫狗,经 `onPhoto` 回调投递,见 `src/appearance/`)。本文档下半部仍按早期"编排器直接对接 emotion"叙述,读时以 `src/orchestrator/` 代码为准。

---

## 1. 它是什么

编排器不是一段 prompt,而是**每轮对话都会运行的一段代码**。它的唯一职责是:在用户消息进来时,把各个独立子系统的输出在运行时动态拼成一次 LLM 调用,拿到回复后再触发必要的后台更新。

一句话:**子系统负责"她是什么样",编排器负责"这一轮怎么把它们凑成一句话说出来"。**

最该避免的反模式是把人格、情绪、记忆、喜好全写进一个巨大的静态 system prompt。那样做有两个硬伤:prompt 越长模型越容易跑偏;情绪、关系这类**跨对话的状态**根本没法靠静态文本维持。编排器存在的意义就是把这些状态变成每轮现场组装的动态输入。

---

## 2. 职责与边界

编排器**做**这些:

- 加载子系统的当前状态(情绪、关系)
- 触发记忆检索
- 组织内心独白(可选)
- 把以上拼成 prompt,调用回复模型
- 回复返回后,触发后台的状态更新(情绪、记忆写入、关系累积)
- 管理短期对话历史

编排器**不做**这些:

- 不实现记忆的存取逻辑(记忆系统自己的事)
- 不实现情绪的计算规则、不实现记忆的衰减
- 不直接碰数据库表(除非某子系统没有门面,临时兜底)

依赖方向**严格单向**:编排器 → 子系统。任何子系统都不应该反过来 import 编排器,否则就是循环依赖,以后想单独测、单独复用都会被卡住。

---

## 3. 子系统接口契约 ⭐

这是对接你现有代码最关键的一节。每个子系统对编排器**只暴露一个门面类**,编排器只认这些方法签名,不关心内部怎么实现。

### 3.1 记忆 Memory(对接你已有的系统)

编排器只需要两个方法:

```
recall(query: string, opts?) -> Promise<string>
  // 输入当前用户消息, 返回一段可直接注入 system prompt 的自然语言记忆块。
  // 例如: "你记得关于诗雅的事:\n- 诗雅讨厌香菜\n- 诗雅在日本备考"
  // 检索、重排、命中强化都在内部完成, 编排器不感知。

observe(turns: {role, content}[]) -> Promise<void>
  // 输入刚刚发生的一轮对话, 内部异步完成提取/评分/写入/矛盾处理。
  // 编排器 fire-and-forget 调用, 不等返回。
```

> 你现有的记忆系统如果方法名不一样,**不用改内部**,写一个十几行的适配类把它包成上面这两个方法即可。这就是门面模式的价值——接口稳定,实现自由演进。

### 3.2 情绪 Emotion

```
current() -> Promise<EmotionState>
  // 读当前情绪状态 (内部应已应用"随时间衰减回基线")

update(userMessage, reply) -> Promise<void>
  // 按这一轮微调情绪并持久化

toPrompt(state) -> string
  // 把情绪状态翻译成注入用的自然语言, 如"你现在有点低落、状态一般"
```

### 3.3 人格 Persona

```
toPrompt() -> string
  // 返回稳定的人格段 (性格 + 说话习惯 + 喜好/厌恶)。每轮注入同一份。
name -> string
```

### 3.4 关系 Relationship

```
current() -> Promise<RelationState>   // 当前亲密度阶段
bump() -> Promise<void>               // 每轮互动 +1
toPrompt(state) -> string             // 阶段 -> 影响称呼/边界/主动度的描述
```

### 设计要点

- 四个门面的 `toPrompt` 形态统一:**子系统把自己翻译成自然语言,编排器只负责拼接**。新增子系统(比如"今天的天气心情""共同回忆里程碑")时,编排器代码几乎不用动,只要它也实现 `toPrompt`。
- 所有 `toPrompt` 必须能容忍"空状态"——新用户没有记忆、没有情绪记录时返回空串或基线描述,而不是抛错。

---

## 4. 运行时数据流

一轮对话分两段:**同步路径**(用户在等,要快)和**后台异步**(用户已拿到回复,慢慢跑)。

### 同步路径(用户在等)

| 步骤 | 动作 | 调用 |
|---|---|---|
| 1 | 加载状态 | `emotion.current()` + `relationship.current()` (并行) |
| 2 | 检索记忆 | `memory.recall(userMessage)` (与步骤 1 并行) |
| 3 | 内心独白 | `llm.think(...)`(可选,便宜模型) |
| 4 | 组装 prompt | 纯本地拼接 |
| 5 | 生成回复 | `llm.generateReply(messages)`(好模型) |
| 6 | 返回用户 | — |

### 后台异步(不阻塞回复)

回复返回后立即触发,**不 await**:

- `emotion.update(userMessage, reply)` — 按这轮调整情绪
- `memory.observe(turns)` — 提取并写入记忆
- `relationship.bump()` — 互动计数 +1

三者用 `Promise.allSettled` 并行,任一失败只记日志,不影响已经发出的回复。

---

## 5. 核心流程(reply 主方法)

下面是编排器主入口的骨架,实现时照着填即可:

```js
async reply(userMessage) {
  // 1) 并行: 加载状态 + 检索记忆 (互不依赖, 一起跑省延迟)
  const [emotionState, relState, memoryBlock] = await Promise.all([
    this.emotion.current(),
    this.relationship.current(),
    this.memory.recall(userMessage),
  ]);

  // 2) 内心独白 (可关; 用便宜模型)
  let monologue = '';
  if (this.options.useMonologue) {
    monologue = await this.llm.think(
      this.buildMonologueContext(userMessage, emotionState, memoryBlock)
    );
  }

  // 3) 组装 prompt -> 生成回复 (好模型)
  const messages = this.assemble({ userMessage, emotionState, relState, memoryBlock, monologue });
  const reply = await this.llm.generateReply(messages);

  // 4) 写短期历史
  this.history.push({ role: 'user', content: userMessage });
  this.history.push({ role: 'assistant', content: reply });
  this.trimHistory();

  // 5) 触发后台异步 (不 await)
  this.afterReply(userMessage, reply);

  return reply;
}
```

后台部分:

```js
afterReply(userMessage, reply) {
  const turns = [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: reply },
  ];
  Promise.allSettled([
    this.emotion.update(userMessage, reply),
    this.memory.observe(turns),
    this.relationship.bump(),
  ]).then(results => {
    for (const r of results)
      if (r.status === 'rejected') console.error('[afterReply]', r.reason);
  });
}
```

---

## 6. Prompt 组装结构

编排器把各子系统的 `toPrompt` 输出按固定顺序拼成 system,再接短期历史和当前消息:

```
system =
  [人格]            persona.toPrompt()
  + [关系阶段]       relationship.toPrompt(relState)
  + [当前情绪]       emotion.toPrompt(emotionState)
  + [记忆块]         memoryBlock
  + [内心独白]       "(你此刻的想法, 别直接说出来): ..."

messages = [
  { role: 'system', content: system },
  ...history.slice(-historyTurns * 2),   // 短期上下文
  { role: 'user', content: userMessage },
]
```

组装函数本身是**纯本地拼接、无 IO**,所以它可以被单元测试直接验证(给定状态,断言拼出来的 system 字符串符合预期)。

关键直觉:同样一句"在干嘛",她心情好和刚闹完别扭时,因为 `emotion.current()` 返回的状态不同,拼出来的 system 不同,回复自然不同。**这就是"活"的机械来源**——不是模型有意识,是它每轮拿到的输入真的不一样。

---

## 7. 关键设计决策

### 7.1 同步 / 异步分离

同步路径只跑用户必须等的事(检索、独白、生成)。情绪更新、记忆写入这些重活(往往各含一次 LLM 调用)全丢后台。否则用户会盯着"对方正在输入"等你做完一串调用,体验崩掉。

### 7.2 状态持久化、跨对话

情绪和关系存数据库,跨对话延续。这是 AI 伴侣和普通 bot 最大的区别:普通 bot 每次对话都是新的,她不是——今天闹了别扭,明天她还带着点情绪。连续性最戳人。

### 7.3 多模型路由

- 回复(她的"嘴")用好模型,温度调高一点更有人味
- 内心独白、情绪评估、记忆提取/判断用便宜模型(DeepSeek 足够)

一轮对话可能触发好几次 LLM 调用,全用贵的扛不住成本。把"调用回复模型"和"调用便宜模型"封装成两个函数,编排器只调函数。

### 7.4 依赖注入

编排器构造函数接受可选的 `deps`(memory / emotion / persona / llm 实现),默认用真实的。这样:

- 测试时注入 mock,**不连数据库、不调 LLM** 就能验证管线顺序、组装正确性、afterReply 是否被触发
- 以后想替换某个子系统(换记忆实现、换情绪算法),编排器一行不用改

```js
new Orchestrator({
  userId, subjectName: '诗雅', companionName: '可可',
  deps: { memory: myMemoryAdapter },   // 注入你的记忆系统适配器
  options: { useMonologue: true, historyTurns: 6 },
});
```

### 7.5 内心独白

回复前先用便宜模型生成一段不展示的想法("他今天有点冷淡,是不是我昨天那句话不对"),再把它作为 system 的一部分喂给回复生成。这一层让回复明显有深度和"心机",而不是有问必答的工具感。是性价比最高的"拟人"手段之一。

---

## 8. 短期历史管理

- 内存版:实例内维护 `this.history` 数组,每轮 push 两条(user + assistant),`trimHistory()` 只留最近 `historyTurns * 2` 条
- 局限:多实例 / 进程重启会丢
- 生产建议:改成每轮从数据库拉最近 N 轮(对话表你大概率已经有了),编排器无状态,水平扩展无压力

短期历史(最近几轮原文)和长期记忆(`memory.recall` 检索回来的提炼事实)是**两个不同的东西**,都要进 prompt:前者给连贯性,后者给"她记得你"。

---

## 9. 错误处理与降级

同步路径里**任何子系统失败都不该让回复挂掉**。建议给每个状态加载加降级:

- `memory.recall` 失败 → 用空记忆块继续(她这轮"想不起来",但还能聊)
- `emotion.current` 失败 → 用基线情绪
- 内心独白失败 → 跳过,直接生成

后台 `afterReply` 用 `allSettled`,失败只记日志。原则:**宁可这一轮没记住 / 没更新情绪,也不能让用户收不到回复。**

---

## 10. 配置项

| 配置 | 作用 | 默认 |
|---|---|---|
| `useMonologue` | 是否开内心独白 | true |
| `historyTurns` | 注入多少轮短期历史 | 6 |
| `REPLY_MODEL` | 回复模型 | 好模型 |
| `CHEAP_MODEL` | 后台 / 独白模型 | DeepSeek |
| 情绪/关系参数 | 在各自子系统内 | — |

---

## 11. 主动性(后台,独立于 reply)

主动发消息**不在 reply 管线里**,它的触发源是定时器而非用户消息,但复用同一套组装逻辑:

```
定时检查 (作息 / 距上次对话时长 / 特定事件)
  -> 若该主动: 用 [人格]+[情绪]+[相关记忆] 组装一个"主动开场"的 prompt
  -> 生成消息 -> 推送给用户
```

可以抽一个 `proactiveTick()` 方法,和 `reply()` 共用 `assemble()`。建议放到最后做——后台调度(作息建模、防打扰、频率控制)是这一块最麻烦的部分。

---

## 12. 落地顺序

别想一口吃成,按这个顺序每步都能跑通验证:

1. **最小闭环**:`Persona + Memory.recall + 回复生成`。先把同步路径跑通——这就已经是个有记性的角色了。
2. 接 **Memory.observe**(后台写入)+ 短期历史。她开始"记得刚才聊的"。
3. 加 **情绪**(current/update/toPrompt)。她开始有跨对话的心情起伏。
4. 加 **内心独白**。回复质量上一个台阶。
5. 加 **关系阶段**。称呼和边界随亲密度变化。
6. 最后做 **主动性**。

每一步都是在稳定的编排器骨架上插一个新子系统,因为接口契约统一,插入成本很低。

---

## 附录:接口签名速查

```
// 编排器
new Orchestrator({ userId, subjectName, companionName, deps?, options? })
orchestrator.reply(userMessage) -> Promise<string>

// 子系统门面 (编排器依赖的全部接口)
memory.recall(query, opts?) -> Promise<string>
memory.observe(turns) -> Promise<void>

emotion.current() -> Promise<EmotionState>
emotion.update(userMessage, reply) -> Promise<void>
emotion.toPrompt(state) -> string

persona.toPrompt() -> string
persona.name -> string

relationship.current() -> Promise<RelationState>
relationship.bump() -> Promise<void>
relationship.toPrompt(state) -> string

// LLM 封装 (可注入)
llm.generateReply(messages) -> Promise<string>   // 好模型
llm.think(context) -> Promise<string>            // 便宜模型, 内心独白
```
