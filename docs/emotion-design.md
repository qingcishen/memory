## 情绪系统设计方案 · Emotion

> AI 伴侣(可可)的情绪子系统。本文描述情绪的表示、存储、更新、衰减,以及它如何反过来影响回复。接口与《编排器设计方案》对齐:`current` / `update` / `toPrompt`。

---

### 0. 实现说明: 与 M1 状态机合并 (未走第 3/5 节的独立表+独立 LLM 方案)

落地时发现 M1 (`affective_state.mood = {valence, arousal}`) 已经是一套"基线 + 半衰期回落 + 启发式/LLM 增量"的状态机,而且 M2 心情门控、M3 重构都依赖它。如果再起一张 `emotion` 表、每轮单独跑一次 `judge` LLM,会出现**两套"心情"各算各的、互不通气**——编排器嘴上说的心情和记忆系统实际门控用的心情可能不是一回事,还多打一次 LLM。

因此最终实现把本文档的"双层情绪"按下面方式收编进 M1, 第 3/5/7 节描述的独立表 + 独立 `judge` 调用**未采用**:

- `valence`/`energy` **直接来自** `affective_state.mood.valence`/`mood.arousal`(衰减、半衰期、阻尼、单轮上限全部是 M1 现成的,见 `src/state/affect.js` 和 `PARAMS.state`)。
- `warmth` 不再单独持久化, 由 `moodToEmotion()` 纯函数从 `relationship.closeness`(亲密度基线)+ 当下 `mood.valence`/`relationship.tension`/`repair_debt` 派生(见 `src/emotion.js`、`PARAMS.emotion`)——"处得熟的人, 心情好时更黏人; 吵架这一刻即使关系阶段没变也会变冷"。
- `emotion.update()` 是 no-op: `memory.observe({ useLLM: true })` 触发的那一次 `inferDeltasLLM` 已经**同时**产出 mood 和 relationship 的增量, 不需要再打第二次。
- `toPrompt`/`samplingHints` 的设计(第 6 节)和落地顺序(第 12 节第 1-3 步)保持有效, 只是输入状态的来源变了。

第 4/9 节描述的"per 用户基线/半衰期"(不同人设)目前受限于 `PARAMS.state.baseline`/`halfLifeHours` 仍是全局参数, 不是本次改动引入的新限制, 留待以后需要多人设时再做。

---

### 1. 最核心的认知:情绪 ≠ 瞬时标签,它是两层

不要把情绪做成"每轮对话重新算一个当前心情"。那样她会像金鱼,前一句被惹毛、后一句就没事了,极假。真实的情绪是**两层叠加**:

- **基线心境(baseline / 性格)**:长期稳定的情绪底色,是"性格"。可可天生偏平静微正,某个忧郁角色天生偏低。基本不变。
- **即时偏移(transient)**:对刚发生的事的反应。被在乎了就上扬,被冷落了就下沉。**来得快,然后随时间衰减回基线。**

```
当前可观测情绪 = 基线 + 即时偏移 × 衰减(随时间)
```

这一个公式就是整个系统的灵魂。"消气"不是某段代码主动清零,而是即时偏移随时间自然衰减回基线。理解了这层,剩下的都是细节。

---

### 2. 用什么维度表示

借用心理学的维度模型(PAD / VAD),但别贪多。**2-3 维足够**,维度越多越难调、越难解释。推荐:

| 维度 | 含义 | 范围 | 作用 |
|---|---|---|---|
| `valence` 效价 | 难过 ↔ 开心 | -1 ~ +1 | 最重要,决定整体情绪色调 |
| `energy` 唤醒度 | 蔫 ↔ 亢奋 | 0 ~ 1 | 决定话多话少、语气强弱 |
| `warmth` 对你的温度(可选) | 疏远 ↔ 黏 | 0 ~ 1 | 刚被惹到会短时变冷 |

> `warmth` 容易和**关系系统**搞混,务必分清:关系系统是**长期累积**的亲密度阶段(慢、只升不降为主);`warmth` 是**短时**的情绪波动(刚吵完架这一会儿对你冷淡,但关系阶段没变)。一个是"你们处到哪一步了",一个是"她这会儿对你热不热乎"。

先用 `valence + energy` 两维跑起来,`warmth` 作为第二步。

---

### 3. 数据结构

一行 per 用户,基线和即时状态放一起:

