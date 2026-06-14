// 多角色 (multi-companion) · 人设配置。
//
// 同一 user 可拥有多个伴侣角色, 数据按 (userId, companionId) 隔离 (见 sql/schema.sql)。
// 这里只管"角色的定义"——名字/性格/说话风格/外貌/初始 self 记忆——存进 companions 表;
// 角色的运行时记忆/状态仍走 memories / affective_state / life_state 等表, 按 companion_id 隔离。
//
// 校验用 zod (项目里第一个外部校验依赖; params.js 仍保持零依赖, 故 schema 单独放这里)。

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

export const CompanionConfigSchema = z.object({
  companionId: z.string().min(1).default('default'), // 隔离键, 默认 'default'
  name: z.string().min(1),                            // 她的名字 / 称呼 (= orchestrator companionName)
  personality: z.string().default(''),                // 总体人设描述
  traits: z.array(z.string()).default([]),            // 性格标签 ["温柔","爱撒娇"]
  speechStyle: z.string().default(''),                // 说话风格
  appearance: z.string().default(''),                 // 外貌描述 (注入 prompt, 不做图像生成)
  seedFacts: z.array(SeedFactSchema).default([]),      // 初始 self 记忆 (可选)
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

// ---- 行 <-> Config 映射 ----

/** companions 表行 -> CompanionConfig。name/appearance 取独立列, 其余从 config jsonb 展开。 */
export function rowToConfig(row) {
  if (!row) return null;
  return normalizeCompanionConfig({
    companionId: row.companion_id,
    name: row.name,
    appearance: row.appearance ?? '',
    ...(row.config ?? {}), // personality / traits / speechStyle / seedFacts
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
