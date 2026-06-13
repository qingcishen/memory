// 整套系统的"性格"参数都在这里调。纯数据, 无副作用。
export const PARAMS = {
  // 衰减: 每 24h 记忆强度乘以 baseDecay。越接近 1 忘得越慢。
  baseDecay: 0.99,
  // 情绪对衰减的保护: emotion=1 时衰减率向 1 靠拢的程度。
  emotionProtect: 0.6,
  // 检索重排三项权重 (会各自归一化)
  wSimilarity: 0.5,
  wRecency: 0.2,
  wImportance: 0.3,
  // 强化: 每次被检索命中, access_count 的对数增益系数
  reinforceK: 0.3,
  // 从向量库一次拉多少条进来做重排
  candidatePool: 30,
  // 最终注入 context 的记忆条数
  topK: 7,
  // 低于这个重要性的提取结果直接丢弃
  minImportance: 3,

  // ---- M1 关系-情感状态机 ----
  state: {
    // 各字段随时间向基线回落的半衰期 (小时)。心情是瞬时的, 关系是黏着的。
    // null = 不随时间衰减 (只被事件改变), 如亲密度/信任/未偿的和好债。
    halfLifeHours: {
      valence: 6, // 心情正负向: 几小时就平复
      arousal: 4, // 唤起度: 更快回落到基线
      tension: 48, // 积怨/紧张: 缓和得慢 (~2 天)
      closeness: null, // 亲密度: 只被事件改变
      trust: null, // 信任: 只被事件改变
      repair_debt: null, // 和好债: 只有真正和好才清零, 不会自己消失
    },
    // 各字段的基线 (无事发生时回落到这里)
    baseline: {
      valence: 0,
      arousal: 0.3,
      closeness: 0.5,
      tension: 0,
      repair_debt: 0,
      trust: 0.5,
    },
    // 单轮对话对任一字段的最大推动 (防一句话把状态推爆, 启发式与 LLM 增量都受此约束)
    maxStepPerTurn: 0.3,
  },

  // ---- M2 自研激活引擎 + 心情门控检索 ----
  engine: {
    forgetRate: 0.5, // ACT-R base-level 衰减指数 d: 越大越快忘 (新近/频次)
    wCtx: 1.0, // 语境相似权重
    wMood: 0.6, // ③ 心情门控权重。=0 时退化为标准激活 (与旧路径一致)
    wMile: 0.4, // 关系里程碑常驻权重 (dyad/承诺/关系类记忆)
    wSpread: 0.3, // 联想扩散权重 (沿相似图从命中点扩散)
    temporalPenalty: 0.2, // 过期情节降权系数 (降权不归零)
    temporalHalfLifeDays: 30, // 情节"过期"的时间尺度
    graphHops: 2, // 扩散跳数
    graphDecay: 0.5, // 每跳衰减
    graphK: 6, // 相似图里每个节点连几个近邻
    graphThreshold: 0.6, // 建边的最低余弦相似度
  },

  // ---- M3 重构性记忆 (项目灵魂; 红线: 永不动 fact_core) ----
  reconsolidation: {
    factCoreLocked: true, // 硬开关; 实际保护在 ontology.applyAffectUpdate / assertFactCorePreserved
    onRecallRate: 0.05, // 每次 recall 命中时的轻量靠拢步长 (想起时悄悄被当下情绪染色)
    nightlyRate: 0.12, // 反思时的较大靠拢步长 (和好后批量软化旧怨)
    affectClamp: 0.15, // 任何单次重构的最大漂移 (硬上限, 防失真累积)
    significantMoodDelta: 0.4, // 情绪变化超过它才值得让 LLM 重写 narrative
  },

  // ---- M4 共同记忆 / persona / 关系叙事 ----
  relationship_memory: {
    alwaysIncludeDyad: 1, // recall 时无条件带几条最重要的"我们共同记忆"作关系底色 (0=关)
    personaTopK: 6, // persona 注入时最多带几条 self 设定
    narrativeLookback: 30, // 合成"我们的故事"时回看多少条 dyad/关系记忆
  },

  // ---- M5 预期记忆 (面向未来) ----
  prospective: {
    cueThreshold: 0.8, // cue 型: 语境相似度高于它才触发
    graceHours: 48, // time 型: 过期 graceHours 仍没被提起就降级 (不再打扰)
    defaultHour: 20, // 只给了"明天"没给具体时刻时, 默认排在当天 20:00 (晚上闲聊时段)
  },
};