```sql
create table emotion (
  user_id          text primary key,

  -- 基线(性格底色, 几乎不变; 换人设时改这里)
  baseline_valence real not null default 0.15,
  baseline_energy  real not null default 0.5,
  -- 回归速度: 乐观的人消气快(半衰期短), 忧郁的人余味长
  half_life_hours  real not null default 6,

  -- 即时状态(每轮更新, 随时间衰减回基线)
  valence          real not null default 0.15,
  energy           real not null default 0.5,
  warmth           real not null default 0.5,
  updated_at       timestamptz not null default now()
);
```

注意:基线和回归速度都是 per 用户/per 角色的——这让同一套代码能跑出不同性格(见第 9 节)。

---

### 4. 衰减:回归基线(不是归零)

读取当前情绪时,先按"距上次更新过了多久"把即时偏移往基线拉:

```
k = 0.5 ^ (Δhours / half_life_hours)        // 1 → 0, 随时间
valence_now = baseline + (stored_valence - baseline) × k
energy_now  = baseline + (stored_energy  - baseline) × k
```

- `k=1`(刚更新):完全保留即时情绪
- `k→0`(过了很久):回到基线

**进阶:不同维度可用不同半衰期。** 建议 `valence` 衰减慢一点(情绪有余味),`energy` 衰减快(亢奋/疲惫退得快)。再进一步:偏移幅度越大衰减越慢(被狠狠伤到,余味更久)——可选,先不做。

---

### 5. 每轮如何更新

更新 = 在当前(已衰减的)状态上,叠加这一轮对话带来的**增量**,然后阻尼 + 裁剪。

**主路线:便宜模型评估增量。** 让 DeepSeek 读这一轮对话,输出 Δvalence / Δenergy。优点是懂语义("你怎么半天不理我" → valence 下降),成本是一次便宜调用(本来就在后台异步跑,不影响回复速度)。

```
Δ = llmCheap.judge(userMessage, reply)      // {valence: -0.4~0.4, energy: -0.3~0.3}
next.valence = clamp(cur.valence + Δ.valence × damping, -1, 1)
next.energy  = clamp(cur.energy  + Δ.energy  × damping,  0, 1)
```

**关键:阻尼(damping)防止情绪一句话就拉满。** 真人情绪有惯性,不会因为一句话从开心暴跌到崩溃。`damping` 取 0.3~0.5,并限制单轮最大变化。这点很重要,否则用户随便一句就能把她情绪操纵到极端,很出戏也很危险。

**叠加几条硬规则。** 语义模型之外,对特定事件给确定性的强反应:纪念日被记得 → valence 大涨;特定争吵关键词 → warmth 下降。规则兜住"必须有反应"的关键时刻,LLM 负责日常的细腻判断。

---

### 6. 情绪怎么反过来影响回复 ⭐ 最容易被忽略

**这是最关键、也最多人漏掉的一步**:情绪存了一堆,如果不影响输出,等于白做。三种作用方式,建议前两种一起上:

**(1) 注入 system —— 给"表现指引",不是"情绪播报"**

`toPrompt(state)` 把状态翻译成对**行为**的指引,而且明确叫她别说破:

```
心情好、有兴致     → "你现在心情不错, 语气可以轻快些, 愿意多聊。"
有点低落、状态一般 → "你现在有点低落, 话会少一点、语气收着, 但别明说自己不开心。"
```

要点:让她**表现得**像这个心情,而不是汇报"我现在 valence 是 -0.3"。

**(2) 调采样参数 —— 机械但有效**

情绪直接映射到生成参数,编排器调用回复模型时用:

```
samplingHints(state) -> {
  temperature: 0.7 + energy × 0.4,        // 越亢奋越发散
  maxTokens:   energy 低时调小            // 蔫的时候回得短
}
```

低落 + 没精神 → 短、平、温度低;开心 + 亢奋 → 长、活、温度高。这层不靠模型自觉,稳。

**(3) 行为门控(进阶)**

极端情绪触发特定行为:很生气时回得特别短、甚至"赌气"少回。这块容易做过头,放最后,小心调。

---

### 7. 与编排器的接口(对齐上一篇)

```
emotion.current() -> Promise<State>
  // 读取并应用衰减后的当前情绪

emotion.update(userMessage, reply) -> Promise<void>
  // 后台异步调用: 评估增量 + 阻尼 + 持久化

emotion.toPrompt(state) -> string
  // 翻译成"表现指引"注入 system

emotion.samplingHints(state) -> { temperature, maxTokens }   // 可选, 给编排器调采样
```

