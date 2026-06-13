import { extractMemories } from './extract.js';
import { storeMemories } from './store.js';
import {
  retrieveMemories,
  retrieveSupersededTrail,
  formatForPrompt,
  formatSupersededTrailForPrompt,
} from './retrieve.js';
import { runReflection, findForgettable } from './reflect.js';
import { readState, updateFromTurn, decayToBaseline, moodLabel } from './state/affect.js';
import { engineRecall } from './engine/index.js';
import { reconsolidateOnRecall, reconsolidateRecent } from './memory/reconsolidate.js';
import { seedPersona, personaBlock } from './persona.js';
import { dyadBackdrop, synthesizeNarrative } from './narrative.js';
import { scheduleFromTurns, dueProspectives, markFired } from './memory/prospective.js';
import { ingestImage, ingestAudio } from './modal/index.js';
import { PARAMS } from './config.js';

/**
 * 记忆系统门面。一个用户一个 userId, 所有记忆按 userId 隔离。
 *
 *   const mem = new Memory({ userId: 'u_123', subjectName: '诗雅' });
 *   await mem.observe(recentTurns);              // 对话后: 提取并存储
 *   const hits = await mem.recall(userMessage);  // 回复前: 检索相关记忆
 *   const block = mem.toPrompt(hits);            // 拼成注入串
 */
export class Memory {
  constructor({ userId, subjectName = '对方' }) {
    if (!userId) throw new Error('Memory 需要 userId');
    this.userId = userId;
    this.subjectName = subjectName;
  }

  /**
   * 对话之后调用: 更新情绪/关系状态 (M1) + 提取记忆并落库 (含矛盾处理)。
   * 状态更新先做, 因为它从整段对话取信号, 不依赖提取结果。
   * @returns { state, stored } —— 本轮后的状态与新存的记忆
   */
  async observe(turns, opts = {}) {
    const { after } = await updateFromTurn(this.userId, turns, opts).catch(() => ({ after: null }));
    const extracted = await extractMemories(turns, this.subjectName);
    const stored = extracted.length === 0 ? [] : await storeMemories(this.userId, extracted);
    // M5: 顺手识别"未来意图"("我明天面试") 并排一条预期记忆。
    const scheduled =
      opts.prospective === false ? null : await scheduleFromTurns(this.userId, turns, opts.now, this.subjectName).catch(() => null);
    return { state: after, stored, scheduled };
  }

  /**
   * 回复之前调用: 按当前消息检索最相关的记忆 (并强化命中项)。
   * 默认走自研激活引擎 (M2): 读当前状态 → 心情门控 + 联想扩散 + ACT-R 激活。
   * 传 { engine: false } 退回旧的纯相似度+recency 重排路径 (双轨对照用)。
   */
  async recall(query, opts = {}) {
    if (opts.engine === false) return retrieveMemories(this.userId, query, opts);
    const state = await readState(this.userId).catch(() => null);
    let hits = await engineRecall(this.userId, query, state, opts);
    // M3: 想起即被当下情绪轻微染色 (落库异步, 返回染色后的值供本轮注入)。
    if (state && opts.reconsolidate !== false) hits = await reconsolidateOnRecall(hits, state);
    // M4: 无条件带上最重要的"我们共同记忆"作关系底色 (去重后补在末尾)。
    const n = opts.includeDyad ?? PARAMS.relationship_memory.alwaysIncludeDyad;
    if (n > 0) {
      const have = new Set(hits.map((m) => m.id));
      const backdrop = (await dyadBackdrop(this.userId, n).catch(() => [])).filter((m) => !have.has(m.id));
      hits = [...hits, ...backdrop];
    }
    return hits;
  }

  /** 读她当前的心情 + 你俩关系状态 (M2 门控检索 / M3 重构会用) */
  async state() {
    return readState(this.userId);
  }

  /** 当前心情的可读标签 (开心 / 平静 / 低落 / 受伤·闹脾气) */
  async mood() {
    return moodLabel(await readState(this.userId));
  }

  /** 定时 (如每隔几小时) 调用: 心情随时间向基线回落, 没有对话也"消气" */
  async settle(now = Date.now()) {
    return decayToBaseline(this.userId, now);
  }

  /**
   * 批量重构 (M3): 按当前状态软化/回暖最近的旧记忆。
   * 典型在【和好后】或【夜间反思时】调一次。传 { useLLM:true } 还会重写显著变化记忆的 narrative。
   * 永不改 fact_core。
   */
  async reconsolidate(opts = {}) {
    const state = await readState(this.userId).catch(() => null);
    if (!state) return { count: 0 };
    return reconsolidateRecent(this.userId, state, opts);
  }

  /** 播种她的人格设定 (self 记忆); facts 可为字符串或 {fact_core,importance,...} 数组 */
  async seedPersona(facts) {
    return seedPersona(this.userId, facts);
  }

  /** 取她的人格注入块 (域隔离: 只含 self 设定, 不混 user 记忆) */
  async persona(opts = {}) {
    return personaBlock(this.userId, this.subjectName, opts);
  }

  /** 合成并存回"我们的故事" (关系叙事, 最高层 reflection)。和好后或定期调一次。 */
  async story(opts = {}) {
    const state = await readState(this.userId).catch(() => null);
    return synthesizeNarrative(this.userId, state, opts);
  }

  /**
   * 检查此刻该不该主动提起某件事 (M5 预期记忆)。回复层在生成前调一次。
   * 传 { query } 让 cue 型做语境匹配。返回 due 列表; 决定提起后用 dismissProspective 标记。
   */
  async checkProspective(ctx = {}, now = Date.now()) {
    return dueProspectives(this.userId, ctx, now);
  }

  /** 已经主动提起过的预期记忆: 标记 fired, 不再重复打扰。 */
  async dismissProspective(ids) {
    return markFired(ids);
  }

  /** 她看到一张图 (M6): vision caption → image 记忆, 之后可被文本召回。缺凭证降级不崩。 */
  async seeImage(opts = {}) {
    return ingestImage(this.userId, opts);
  }

  /** 她听到一段语音 (M6): ASR 转写 + 语气进 affect → audio 记忆。缺凭证降级不崩。 */
  async hearVoice(opts = {}) {
    return ingestAudio(this.userId, opts);
  }

  /** 把检索结果拼成可注入 system prompt 的自然语言 */
  toPrompt(mems) {
    return formatForPrompt(mems, this.subjectName);
  }

  /** 一步到位: 检索 + 直接给出可注入串 */
  async recallAsPrompt(query, opts = {}) {
    const hits = await this.recall(query, opts);
    return this.toPrompt(hits);
  }

  /** 显式翻旧账: 返回与 query 相关的"旧版本 → 当前版本"变化轨迹。 */
  async recallHistory(query, opts = {}) {
    return retrieveSupersededTrail(this.userId, query, opts);
  }

  /** 一步到位: 翻旧账检索 + 拼成可注入 prompt 的变化轨迹。 */
  async recallHistoryAsPrompt(query, opts = {}) {
    const rows = await this.recallHistory(query, opts);
    return formatSupersededTrailForPrompt(rows, this.subjectName);
  }

  /** 定期 (如每晚) 调用: 反思总结 */
  async reflect(opts = {}) {
    return runReflection(this.userId, opts);
  }

  /** 找出几乎被遗忘的记忆; 传 { purge: true } 可清理 */
  async forgettable(threshold = 0.05, opts = {}) {
    return findForgettable(this.userId, threshold, opts);
  }
}
