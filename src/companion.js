// 多角色 (multi-companion) · 人设配置。
//
// 同一 user 可拥有多个伴侣角色, 数据按 (userId, companionId) 隔离 (见 sql/schema.sql)。
// 这里只管"角色的定义"——名字/性格/说话风格/外貌/初始 self 记忆——两条并行的存取路径:
// - 文件: companions/<id>/ 目录式人设 (见 loadPersonaConfig), telegram/飞书/Discord bot 和控制台都走这条,
//   由调用方显式 loadPersonaConfig() 后传给 Orchestrator({ config })。
// - DB: companions 表 (见 upsertCompanion/getCompanion/listCompanions), Orchestrator 在没有显式传 config
//   时会 fallback 去查; 本仓库目前的入口都显式传了文件人设, 这条路径留给以后接入 DB 管理角色的场景。
// 角色的运行时记忆/状态仍走 memories / affective_state / life_state 等表, 按 companion_id 隔离。
//
// 校验用 zod (项目里第一个外部校验依赖; params.js 仍保持零依赖, 故 schema 单独放这里)。

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { supabase } from './config.js';

// ---- CompanionConfig schema ----

// seedFacts 既可是纯字符串 ("可可爱吃甜的"), 也可是带元数据的对象 (透传给 persona.seedPersona)。
const SeedFactSchema = z.union([
  z.string().min(1),
  z.object({
    fact_core: z.string().min(1),
    importance: z.number().min(1).max(10).optional(),
    fact_locked: z.boolean().optional(),
  }),
]);

const FamilyMemberSchema = z.object({
  relation: z.string().default(''),
  name: z.string().default(''),
  nickname: z.string().default(''),
  occupation: z.string().default(''),
  location: z.string().default(''),
  notes: z.string().default(''),
}).passthrough();

export const CompanionProfileSchema = z.object({
  legalName: z.string().default(''),
  nicknames: z.array(z.string()).default([]),
  gender: z.string().default('女'),
  birthDate: z.string().default(''),
  birthPlace: z.string().default('武汉'),
  nationality: z.string().default('中国'),
  idCardNumber: z.string().default(''),
  passportNumber: z.string().default(''),
  family: z.array(FamilyMemberSchema).default([]),
  menstrual: z.object({
    enabled: z.boolean().default(false),
    lastPeriodStart: z.string().default(''),
    cycleLengthDays: z.number().int().min(18).max(60).default(28),
    periodLengthDays: z.number().int().min(2).max(14).default(5),
    remindersEnabled: z.boolean().default(false),
    notes: z.string().default(''),
  }).default({}),
}).passthrough();

export function normalizeCompanionProfile(input = {}) {
  return CompanionProfileSchema.parse(input);
}

