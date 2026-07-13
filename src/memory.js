import { extractMemories, applyMoodShiftBoost } from './extract.js';
import { storeMemories } from './store.js';
import {
  retrieveMemories,
  retrieveSupersededTrail,
  formatForPrompt,
  formatSupersededTrailForPrompt,
} from './retrieve.js';
import { runReflection, findForgettable, forgetByQuery, mergeNearDuplicates } from './reflect.js';
import { readState, updateFromTurn, decayToBaseline, moodLabel, moodShiftMagnitude, readStateHistory } from './state/affect.js';
import { engineRecall } from './engine/index.js';
import { reconsolidateOnRecall, reconsolidateRecent } from './memory/reconsolidate.js';
import { seedPersona, personaBlock } from './persona.js';
import { dyadBackdrop, synthesizeNarrative } from './narrative.js';
import { scheduleFromTurns, dueProspectives, markFired, ensureFirstChatAnniversary } from './memory/prospective.js';
import { ingestImage, ingestAudio, recallMedia } from './modal/index.js';
import { attachConfidence } from './confidence.js';
import { dailyTraining } from './training.js';
import { observeKnowledge, recallKnowledge } from './knowledge/index.js';
import { PARAMS } from './config.js';
import { updateUserProfile } from './profile.js';

/**
 * 记忆系统门面。一个用户一个 userId, 所有记忆按 (userId, companionId) 隔离。
 * companionId 默认 'default' —— 单角色用法零改动; 多角色时同一 userId 下不同 companionId 数据互不可见。
 *
 *   const mem = new Memory({ userId: 'u_123', companionId: '可可', subjectName: '诗雅' });
 *   await mem.observe(recentTurns);              // 对话后: 提取并存储
 *   const hits = await mem.recall(userMessage);  // 回复前: 检索相关记忆
 *   const block = mem.toPrompt(hits);            // 拼成注入串
 */
export class Memory {
  constructor({ userId, companionId = 'default', subjectName = '对方', companionName = '她' }) {
    if (!userId) throw new Error('Memory 需要 userId');
    this.userId = userId;
    this.companionId = companionId;
    this.subjectName = subjectName;
    this.companionName = companionName;
  }

  /**
   * 对话之后调用: 更新情绪/关系状态 (M1) + 提取记忆并落库 (含矛盾处理)。
   * 状态更新、记忆提取 (LLM)、预期记忆排程 (M5) 互不依赖, 并发执行并各自失败隔离;
   * 落库 (含矛盾处理) 依赖提取结果与心情位移加成, 留在并发之后。
   * @returns { state, stored } —— 本轮后的状态与新存的记忆
   */
  async observe(turns, opts = {}) {
    // L4 身心耦合: 先演变 life(生病/被照顾) 拿到对情绪/关系的耦合增量, 与本轮 affect 增量
    // 合并进【同一次】 updateFromTurn 写入, 避免 affect 被第二条写路径覆盖(见 docs 设计)。
    const life = opts.life ?? null;
    const coupling = life ? await life.evolve(turns).catch(() => null) : null;

    // I3: 先演变亲密状态（启发式），其关系/情绪反馈并入本轮 affect 写入。
    let intimacyResult = null;
    if (opts.intimacy && PARAMS.intimacy?.enabled !== false) {
      const relPreview = await readState(this.userId, this.companionId).catch(() => null);
      const lifeSnap = typeof life?.current === 'function' ? await life.current().catch(() => null) : null;
      intimacyResult = await opts.intimacy
        .evolve(turns, {
          relationship: relPreview?.relationship ?? relPreview,
          life: lifeSnap,
          sceneType: opts.sceneType ?? null,
        })
        .catch(() => null);
    }

    const intimacyAffect = intimacyResult?._meta?.affectDelta ?? null;
    const extraDeltas = mergeExtraDeltas(coupling ? couplingToDelta(coupling) : null, intimacyAffect, opts.extraDeltas);

    const extractOpts = {
      intimate: Boolean(
        opts.sceneType === 'intimate' ||
          ['foreplay', 'peak', 'aftercare', 'flirting'].includes(intimacyResult?.scene_phase)
      ),
    };

    const [{ before, after, desireDeltas }, extracted, scheduled, knowledge] = await Promise.all([
      updateFromTurn(this.userId, this.companionId, turns, { ...opts, extraDeltas }).catch(() => ({ before: null, after: null })),
      extractMemories(turns, this.subjectName, this.companionName, extractOpts).catch(() => []),
      // M5: 顺手识别"未来意图"("我明天面试") 并排一条预期记忆。
      opts.prospective === false ? null : scheduleFromTurns(this.userId, this.companionId, turns, opts.now, this.subjectName).catch(() => null),
      // K1: 抽取"实体—关系→实体"结构化事实进知识图谱 (失败隔离, 不拖垮主链路)。
      opts.knowledge === false
        ? null
        : observeKnowledge(this.userId, this.companionId, turns, { subjectName: this.subjectName, companionName: this.companionName }).catch(() => null),
    ]);
    // D2: 复用上面的同一次状态 LLM 推断，把需求增量交给 DesireDimension 合并落库。
    const desireExtra = intimacyResult?._meta?.desireDelta ?? null;
    if (opts.desire) {
      await opts.desire
        .evolve(turns, { deltas: mergeDesireDeltas(desireDeltas, desireExtra) })
        .catch(() => null);
    }
    // O 线: 对话触发换装 / 情境校正（失败隔离）
    let outfitResult = null;
    if (opts.outfit && PARAMS.outfit?.enabled !== false) {
      const lifeSnap = typeof life?.current === 'function' ? await life.current().catch(() => null) : null;
      outfitResult = await opts.outfit
        .evolve(turns, { life: lifeSnap, intimacy: intimacyResult })
        .catch(() => null);
    }
    // 情绪 → 记忆重要性 (emotion-design.md §8): 这一轮心情位移大, 说明发生了要紧的事。
    let boosted = before && after ? applyMoodShiftBoost(extracted, moodShiftMagnitude(before, after)) : extracted;
    // L4: 这次"生病被照顾"作为一条 dyad 共同记忆存下来(她会记得你照顾过她)。
    if (coupling?.careEvent) boosted = [...boosted, buildCareMemory(this.subjectName, coupling.careEvent)];
    // I4: 亲密轮次提高 preference 重要性下限敏感度（已在 extract 侧加权）
    const stored = boosted.length === 0 ? [] : await storeMemories(this.userId, this.companionId, boosted);
    return {
      state: after,
      desires: opts.desire ? await opts.desire.snapshot().catch(() => null) : null,
      intimacy: intimacyResult ? { ...intimacyResult, _meta: undefined } : opts.intimacy ? await opts.intimacy.snapshot().catch(() => null) : null,
      outfit: outfitResult ? { ...outfitResult, _meta: undefined } : opts.outfit ? await opts.outfit.snapshot().catch(() => null) : null,
      stored,
      scheduled,
      coupling,
      knowledge,
    };
  }