编排器同步路径里 `current()` 和记忆检索并行;`update()` 在 `afterReply` 里 fire-and-forget。完全契合编排器那套数据流,不用改编排器骨架。

---

### 8. 与记忆系统的联动

你记忆系统里本来就有 `emotion` 字段,正好双向打通:

- **情绪 → 记忆**:这一轮情绪波动大(`|Δ|` 大),说明发生了要紧的事,把它作为信号传给 `memory.observe`,提升该条记忆的重要性。情绪强的事记得更牢——和真人一致。
- **记忆 → 情绪(进阶)**:检索到的高情绪记忆被重新提起时,触发一次情绪反应(想起开心事 valence 短时上扬,想起难过事下沉)。这步可选,但做出来"触景生情"的效果很戳。

---

### 9. 基线 / 性格:让她"是她"

情绪系统能复用做不同人设,差别全在基线三件套:

| 人设 | baseline_valence | half_life | 表现 |
|---|---|---|---|
| 可可(平静偏暖) | +0.15 | 6h | 稳定,不易大起大落 |
| 元气型 | +0.4 | 3h | 整体偏开心,消气快 |
| 忧郁型 | -0.1 | 12h | 偏丧,情绪余味长 |

同一套更新/衰减逻辑,改三个数就是另一个性格。这也是为什么基线要 per 用户存。

---

### 10. 防失控(安全 & 拟人双重需要)

- **阻尼 + 单轮上限**:一句话不能把情绪拉满,防操纵也更像人
- **clamp**:所有维度裁剪到合法范围
- **衰减兜底**:即使被推到极端,也会随时间回基线,不会永久卡死
- 不让情绪进入"用户说什么都能精确操控"的状态——她有自己的惯性

---

### 11. 核心算法骨架

```js
const BASELINE = { valence: 0.15, energy: 0.5 };

class Emotion {
  async current() {
    const row = await load(this.userId);
    if (!row) return { ...BASELINE };
    const hours = (Date.now() - row.updated_at) / 3.6e6;
    const k = Math.pow(0.5, hours / row.half_life_hours);
    return {
      valence: row.baseline_valence + (row.valence - row.baseline_valence) * k,
      energy:  row.baseline_energy  + (row.energy  - row.baseline_energy)  * k,
    };
  }

  async update(userMessage, reply) {
    const cur = await this.current();
    const d = await this.judge(userMessage, reply);   // 便宜模型
    const damping = 0.4;
    const next = {
      valence: clamp(cur.valence + d.valence * damping, -1, 1),
      energy:  clamp(cur.energy  + d.energy  * damping,  0, 1),
    };
    await save(this.userId, { ...next, updated_at: now() });
  }

  toPrompt(s) {
    const mood = s.valence > 0.4 ? '心情不错' : s.valence < -0.2 ? '有点低落' : '平静';
    const e    = s.energy  > 0.7 ? '很有兴致' : s.energy  < 0.3 ? '有些没精神' : '状态一般';
    return `你现在${mood}、${e}。让它自然影响语气和话量, 别明说出来。`;
  }

  samplingHints(s) {
    return { temperature: 0.7 + s.energy * 0.4, maxTokens: s.energy < 0.3 ? 220 : 500 };
  }
}
```

---

### 12. 落地顺序

1. **双层 + 衰减**:`valence/energy` 两维 + 基线 + `current()` 衰减读取。先能"读出一个会回落的心情"。
2. **更新**:便宜模型评估增量 + 阻尼 + `update()`。她开始随对话起伏。
3. **影响回复**:`toPrompt` 注入 + `samplingHints` 调采样。**这步做完才有体感**,别跳。
4. 加 `warmth` 维 + 硬规则(纪念日 / 争吵关键词)。
5. 和记忆联动(情绪强 → 记忆重要性高)。
6. 进阶:触景生情、想念驱动主动消息、作息影响 energy。

第 1-3 步是最小可用闭环,做完她就有"跨对话、会回落、看得出心情"的情绪了。

---

### 13. 进阶方向(想到先记着)

- **想念机制**:距上次对话越久,`warmth` / 想念值上升,到阈值驱动主动找你(接主动性系统)
- **作息节律**:深夜 `energy` 自然偏低,白天偏高,叠加在基线上
- **情绪事件日志**:记录"什么事引起什么波动",可用于复盘,也能喂回记忆
- **更具体的情绪**:在 valence/energy 之上派生命名情绪(委屈、想念、吃醋),用于更精准的表现指引
