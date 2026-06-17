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
    // 状态变化的总幅度超过它才往历史表追加一条快照 (避免把每次微小回落都记下来)
    snapshotMinDelta: 0.08,
    // #5 情绪指向性: tension 衰减回这个值以下时, 视为"这桩紧张消了", 清空 tension_target/tension_topic。
    tensionTargetClearBelow: 0.08,
  },

  // ---- 情绪 → 记忆重要性 (emotion-design.md §8) ----
  // 本轮心情位移 (|Δvalence|+|Δarousal|) 越大, 说明发生的事越"要紧",
  // 给这一轮提取出的记忆 importance 一点加成, 让"情绪强的事记得更牢"。
  moodShiftImportanceBoost: {
    threshold: 0.15, // 位移超过它才算"有事发生" (单字段 maxStepPerTurn 的一半)
    maxShift: 0.6, // 位移达到/超过它给满额加成 (= 2 * maxStepPerTurn, 两个字段都拉满)
    maxBoost: 2, // 满额时 importance (1-10 量表) 最多加多少
  },

  // ---- Emotion · 短时情绪展示层 (编排器 toPrompt/samplingHints) ----
  // valence/energy 直接来自 M1 affective_state.mood (来源/衰减/更新见 state.* 参数);
  // warmth 在亲密度基线 (relationship.closeness) 上叠加当下心情/紧张的短时调整。
  emotion: {
    warmthValenceWeight: 0.3, // 心情好时, 在亲密度基线上额外加多少"温度"
    warmthTensionWeight: 0.4, // 紧张时, 从亲密度基线扣多少"温度"
    warmthRepairDebtWeight: 0.3, // 还欠着没和好时, 额外扣多少"温度"
    // #5 情绪指向性: tension 指向"外部话题"(为考试焦虑) 而非"用户"时, 只用这个比例的力度拉冷对你的温度。
    // = 1 时退化为旧行为(不区分指向); 越小越体现"她为别的事烦, 但对你还是温柔的"。
    externalTensionWarmthFactor: 0.25,
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
    // #5 定向心情门控: 她负面情绪指向某外部话题时, 负面记忆的点亮乘上"与话题的语义相关度"。
    tensionGateMin: 0.4, // tension 高于它才启用定向门控 (低紧张不值得专门定向)
    directedGateFloor: 0.2, // 与话题完全不相关的负面记忆仍保留这个比例的点亮 (不彻底归零)
  },

  // ---- M3 重构性记忆 (项目灵魂; 红线: 永不动 fact_core) ----
  reconsolidation: {
    factCoreLocked: true, // 硬开关; 实际保护在 ontology.applyAffectUpdate / assertFactCorePreserved
    onRecallRate: 0.05, // 每次 recall 命中时的轻量靠拢步长 (想起时悄悄被当下情绪染色)
    nightlyRate: 0.12, // 反思时的较大靠拢步长 (和好后批量软化旧怨)
    affectClamp: 0.15, // 任何单次重构的最大漂移 (硬上限, 防失真累积)
    significantMoodDelta: 0.4, // 情绪变化超过它才值得让 LLM 重写 narrative
    // 原始情感锚回弹 (feature/affect-origin-anchor):
    originPull: 0.25, // 每次靠拢当下心情时, 目标被原始锚往回拉的比例 (0=不拉, 1=锁死在原始)
    maxDriftFromOrigin: 0.4, // 情感离诞生时的硬上限 —— 反复 recall 也洗不出这个范围
  },

  // ---- M4 共同记忆 / persona / 关系叙事 ----
  relationship_memory: {
    alwaysIncludeDyad: 3, // recall 时无条件带几条最重要的"我们共同记忆"作关系底色 (0=关; 调高让同居/关系地基更稳地每轮在场)
    personaTopK: 6, // persona 注入时最多带几条 self 设定
    narrativeLookback: 30, // 合成"我们的故事"时回看多少条 dyad/关系记忆
  },

  // ---- M5 预期记忆 (面向未来) ----
  prospective: {
    cueThreshold: 0.8, // cue 型: 语境相似度高于它才触发
    graceHours: 48, // time 型: 过期 graceHours 仍没被提起就降级 (不再打扰)
    defaultHour: 20, // 只给了"明天"没给具体时刻时, 默认排在当天 20:00 (晚上闲聊时段)
  },

  // ---- P1 不确定性表达 (confidence) ----
  // 召回结果不该都是"我记得 XXX"的确定口吻: 相关度低、很久没被想起/强化,
  // 或与同批召回的另一条记忆同话题但情绪截然相反 (冲突), 都该说"我记得好像..."。
  confidence: {
    weights: {
      similarity: 0.5, // 与当前 query 的相关度
      strength: 0.5, // recency/强化 (decay.recencyScore), 缺数据按 1 (不主动判定不确定)
    },
    conflictPenalty: 0.4, // 命中冲突时从加权和里扣掉这么多
    lowThreshold: 0.45, // 低于它 → "我记得好像..."
    conflict: {
      similarityThreshold: 0.85, // 判定"同一话题": embedding 余弦相似度门槛 (低于去重的 0.96)
      valenceGap: 0.5, // affect_valence 至少差这么多且符号相反才算"立场冲突"
    },
  },

  // ---- 主动遗忘 (forget-by-request) ----
  // "忘记我刚才说的那件事" 这类显式请求: 按 query 向量召回候选, 相似度达到这个门槛
  // 才认为"就是在说这件事", 纳入删除范围 (低于矛盾判断的 0.82, 因为口语化复述与
  // 当时存入的 fact_core 措辞往往差得更多)。
  forget: {
    similarityThreshold: 0.75,
  },

  // ---- M6 媒体向量闭环 (图搜图) ----
  modal: {
    mediaTopK: 5, // recallMedia 默认返回几条最相似的图/视频
  },

  // ---- M7 近义去重 (embedding 近邻判重) ----
  // dedup_hash 只挡"规范化后完全相同"的重复; 这里再加一层向量近邻判重, 把
  // "讨厌香菜"/"不爱吃香菜"这类同义不同写法也认成同一条 (强化旧记忆而非新增)。
  // 阈值要明显高于矛盾判断的相似度门槛 —— 同话题但立场相反 (讨厌/喜欢) 通常达不到这么高。
  dedup: {
    nearDuplicateThreshold: 0.96,
  },

  // ---- L4 健康/生病 (appearance-life-design.md 第三部分 §5) ----
  // 生病是强情感钩子: 低频自动发病(熬夜抬概率), 表现成行为(虚弱/话少/想被照顾),
  // 你的关心能加速恢复并加关系分, 整段经历进 dyad 共同记忆。
  health: {
    baseDailySickProb: 0.02, // 基础日发病概率(很低, 偶尔病)
    sleepDeprivationHours: 20, // 距上次睡觉超过它视为熬夜
    staleupMultiplier: 3, // 熬夜时发病概率的倍率
    sickDurationHours: 36, // 一次病程基准时长
    sickDurationJitterHours: 12, // 病程随机抖动(±)
    onsetHealthDrop: 0.4, // 发病瞬间 health 的下跌
    onsetValenceDrop: 0.25, // 发病带来的心情下跌(耦合进 affect)
    onsetArousalDrop: 0.15, // 发病带来的唤起下降(蔫)
    careRecoverHours: 8, // 一次"被关心"提前多少病程
    careHealthGain: 0.15, // 一次"被关心" health 的回升
    careValenceGain: 0.2, // 被照顾的暖意(耦合进 affect)
    careClosenessGain: 0.06, // 被照顾拉近的亲密
    careTrustGain: 0.04, // 被照顾增加的信任
    // P2 身体专属参数: 连续"熬夜"(对话发生在角色专属睡眠时段内)达到这个天数后, 发病概率翻倍。
    lateNightStreakForDouble: 3,
    lateNightStreakMultiplier: 2,
  },

  // ---- A1 外貌/自拍 (appearance-life-design.md 第二部分; 出图为仓库外基建, 这里只搭骨架) ----
  appearance: {
    minClosenessForSelfie: 0.6, // 关系到这个亲密度才会"主动"发自拍 (被明确要求则放行)
    minClosenessForScene: 0.4, // 随手拍(风景/猫狗) 门槛更低 —— 分享见闻不需要多亲密
    selfie: {
      minIntervalMinutes: 720, // 自拍冷却比闲聊更克制 (12h)
      maxPerDay: 2, // 每天最多主动发几张
    },
  },

  // ---- 编排器 ----
  orchestrator: {
    // persona 段缓存多久后在下一次 init() 时重新加载。长期运行的实例 (如 ProactiveScheduler
    // 反复调用同一个 Orchestrator) 需要这个值让"自我认知"反思等 self 记忆更新能体现到 prompt 里。
    personaRefreshMs: 30 * 60 * 1000, // 30 分钟
  },

  // ---- P1 双向关系触发规则 ----
  // 这些信号在 inferHeuristicDeltas 里检测, 与吵架/和好/温情同批叠加(同样受 maxStepPerTurn 限幅)。
  relationship_triggers: {
    // 叫她老婆/媳妇/亲爱的等亲密称呼 → 她很受用, 心情转暖 + 亲密微升
    petName: { valence: 0.08, closeness: 0.05 },
    // 整条消息只是"随便/哦/嗯"这类敷衍 → 她觉得被打发, 心情转冷 + 紧张微升
    dismissive: { valence: -0.12, tension: 0.08 },
    // 在钱上跟她生分客气(AA/自己付/还钱) → 她不高兴, 心情转冷 + 紧张微升
    moneyFormality: { valence: -0.05, tension: 0.1 },
  },

  // ---- P1 分级主动性调度器 ----
  // ProactiveScheduler 按"对方上次说话距今多久"分级选语气/理由; 越久越直接/越情绪化。
  proactive: {
    silenceTiers: {
      excuseFromHours: 2, // 2-4h: 找个不经意的小理由聊两句, 不直说想念
      directFromHours: 4, // 4-6h: 直接问"在干嘛", 带点惦记
      missFromHours: 6, // >6h: 简短/带点小情绪, 可能只叫一下名字
    },
    // 睡前: 提前多少分钟想跟对方说晚安
    bedtimeLeadMinutes: 60,
  },

  // ---- M5 扛量 · 持久化任务队列 (src/queue/jobs.js) ----
  queue: {
    maxAttempts: 5, // 一个 job 最多重试几次, 超了进 failed
    baseBackoffMs: 1000, // 重试退避基数 (指数: base * 2^attempts)
    maxBackoffMs: 5 * 60 * 1000, // 退避上限 5min
    batchSize: 10, // 一次 tick 最多 claim 几个 job
  },

  // ---- M9 每日训练: 知识滴灌 + 自我日记 (src/training.js) ----
  // 没有模型微调; "训练"落地为夜间维护时往 self 记忆里多补一点新内容,
  // 让她随时间慢慢"展开" —— 而不是开局就把所有设定一次性灌完。
  training: {
    knowledgePerDay: 1, // 角色知识库里每晚最多滴灌几条新的 self 事实
  },
};