export const CompanionConfigSchema = z.object({
  companionId: z.string().min(1).default('default'), // 隔离键, 默认 'default'
  name: z.string().min(1),                            // 她的名字 / 称呼 (= orchestrator companionName)
  personality: z.string().default(''),                // 总体人设描述
  traits: z.array(z.string()).default([]),            // 性格标签 ["温柔","爱撒娇"]
  speechStyle: z.string().default(''),                // 说话风格
  appearance: z.string().default(''),                 // 外貌描述 (注入 prompt, 不做图像生成)
  seedFacts: z.array(SeedFactSchema).default([]),      // 初始 self 记忆 (可选)
  knowledgeBank: z.array(SeedFactSchema).default([]),  // M9 每日训练知识库: 每晚按 PARAMS.training.knowledgePerDay 滴灌进 self 记忆
  // 用户角色的硬性身份事实(短句), 独立于 personality 大段散文单独高显著度注入, 不参与 self 记忆的
  // topK/重要性排序 —— 埋在长人设散文里的否定性事实容易被模型忽略, 见 buildIdentityConstraints (orchestrator.js)。
  identityConstraints: z.array(z.string().min(1)).default([]),
  // 关系起点标签 (如"恋人"/"同居"), 只在这个 (user, companion) 还没有任何 affective_state 记录时生效一次,
  // 见 src/state/affect.js resolveRelationshipBaseline / seedInitialStateIfNew。不认识的标签退回全局默认。
  relationshipStartStage: z.string().min(1).nullable().default(null),
  // 情绪基线: 目前只用 valence (mood 的初始正负向); 同样只在首次建档时生效一次。
  emotionBaseline: z.object({ valence: z.number().min(-1).max(1) }).nullable().default(null),
  // E3 人设气质：半衰期 / 敏感度 / 消气速度（可选）
  emotionProfile: z
    .object({
      baselineValence: z.number().min(-1).max(1).optional(),
      valenceHalfLifeHours: z.number().min(0.5).max(72).optional(),
      arousalHalfLifeHours: z.number().min(0.5).max(48).optional(),
      sensitivity: z.number().min(0).max(1).optional(),
      recoverBias: z.number().min(0.4).max(2).optional(),
    })
    .nullable()
    .default(null),
  // 旁白指令按场景覆盖 (romantic/tense/conflict/intimate/daily -> 指令文本)。
  // 角色专属的旁白写法 (含尺度/称呼) 属于人设, 不属于库代码; 缺省回退 src/narration.js 的通用默认。
  narrationDirectives: z.record(z.string(), z.string()).nullable().default(null),
  storyCast: z.array(z.object({ name: z.string().min(1), role: z.string().min(1), closeness: z.number().min(0).max(1).default(0.5) })).default([]),
  storylines: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), stage: z.enum(['setup','rising','climax','cooldown','closed']).default('setup'), mood_link: z.number().min(-1).max(1).default(0), last_beat: z.string().default(''), next_beat_hint: z.string().default('') })).default([]),
  profile: CompanionProfileSchema.default({}),
  // I 线人设: companions/<id>/intimacy.json
  intimacyEnabled: z.boolean().nullable().default(null),
  intimacyBaseline: z
    .object({
      sexual_openness: z.number().min(0).max(1).optional(),
      satisfaction: z.number().min(0).max(1).optional(),
      pace: z.enum(['slow', 'normal', 'eager']).optional(),
    })
    .nullable()
    .default(null),
  intimacyHardBoundaries: z.array(z.string().min(1)).default([]),
  intimacySoftPreferences: z.array(z.string().min(1)).default([]),
  intimacyStyleHints: z.array(z.string().min(1)).default([]),
  // 角色欲望/驱力：高 libido 姐姐会更快攒张力、更早主动
  intimacyDrive: z
    .object({
      libido: z.number().min(0).max(1).optional(),
      tensionGrowthPerHour: z.number().min(0).max(0.1).optional(),
      satisfactionDecayPerHour: z.number().min(0).max(0.05).optional(),
      satisfactionFloor: z.number().min(0).max(0.6).optional(),
      initiateThreshold: z.number().min(0.4).max(0.95).optional(),
      highTensionThreshold: z.number().min(0.3).max(0.95).optional(),
      promptTensionThreshold: z.number().min(0.2).max(0.9).optional(),
      sisterLead: z.boolean().optional(),
    })
    .nullable()
    .default(null),
  // 姿势/前戏/敏感点知识库（结构宽松，运行时 normalize）
  intimacyKnowledge: z
    .object({
      positions: z.array(z.any()).optional(),
      foreplay: z.array(z.any()).optional(),
      hotspots: z.array(z.any()).optional(),
      pacing: z.array(z.any()).optional(),
      switches: z.array(z.string()).optional(),
    })
    .nullable()
    .default(null),
  // O 线穿搭衣橱 + 包柜 + 妆台
  outfitWardrobe: z
    .object({
      style: z.string().optional(),
      defaults: z.record(z.string(), z.string()).optional(),
      wardrobe: z.array(z.any()).optional(),
      bags: z.array(z.any()).optional(),
      beauty: z.record(z.string(), z.any()).optional(),
      cosmetics: z.record(z.string(), z.any()).optional(),
      lingerie: z.array(z.any()).optional(),
      underwear: z.array(z.any()).optional(),
      shoes: z.array(z.any()).optional(),
      jewelry: z.array(z.any()).optional(),
      watches: z.array(z.any()).optional(),
      accessories: z.array(z.any()).optional(),
      outerwear: z.array(z.any()).optional(),
      travel: z.array(z.any()).optional(),
      seasonal: z.record(z.string(), z.string()).optional(),
    })
    .nullable()
    .default(null),
});