  /**
   * 回复之前调用: 按当前消息检索最相关的记忆 (并强化命中项)。
   * 默认走自研激活引擎 (M2): 读当前状态 → 心情门控 + 联想扩散 + ACT-R 激活。
   * 传 { engine: false } 退回旧的纯相似度+recency 重排路径 (双轨对照用)。
   */
  async recall(query, opts = {}) {
    let hits;
    if (opts.engine === false) {
      hits = await retrieveMemories(this.userId, this.companionId, query, opts);
    } else {
      const state = await readState(this.userId, this.companionId).catch(() => null);
      hits = await engineRecall(this.userId, this.companionId, query, state, opts);
      // M3: 想起即被当下情绪轻微染色 (落库异步, 返回染色后的值供本轮注入)。
      if (state && opts.reconsolidate !== false) hits = await reconsolidateOnRecall(hits, state);
      // M4: 无条件带上最重要的"我们共同记忆"作关系底色 (去重后补在末尾)。
      const n = opts.includeDyad ?? PARAMS.relationship_memory.alwaysIncludeDyad;
      if (n > 0) {
        const have = new Set(hits.map((m) => m.id));
        const backdrop = (await dyadBackdrop(this.userId, this.companionId, n).catch(() => [])).filter((m) => !have.has(m.id));
        hits = [...hits, ...backdrop];
      }
    }
    // I4: romantic/intimate 场景对 preference 记忆轻微提权（不改引擎打分公式，只做稳定重排加成）
    if (opts.intimateBoost || opts.sceneType === 'intimate' || opts.sceneType === 'romantic') {
      const boost = Number(PARAMS.intimacy?.preferenceRecallBoost) || 0;
      if (boost > 0) {
        hits = [...hits].sort((a, b) => {
          const ap = a.type === 'preference' || a.fact_locked ? boost : 0;
          const bp = b.type === 'preference' || b.fact_locked ? boost : 0;
          const as = (a._score ?? a.similarity ?? a.importance ?? 0) + ap;
          const bs = (b._score ?? b.similarity ?? b.importance ?? 0) + bp;
          return bs - as;
        });
      }
    }
    // P1 不确定性表达 (#4): 相关度低/很久没强化/同话题情绪冲突 → _lowConfidence,
    // toPrompt 据此把"我记得 XXX"换成"我记得好像 XXX"。
    return attachConfidence(hits);
  }

