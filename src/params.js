// 整套系统的"性格"参数都在这里调。
// config/params.json 可由本地控制台写入少量覆盖项；缺失或损坏时安全退回默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PARAMS = {
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

  // 数据不足，forgetRate/importance 权重暂沿用默认；由 F3 脚本在 r² 达标后给出替换建议。
  trace: {
    enabled: true,
    dailyBudgetUsd: 2,
    pricing: {
      default: { inputPerMillion: 0.14, outputPerMillion: 0.28 },
      'deepseek-chat': { inputPerMillion: 0.14, outputPerMillion: 0.28 },
    },
  },
  retrieval: {
    hybrid: true,  // R2: activation-hybrid MRR=1.00 p95=3429ms, 2026-07-28
    rrfK: 60,
    reranker: 'activation',
    evidenceBudget: {
      maxChars: 2200,
      maxItems: 7,
    },
    llm: {
      maxCandidates: 20,
      maxTokens: 400,
      heuristicWeight: 0.35,
      llmWeight: 0.65,
    },
  },
  ablation: {
    monologue: false,      // E3 2026-07-28: Δ -0.51, 有害删除
    moodGating: true,
    reconsolidation: true,
    behaviorPolicy: false, // E3 2026-07-28: Δ -0.51, 有害删除
    narration: true,       // 兼容旧配置；新实验使用下面两个独立 flag
    narrationPrompt: true,
    narrationClassifier: true,
    story: true,
    desire: true,
    evidenceBudget: true,
    utilityDecision: true,
  },

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
    // L2 非对称衰减：大负向 valence 回落更慢
    asymmetricDecay: {
      enabled: true,
      negativeThreshold: 0.35, // |baseline-value| 超过才加长半衰期
      negativeHalfLifeFactor: 1.75,
    },
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
    // E1 标签惯性 / 残留
    residue: {
      maxStickyTurns: 8,
      minHoldIntensity: 0.22,
      intensityHalfLifeHours: 3,
    },
    // E4 触景生情（默认只扰动本轮展示，不写库）
    resonate: {
      enabled: true,
      minIntensity: 0.45,
      maxAbsDelta: 0.12,
      contrastGain: 0.25,
      warmthCoupling: 0.15,
    },
    // L1 residual → desire
    desireBridge: {
      enabled: true,
      minIntensity: 0.4,
      scale: 0.22,
      comfortFactor: 1,
      securityFactor: 0.7,
      angrySecurityFactor: 0.9,
      angryAttentionFactor: 0.5,
      jealousSecurityFactor: 0.6,
    },
    // L3 journal prompt
    journal: {
      enabled: true,
      promptLimit: 2,
    },
    // L5 story → residual
    storySeed: {
      enabled: true,
      negativeMoodLink: -0.3,
      positiveMoodLink: 0.4,
      seedIntensity: 0.42,
    },
    // P3 residual → 主动冷却
    proactiveResidual: {
      enabled: true,
      minIntensity: 0.45,
      hurtFactor: 0.75,
      angryIntensity: 0.6,
      angryFactor: 1.15,
    },
  },

  // ---- D1 需求驱力 ----
  desire: {
    halfLifeHours: { attention: 24, sharing: 36, comfort: 48, security: 72 },
    growthPerHour: { attention: 0.012, sharing: 0.008, comfort: 0.006, security: 0.004 },
    promptThreshold: 0.55,
    thoughtfulMinChars: 12,
    thoughtfulAttentionRelief: 0.55,
    replyAttentionRelief: 0.22,
    thoughtfulSharingRelief: 0.35,
    careComfortRelief: 0.6,
    reassuranceSecurityRelief: 0.6,
    dismissiveAttentionGain: 0.08,
    dismissiveSecurityGain: 0.06,
  },

  // ---- I 线 亲密/性爱 (docs/intimacy-design.md) ----
  intimacy: {
    enabled: true,
    halfLifeHours: {
      arousal: 3,
      engagement: 2,
      aftercare_need: 6,
      sexual_tension: 72,
      sexual_openness: null,
      satisfaction: null,
    },
    growthPerHour: { sexual_tension: 0.006 },
    // 默认中等欲望；高欲望角色用 companions/*/intimacy.json 的 drive.libido 覆盖
    libido: 0.5,
    satisfactionDecayPerHour: 0,
    satisfactionFloor: 0.25,
    // 开放度达到该值后，沉默期间也会累积性张力（同居/恋人角色默认能攒）
    tensionAccumulateMinOpenness: 0.45,
    maxStepPerTurn: 0.35,
    promptThreshold: {
      arousal: 0.45,
      aftercare_need: 0.4,
      sexual_tension: 0.55,
      satisfactionLow: 0.35,
    },
    gates: {
      minCloseness: 0.55,
      minTrust: 0.45,
      minOpennessForPeak: 0.4,
      maxTensionForIntimate: 0.7,
      maxRepairDebtForIntimate: 0.55,
      minEnergy: 0.25,
      requireConsentForPeak: true,
    },
    feedback: {
      goodPeak: { closeness: 0.02, trust: 0.01, valence: 0.08 },
      goodAftercare: { closeness: 0.03, valence: 0.05 },
      stopOrBad: { valence: -0.06, tension: 0.05 },
    },
    proactive: {
      enabled: true,
      highTensionThreshold: 0.65,
      // 达到该张力：允许主动发起亲密（仍受关系/身体门控）
      initiateThreshold: 0.78,
      lowSatisfactionThreshold: 0.35,
      minCooldownFactor: 0.45,
    },
    // romantic/intimate 场景 recall 时对 preference 记忆的额外权重（I4）
    preferenceRecallBoost: 0.15,
    // 姐系亲密风格：懂暗示、偏主动带节奏（人设可关）
    style: {
      sisterLead: true,
    },
    bodyFocus: { enabled: false },
  },

  // ---- B2 情绪行为策略 ----
  behavior: {
    maxReplyDelayMs: 10 * 60 * 1000,
    // 试聊/本地 UI 首条延迟上限（ms），避免等太久；Telegram 用更高 cap
    uiDeliveryCapMs: 5000,
    channelDeliveryCapMs: 60000,
    stonewallPerDay: 1,
    stonewallTensionThreshold: 0.85,
    stonewallRepairDebtThreshold: 0.65,
    repairedDebtThreshold: 0.05,
    repairedTensionThreshold: 0.1,
    repairedMaxDelayMs: 1500,
    policies: {
      // partsBudget = 台词气泡条数上限；默认 ≥2 鼓励微信式连发
      平静: { replyDelayMs: [200, 900], partsBudget: 3, lengthHint: 'normal', proactiveBias: 0 },
      开心: { replyDelayMs: [0, 500], partsBudget: 4, lengthHint: 'chatty', proactiveBias: 0.2 },
      委屈: { replyDelayMs: [1000, 15000], partsBudget: 2, lengthHint: 'terse', proactiveBias: -0.1 },
      吃醋: { replyDelayMs: [500, 6000], partsBudget: 2, lengthHint: 'terse', proactiveBias: 0.05 },
      生气: { replyDelayMs: [30000, 600000], partsBudget: 2, lengthHint: 'terse', proactiveBias: -0.35 },
      失落: { replyDelayMs: [3000, 20000], partsBudget: 2, lengthHint: 'terse', proactiveBias: -0.15 },
      撒娇: { replyDelayMs: [0, 800], partsBudget: 3, lengthHint: 'chatty', proactiveBias: 0.15 },
      心疼: { replyDelayMs: [0, 800], partsBudget: 3, lengthHint: 'normal', proactiveBias: 0.2 },
    },
  },

  // ---- S2 连续生活叙事 ----
  story: {
    beatsPerDay: 1,
    maxActiveLines: 2,
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
    // 正常人大约一年感冒 1～2 次：日概率 ≈ 1.5/365 ≈ 0.4%/天（健康体质，不是体弱）
    baseDailySickProb: 0.004,
    sleepDeprivationHours: 28, // 很久不睡才算熬夜抬风险（原 20 太松）
    staleupMultiplier: 1.6, // 熬夜只略抬，不至于「熬两次就病」
    sickDurationHours: 24, // 一次普通感冒量级
    sickDurationJitterHours: 8,
    onsetHealthDrop: 0.2,
    onsetValenceDrop: 0.15,
    onsetArousalDrop: 0.1,
    careRecoverHours: 12, // 被好好照顾时明显加快好
    careHealthGain: 0.2,
    careValenceGain: 0.2,
    careClosenessGain: 0.06,
    careTrustGain: 0.04,
    // 连续很多天深夜还在聊才略抬概率
    lateNightStreakForDouble: 7,
    lateNightStreakMultiplier: 1.4,
    recoveryCooldownHours: 168, // 病好后 7 天冷却，一年不会连病
  },

  // ---- O 线 穿搭 (当前穿着 + 衣橱 + 随场景切换) ----
  outfit: {
    enabled: true,
    minHoursBeforeSwitch: 0.5, // 情境变了至少过多久才自动换
    maxHoursSameOutfit: 16, // 同一套最多穿多久（跨情境时）
    // 每日从衣橱+抽屉自动组合，并可生成「今日成片」
    dailyLook: {
      enabled: true,
      autoCompose: true, // 跨日自动 compose
      autoPhoto: true, // 后台生成 lookbook 进相册
      shareInChat: true, // 冷却允许时当作照片分享
      rotateAccessories: true, // 包/鞋等从抽屉轮换
      timezoneOffsetMinutes: 480, // 默认东八区日界
    },
  },

  // ---- A1 外貌/自拍 (appearance-life-design.md 第二部分; 出图为仓库外基建, 这里只搭骨架) ----
  appearance: {
    minClosenessForSelfie: 0.6, // 关系到这个亲密度才会"主动"发自拍 (被明确要求则放行)
    minClosenessForScene: 0.4, // 随手拍(风景/猫狗) 门槛更低 —— 分享见闻不需要多亲密
    selfie: {
      minIntervalMinutes: 720, // 自拍冷却比闲聊更克制 (12h)
      maxPerDay: 2, // 每天最多主动发几张
    },
    // 出图提示词套件（脸锁 / 人妻感 / 全身鞋履）
    prompt: {
      appendNegativeInPrompt: true,
      forceFullBodyLookbook: true,
      forceShoes: true,
      matureAura: true,
    },
  },

  // ---- 编排器 ----
  orchestrator: {
    // persona 段缓存多久后在下一次 init() 时重新加载。长期运行的实例 (如 ProactiveScheduler
    // 反复调用同一个 Orchestrator) 需要这个值让"自我认知"反思等 self 记忆更新能体现到 prompt 里。
    personaRefreshMs: 30 * 60 * 1000, // 30 分钟
    // 内心独白 (think()) 本来只要"一两句话", 之前没封顶, 模型话痨起来会白白拉长回复延迟
    // (独白是串行 await 的, 生成得越久, 用户等得越久)。
    monologueMaxTokens: 120,
    // 默认短期历史轮数（可被 turnPlan 按场景调高/调低）
    historyTurnsDefault: 6,
    // 寒暄/极短句跳过内心独白，降低首包延迟
    skipMonologueOnShort: true,
    // 生成后按 behavior.partsBudget 截断 dialogue parts
    enforcePartsBudget: true,
    // 跳戏重试失败后，仍尝试从 dialogue 里抠掉库存结尾
    stripStockEndings: true,
    // 硬后处理：压网文腔旁白/姓名开场/复读收尾（humanizeReply.js）
    humanizeReply: true,
    // 超短用户句时瘦身 world/story 段，减 prompt 体积
    compactShortTurns: true,
    // 结构化两阶段计划（启发式 + 可选便宜模型 enrich）
    structuredPlanLlm: true,
    // 生成后一致性检改：默认开启（坏回复最多再生成一次）
    coherenceRetry: true,
    // 关系周记 / 用户画像常驻槽
    residentSlots: true,
    // 本场会话线（主话题 / 开放问题 / 约定）
    sessionThread: true,
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
    desire: {
      triggerThreshold: 0.45,
      highThreshold: 0.8,
      minCooldownFactor: 0.35,
    },
  },

  // ---- M5 扛量 · 持久化任务队列 (src/queue/jobs.js) ----
  queue: {
    maxAttempts: 5, // 一个 job 最多重试几次, 超了进 failed
    baseBackoffMs: 1000, // 重试退避基数 (指数: base * 2^attempts)
    maxBackoffMs: 5 * 60 * 1000, // 退避上限 5min
    batchSize: 10, // 一次 tick 最多 claim 几个 job
    handlerTimeoutMs: 60 * 1000, // 单个 job 执行上限; 卡死的 handler (如 LLM 调用挂起) 不能冻结整个 worker
  },

  // ---- M9 每日训练: 知识滴灌 + 自我日记 (src/training.js) ----
  // 没有模型微调; "训练"落地为夜间维护时往 self 记忆里多补一点新内容,
  // 让她随时间慢慢"展开" —— 而不是开局就把所有设定一次性灌完。
  training: {
    knowledgePerDay: 1, // 角色知识库里每晚最多滴灌几条新的 self 事实
  },

  // ---- TTS 语音回复 (src/modal/speech.js): 对方发语音且配置了 TTS_MODEL 时才开口 ----
  tts: {
    maxSpeakChars: 120, // 台词总长超过它就不合成 (长回复念出来很怪), 回退纯文字
  },

  // ---- K1 结构化知识图谱 (src/knowledge/, 表见 sql/knowledge-graph.sql) ----
  // 与 engine/graph.js 的临时相似图分工: 相似图管联想扩散, 本图持久化可解释的
  // "实体 —关系→ 实体" 客观事实 (小王在腾讯上班 / 妈妈住在武汉)。
  knowledge: {
    enabled: true, // observe 抽取实体关系 + recall 多跳召回; 关掉则零额外 LLM/DB 调用
    entryTopK: 3, // 入口实体召回条数 (match_knowledge_entities)
    entryMinSimilarity: 0.35, // 入口实体最低相似度, 低于它视为"这句话跟图谱无关", 不注入
    maxHops: 2, // 有界多跳展开跳数
    maxFacts: 8, // 注入 prompt 的关系事实上限
    minConfidence: 0.45, // 低于该置信度的关系不参与注入
  },
};

function readOverrides() {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const file = path.join(root, 'config', 'params.json');
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeParams(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in base)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeParams(base[key], value);
    } else if (typeof value === typeof base[key] || (value === null && base[key] === null)) {
      out[key] = value;
    }
  }
  return out;
}

export const PARAMS = mergeParams(DEFAULT_PARAMS, readOverrides());