/** 校验/解析任意输入 -> 合法 CompanionConfig (缺字段补默认, 非法抛 ZodError)。 */
export function normalizeCompanionConfig(input = {}) {
  return CompanionConfigSchema.parse(input);
}

/** 安全版: 解析失败返回 { ok:false, error } 而不抛 (供 IO 容错)。 */
export function safeCompanionConfig(input = {}) {
  const r = CompanionConfigSchema.safeParse(input);
  return r.success ? { ok: true, config: r.data } : { ok: false, error: r.error };
}

/**
 * 把"富人设 JSON"(persona/appearance/life/runtime 那种, 见 companions/*.json) 映射成本系统的 CompanionConfig。
 *
 * 人设分两层, 不是一坨都无条件塞进每轮 prompt:
 * - 核心层 (personality/speechStyle): 只放"她是谁+怎么称呼你"这种任何一轮都用得上的东西,
 *   每轮无条件注入, 必须短。
 * - 检索层 (background/values/likes/dislikes): 这些是"背景故事/处世价值观/具体喜好"，跟当前
 *   这句话是否相关取决于聊什么, 不该无条件带满每轮——全部改走 seedFacts, 靠 topK 相关性检索
 *   按需浮现 (和 knowledgeBank 的 M9 滴灌是同一个思路)。之前 background 会同时进 personality
 *   散文和 seedFacts, 同一段内容有概率在一次 prompt 里出现两遍; values/likes/dislikes 则只进
 *   散文、完全不可检索、且每轮都在——这次一并改过来。
 * @returns { config, options } —— options 给 Orchestrator (useMonologue/historyTurns)
 */