  /** 读她当前的心情 + 你俩关系状态 (M2 门控检索 / M3 重构会用) */
  async state() {
    return readState(this.userId, this.companionId);
  }

  /** 当前心情的可读标签 (开心 / 平静 / 低落 / 受伤·闹脾气) */
  async mood() {
    return moodLabel(await readState(this.userId, this.companionId));
  }

  /** 读关系状态的历史轨迹 (升序); 关系叙事与情感锚审计的依据。 */
  async stateHistory(opts = {}) {
    return readStateHistory(this.userId, this.companionId, opts);
  }

  /** 定时 (如每隔几小时) 调用: 心情随时间向基线回落, 没有对话也"消气" */
  async settle(now = Date.now()) {
    return decayToBaseline(this.userId, this.companionId, now);
  }

  /**
   * 批量重构 (M3): 按当前状态软化/回暖最近的旧记忆。
   * 典型在【和好后】或【夜间反思时】调一次。传 { useLLM:true } 还会重写显著变化记忆的 narrative。
   * 永不改 fact_core。
   */
  async reconsolidate(opts = {}) {
    const state = await readState(this.userId, this.companionId).catch(() => null);
    if (!state) return { count: 0 };
    return reconsolidateRecent(this.userId, this.companionId, state, opts);
  }

  /** 播种她的人格设定 (self 记忆); facts 可为字符串或 {fact_core,importance,...} 数组 */
  async seedPersona(facts) {
    return seedPersona(this.userId, this.companionId, facts);
  }

  /** B3: 记录她自己的短暂行为事件，不混入用户记忆，也不改写既有事实。 */
  async recordSelfEvent(content, opts = {}) {
    const text = String(content ?? '').trim();
    if (!text) return [];
    return storeMemories(this.userId, this.companionId, [{
      type: 'episode', fact_core: text, content: text, narrative: opts.narrative ?? text,
      subject_kind: 'self', importance: opts.importance ?? 4, affect_valence: opts.valence ?? -0.2, affect_intensity: opts.intensity ?? 0.5,
    }]);
  }

  /** 取她的人格注入块 (域隔离: 只含 self 设定, 不混 user 记忆) */
  async persona(opts = {}) {
    return personaBlock(this.userId, this.companionId, this.subjectName, opts);
  }

  /** 合成并存回"我们的故事" (关系叙事, 最高层 reflection)。和好后或定期调一次。 */
  async story(opts = {}) {
    const state = await readState(this.userId, this.companionId).catch(() => null);
    return synthesizeNarrative(this.userId, this.companionId, state, opts);
  }

  /**
   * 检查此刻该不该主动提起某件事 (M5 预期记忆)。回复层在生成前调一次。
   * 传 { query } 让 cue 型做语境匹配。返回 due 列表; 决定提起后用 dismissProspective 标记。
   */
  async checkProspective(ctx = {}, now = Date.now()) {
    return dueProspectives(this.userId, this.companionId, ctx, now);
  }

  /** 已经主动提起过的预期记忆: 标记 fired, 不再重复打扰。 */
  async dismissProspective(ids) {
    return markFired(ids);
  }
  async ensureAnniversaries(now = Date.now()) {
    return ensureFirstChatAnniversary(this.userId, this.companionId, now);
  }

  /** 她看到一张图 (M6): vision caption → image 记忆, 之后可被文本召回。缺凭证降级不崩。 */
  async seeImage(opts = {}) {
    return ingestImage(this.userId, this.companionId, opts);
  }

  /** 她听到一段语音 (M6): ASR 转写 + 语气进 affect → audio 记忆。缺凭证降级不崩。 */
  async hearVoice(opts = {}) {
    return ingestAudio(this.userId, this.companionId, opts);
  }

  /**
   * 图搜图 (#6 工程债 · 媒体向量闭环): 给一个查询图的向量 (调用方用 CLIP 等模型算好),
   * 在带 media_embedding 的记忆里找最相似的几条。本类不内置视觉 embedding 模型。
   */
  async recallMedia(queryEmbedding, opts = {}) {
    return recallMedia(this.userId, this.companionId, queryEmbedding, opts);
  }

  /** 把检索结果拼成可注入 system prompt 的自然语言 */
  toPrompt(mems) {
    return formatForPrompt(mems, this.subjectName);
  }

  /**
   * 检索 + 知识图谱召回一次拿全: { hits, knowledge, block }。
   * knowledge 是 K1 图谱的多跳事实块 (无命中/未建表/关掉开关都为空串, 安全降级);
   * block = 记忆块 + 知识块 拼好的最终注入串。
   */
  async recallDetailed(query, opts = {}) {
    const [hits, knowledge] = await Promise.all([
      this.recall(query, opts),
      opts.knowledge === false ? '' : recallKnowledge(this.userId, this.companionId, query),
    ]);
    const block = [this.toPrompt(hits), knowledge].filter(Boolean).join('\n\n');
    return { hits, knowledge, block };
  }

