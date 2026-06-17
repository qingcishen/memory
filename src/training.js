// M9 · 每日训练: 知识滴灌 + 自我日记。
//
// 这套系统没有"模型微调"——人设/对话/情感的连续性全靠 self 记忆驱动 prompt。
// "训练"在这里落地为夜间维护多做两件事 (见 Orchestrator.maintain 的 nightly 分支):
//   1. 知识滴灌: 从角色配置的知识库 (CompanionConfig.knowledgeBank) 里, 每天往 self 记忆
//      多塞 PARAMS.training.knowledgePerDay 条 (兴趣/习惯/小经历), 让设定随时间慢慢
//      展开, 而不是开局一次性灌完——也让"她懂的越来越多"。
//   2. 自我日记: 用当下的人格/状态/关系 prompt 段, 让 LLM (think 模型) 写一句第一人称
//      的"今天"小记, 存成 self 记忆——之后被 recall 命中时, 强化"她有自己生活"的连续感。
//
// 纯逻辑 (挑选/拼 prompt) 与 IO (查重/落库/调 LLM) 分开。

import { supabase, PARAMS } from './config.js';
import { seedPersona } from './persona.js';

// ---- 纯逻辑 ----

/**
 * 从知识库里按原始顺序挑出还没灌过的, 最多取 limit 条。
 * 同一天重复跑 (或 seededFactCores 不变) 结果稳定——已灌过的 fact_core 会被跳过。
 * @param bank 字符串数组, 或 {fact_core,...} 对象数组 (与 seedPersona 的 facts 形态一致)
 * @param seededFactCores Set<string> 已写入 self 记忆的 fact_core
 */
export function pickDailyKnowledge(bank = [], seededFactCores = new Set(), limit = 1) {
  const out = [];
  for (const item of bank ?? []) {
    const fact = typeof item === 'string' ? item : item?.fact_core;
    if (!fact || seededFactCores.has(fact)) continue;
    out.push(typeof item === 'string' ? { fact_core: item } : item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 拼自我日记的 LLM 输入: 第一人称, 结合当下人格/状态/关系段, 1-2 句。
 * 各段为空时跳过, 全空时仍返回写日记的指令。
 */
export function buildDiaryPrompt({ personaPrompt = '', statePrompt = '', relationshipPrompt = '' } = {}) {
  const parts = [personaPrompt, statePrompt, relationshipPrompt].filter((s) => s && s.trim());
  parts.push('用第一人称写一句"今天"的内心小记(日记片段), 1-2 句, 口语化, 像随手冒出的念头, 不要写成总结报告, 不要加引号或标签。');
  return parts.join('\n\n');
}

// ---- IO ----

/** 她当前已有的 self 记忆 fact_core 集合 (供知识滴灌去重)。 */
export async function selfFactCores(userId, companionId = 'default') {
  const { data, error } = await supabase
    .from('memories')
    .select('fact_core')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .eq('subject_kind', 'self')
    .is('superseded_by', null);
  if (error) throw error;
  return new Set((data ?? []).map((m) => m.fact_core).filter(Boolean));
}

/**
 * 每日训练: 知识滴灌 (knowledgeBank 非空时) + 自我日记 (llm 提供时)。
 * @param opts { knowledgeBank, limit, llm, promptCtx } —— promptCtx 给 buildDiaryPrompt。
 * @returns { seeded: 新写入的知识记忆[], diary: string|null }
 */
export async function dailyTraining(userId, companionId = 'default', opts = {}) {
  const limit = opts.limit ?? PARAMS.training.knowledgePerDay;

  let seeded = [];
  if (Array.isArray(opts.knowledgeBank) && opts.knowledgeBank.length > 0 && limit > 0) {
    const existing = await selfFactCores(userId, companionId);
    const picked = pickDailyKnowledge(opts.knowledgeBank, existing, limit);
    if (picked.length > 0) seeded = await seedPersona(userId, companionId, picked);
  }

  let diary = null;
  if (opts.llm && typeof opts.llm.think === 'function') {
    const context = buildDiaryPrompt(opts.promptCtx ?? {});
    const text = await opts.llm.think(context).catch(() => '');
    const trimmed = String(text ?? '').trim();
    if (trimmed) {
      await seedPersona(userId, companionId, [{ fact_core: trimmed, type: 'episode', importance: 4 }]);
      diary = trimmed;
    }
  }

  return { seeded, diary };
}