export function personaJsonToConfig(json = {}) {
  const p = json.persona ?? {};
  const speechStyle = Array.isArray(p.speech) ? p.speech.join('；') : String(p.speech ?? '');
  const parts = [];
  if (p.personality) parts.push(p.personality);
  if (p.address_user) parts.push(`她平时称呼对方为「${p.address_user}」。`);
  const seedFacts = [];
  if (p.background) seedFacts.push({ fact_core: p.background, importance: 8 });
  if (p.values) seedFacts.push({ fact_core: p.values, importance: 7 });
  if (Array.isArray(p.likes)) {
    for (const item of p.likes) if (item) seedFacts.push({ fact_core: `她喜欢的事: ${item}`, importance: 5 });
  }
  if (Array.isArray(p.dislikes)) {
    for (const item of p.dislikes) if (item) seedFacts.push({ fact_core: `她不喜欢的事: ${item}`, importance: 5 });
  }

  let config = normalizeCompanionConfig({
    companionId: 'default',
    name: p.name ?? json.meta?.display_name ?? '她',
    personality: parts.join('\n'),
    speechStyle,
    appearance: json.appearance?.anchor_prompt ?? '',
    seedFacts,
    // M9 每日训练知识库: 顶层 knowledge 数组 (字符串或 {fact_core,...}), 每晚滴灌进 self 记忆。
    knowledgeBank: Array.isArray(json.knowledge) ? json.knowledge : [],
    identityConstraints: Array.isArray(p.identity_constraints) ? p.identity_constraints : [],
    relationshipStartStage: json.relationship?.start_stage ?? null,
    emotionBaseline: typeof json.emotion_baseline?.valence === 'number' ? { valence: json.emotion_baseline.valence } : null,
    emotionProfile:
      json.emotion_profile && typeof json.emotion_profile === 'object'
        ? {
            baselineValence: json.emotion_profile.baseline_valence ?? json.emotion_profile.baselineValence,
            valenceHalfLifeHours: json.emotion_profile.valence_half_life_hours ?? json.emotion_profile.valenceHalfLifeHours,
            arousalHalfLifeHours: json.emotion_profile.arousal_half_life_hours ?? json.emotion_profile.arousalHalfLifeHours,
            sensitivity: json.emotion_profile.sensitivity,
            recoverBias: json.emotion_profile.recover_bias ?? json.emotion_profile.recoverBias,
          }
        : null,
    // 旁白指令覆盖 (companions/<id>/narration.json 的 narration.directives): 只收字符串值
    narrationDirectives:
      json.narration?.directives && typeof json.narration.directives === 'object'
        ? Object.fromEntries(Object.entries(json.narration.directives).filter(([, v]) => typeof v === 'string' && v.trim()))
        : null,
    storyCast: Array.isArray(json.story?.cast) ? json.story.cast : [],
    storylines: Array.isArray(json.story?.lines) ? json.story.lines : [],
    profile: json.profile ?? {},
    intimacyEnabled: typeof json.intimacy?.enabled === 'boolean' ? json.intimacy.enabled : null,
    intimacyBaseline: json.intimacy?.baseline && typeof json.intimacy.baseline === 'object' ? json.intimacy.baseline : null,
    intimacyHardBoundaries: Array.isArray(json.intimacy?.hard_boundaries) ? json.intimacy.hard_boundaries : [],
    intimacySoftPreferences: Array.isArray(json.intimacy?.soft_preferences_seed) ? json.intimacy.soft_preferences_seed : [],
    intimacyStyleHints: Array.isArray(json.intimacy?.style_hints) ? json.intimacy.style_hints : [],
    intimacyDrive: json.intimacy?.drive && typeof json.intimacy.drive === 'object' ? json.intimacy.drive : null,
    intimacyKnowledge: json.intimacy?.knowledge && typeof json.intimacy.knowledge === 'object' ? json.intimacy.knowledge : null,
    outfitWardrobe: json.outfit && typeof json.outfit === 'object' ? json.outfit : null,
  });
  // 软偏好/风格并入 personality，让未进记忆库时也有底色；硬边界进 identity 高显著位
  if (config.intimacyStyleHints?.length) {
    config = normalizeCompanionConfig({
      ...config,
      personality: [config.personality, `【亲密风格】${config.intimacyStyleHints.join('；')}`].filter(Boolean).join('\n'),
    });
  }
  if (config.intimacySoftPreferences?.length) {
    const extraSeeds = config.intimacySoftPreferences.map((t) => ({ fact_core: t, importance: 6 }));
    config = normalizeCompanionConfig({
      ...config,
      seedFacts: [...(config.seedFacts ?? []), ...extraSeeds],
    });
  }
  if (config.intimacyHardBoundaries?.length) {
    config = normalizeCompanionConfig({
      ...config,
      seedFacts: [
        ...(config.seedFacts ?? []),
        ...config.intimacyHardBoundaries.map((t) => ({ fact_core: t, importance: 9, fact_locked: true })),
      ],
      identityConstraints: [...(config.identityConstraints ?? []), ...config.intimacyHardBoundaries.map((b) => `亲密边界：${b}`)],
    });
  }
  const options = {
    useMonologue: json.runtime?.use_monologue ?? true,
    historyTurns: json.runtime?.history_turns ?? 6,
  };
  // 角色专属作息 + 身体参数 (供 makeScheduleActivityFn / LifeDimension 的 lifeConfig); 没有则留 null 走通用默认。
  const life = json.life?.schedule_template || json.life?.sleep || json.life?.sick_probability != null
    ? { schedule: json.life.schedule_template ?? [], sleep: json.life.sleep ?? '', sick_probability: json.life.sick_probability }
    : null;
  return { config, options, life };
}

/**
 * 目录式人设的分片合并 (纯函数, 供单测)。
 * companions/<id>/ 下每个 .json 按功能各管一块 (persona/appearance/life/relationship/knowledge/runtime),
 * 顶层键合并规则: 数组相接、对象浅合并、标量后读覆盖 (文件按名字母序读取, 行为确定)。
 */
export function mergePersonaSections(sections = []) {
  const merged = {};
  for (const sec of sections) {
    if (!sec || typeof sec !== 'object' || Array.isArray(sec)) continue;
    for (const [key, value] of Object.entries(sec)) {
      const prev = merged[key];
      if (Array.isArray(prev) && Array.isArray(value)) merged[key] = [...prev, ...value];
      else if (
        prev && value &&
        typeof prev === 'object' && typeof value === 'object' &&
        !Array.isArray(prev) && !Array.isArray(value)
      ) merged[key] = { ...prev, ...value };
      else merged[key] = value;
    }
  }
  return merged;
}

function readPersonaDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
  const sections = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  return mergePersonaSections(sections);
}