  /** 一步到位: 检索 (+ 知识图谱) + 直接给出可注入串 */
  async recallAsPrompt(query, opts = {}) {
    return (await this.recallDetailed(query, opts)).block;
  }

  /** 显式翻旧账: 返回与 query 相关的"旧版本 → 当前版本"变化轨迹。 */
  async recallHistory(query, opts = {}) {
    return retrieveSupersededTrail(this.userId, this.companionId, query, opts);
  }

  /** 一步到位: 翻旧账检索 + 拼成可注入 prompt 的变化轨迹。 */
  async recallHistoryAsPrompt(query, opts = {}) {
    const rows = await this.recallHistory(query, opts);
    return formatSupersededTrailForPrompt(rows, this.subjectName);
  }

  /** 定期 (如每晚) 调用: 反思总结 */
  async reflect(opts = {}) {
    return runReflection(this.userId, this.companionId, opts);
  }

  async updateUserProfile(opts = {}) {
    return updateUserProfile(this.userId, this.companionId, opts);
  }

  /** 维护期 (如每晚) 调用: 合并近义重复记忆 (收口并发 observe 漏过的"两条当前事实")。 */
  async dedupe(opts = {}) {
    return mergeNearDuplicates(this.userId, this.companionId, opts);
  }

  /** M9 每日训练 (如每晚) 调用: 知识滴灌 + 自我日记, 见 src/training.js。 */
  async train(opts = {}) {
    return dailyTraining(this.userId, this.companionId, opts);
  }

  /** 找出几乎被遗忘的记忆; 传 { purge: true } 可清理 */
  async forgettable(threshold = 0.05, opts = {}) {
    return findForgettable(this.userId, this.companionId, threshold, opts);
  }

  /**
   * 主动遗忘 (P2 工程债 #9): "忘记我刚才说的那件事" 这类显式请求。
   * 按 query 召回相关记忆, 相似度达到 PARAMS.forget.similarityThreshold 的直接删除。
   * fact_locked 的硬事实默认不删; 传 { includeLocked: true } 放开。
   * @returns 被删除的记忆列表 (可能为空)
   */
  async forget(query, opts = {}) {
    return forgetByQuery(this.userId, this.companionId, query, opts);
  }
}

// ---- L4 helpers ----

/** 把 LifeDimension.evolve 回传的耦合增量整成 updateFromTurn 认的 delta 形状。 */
function couplingToDelta(coupling) {
  const delta = {};
  if (coupling.moodDelta?.mood) delta.mood = coupling.moodDelta.mood;
  if (coupling.relationshipDelta?.relationship) delta.relationship = coupling.relationshipDelta.relationship;
  return delta;
}

/** 合并 life 耦合 / 亲密反馈 / 调用方 extra 的 affect 增量。 */
function mergeExtraDeltas(...parts) {
  const out = { mood: {}, relationship: {} };
  let any = false;
  for (const part of parts) {
    if (!part) continue;
    if (part.mood) {
      for (const [k, v] of Object.entries(part.mood)) {
        out.mood[k] = (out.mood[k] ?? 0) + Number(v || 0);
        any = true;
      }
    }
    if (part.relationship) {
      for (const [k, v] of Object.entries(part.relationship)) {
        out.relationship[k] = (out.relationship[k] ?? 0) + Number(v || 0);
        any = true;
      }
    }
  }
  if (!any) return parts.find(Boolean) ?? null;
  const delta = {};
  if (Object.keys(out.mood).length) delta.mood = out.mood;
  if (Object.keys(out.relationship).length) delta.relationship = out.relationship;
  return Object.keys(delta).length ? delta : null;
}

function mergeDesireDeltas(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = {};
  for (const k of keys) out[k] = (Number(a[k]) || 0) + (Number(b[k]) || 0);
  return out;
}

/** 把"生病被照顾"这件事做成一条 dyad 共同记忆 (走标准存储, subject_kind='dyad')。 */
function buildCareMemory(subjectName = '对方', careEvent = {}) {
  const hits = Array.isArray(careEvent.hits) && careEvent.hits.length ? `(${careEvent.hits.join('、')})` : '';
  const fact = `${subjectName}生病的时候, 对方细心照顾、叮嘱${hits}`;
  return {
    type: 'episode',
    fact_core: fact,
    content: fact,
    narrative: '被这样照顾着, 心里暖暖的, 觉得很被在乎',
    subject_kind: 'dyad', // 共同记忆: 这是"我们"一起经历的
    affect_valence: 0.6,
    affect_intensity: 0.7,
    emotion: 0.7,
    importance: 7,
    fact_locked: false,
  };
}