/**
 * 从人设文件读富人设并映射成 { config, options, life }; 不存在返回 null (正常情况, 不报错)。
 * 支持两种格式:
 * - 单文件: companions/<id>.json (旧格式, 全部塞一个文件)
 * - 目录式: companions/<id>/ 按功能分文件 —— 目录存在时优先于同名单文件生效
 * 抛出 ZodError/JSON 解析错误, 供调用方决定处理方式 (loadPersonaConfig 会吞掉并打日志, 校验脚本会直接冒泡)。
 */
export function loadPersonaConfigOrThrow(filePath) {
  if (!filePath) return null;
  const dir = String(filePath).replace(/\.json$/i, '');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return personaJsonToConfig(readPersonaDir(dir));
  if (!fs.existsSync(filePath)) return null;
  if (fs.statSync(filePath).isDirectory()) return personaJsonToConfig(readPersonaDir(filePath));
  return personaJsonToConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/**
 * loadPersonaConfigOrThrow 的容错版: 文件不存在返回 null (正常); 文件存在但损坏/不合规也返回 null,
 * 但会打印清晰的错误日志——之前这里是静默 catch, 分片文件写错一个逗号人设会悄悄退化成空人设, 且没有任何提示。
 * 生产入口 (telegram/飞书/Discord bot、控制台) 用这个; 想在写人设时马上看到字段级报错用 loadPersonaConfigOrThrow
 * 或 `npm run companion:validate <id>`。
 */
export function loadPersonaConfig(filePath) {
  try {
    return loadPersonaConfigOrThrow(filePath);
  } catch (error) {
    console.error(`[companion] 人设文件加载失败 (${filePath}): ${error.message}`);
    return null;
  }
}

// ---- 行 <-> Config 映射 ----

/** companions 表行 -> CompanionConfig。name/appearance 取独立列, 其余从 config jsonb 展开。 */
export function rowToConfig(row) {
  if (!row) return null;
  return normalizeCompanionConfig({
    companionId: row.companion_id,
    name: row.name,
    appearance: row.appearance ?? '',
    ...(row.config ?? {}),
  });
}

/** CompanionConfig -> companions 表行。name/appearance 冗余成独立列, 其余收进 config jsonb。 */
export function configToRow(userId, config) {
  const c = normalizeCompanionConfig(config);
  return {
    user_id: userId,
    companion_id: c.companionId,
    name: c.name,
    appearance: c.appearance,
    config: {
      personality: c.personality,
      traits: c.traits,
      speechStyle: c.speechStyle,
      seedFacts: c.seedFacts,
      knowledgeBank: c.knowledgeBank,
      identityConstraints: c.identityConstraints,
      relationshipStartStage: c.relationshipStartStage,
      emotionBaseline: c.emotionBaseline,
      emotionProfile: c.emotionProfile,
      narrationDirectives: c.narrationDirectives,
      storyCast: c.storyCast,
      storylines: c.storylines,
      profile: c.profile,
      intimacyEnabled: c.intimacyEnabled,
      intimacyBaseline: c.intimacyBaseline,
      intimacyHardBoundaries: c.intimacyHardBoundaries,
      intimacySoftPreferences: c.intimacySoftPreferences,
      intimacyStyleHints: c.intimacyStyleHints,
      intimacyDrive: c.intimacyDrive,
      intimacyKnowledge: c.intimacyKnowledge,
      outfitWardrobe: c.outfitWardrobe,
    },
    updated_at: new Date().toISOString(),
  };
}

// ---- IO ----

/** 写入/更新一个角色的人设配置。 */
export async function upsertCompanion(userId, config) {
  const row = configToRow(userId, config);
  const { data, error } = await supabase
    .from('companions')
    .upsert(row, { onConflict: 'user_id,companion_id' })
    .select()
    .single();
  if (error) throw error;
  return rowToConfig(data);
}

/** 取单个角色的人设配置; 不存在返回 null。 */
export async function getCompanion(userId, companionId = 'default') {
  const { data, error } = await supabase
    .from('companions')
    .select('*')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .maybeSingle();
  if (error || !data) return null;
  return rowToConfig(data);
}

/** 列出一个用户的全部角色 (按创建时间升序)。 */
export async function listCompanions(userId) {
  const { data, error } = await supabase
    .from('companions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(rowToConfig);
}


