// Intimacy · 亲密/性爱状态维度 (I 线)。
// 挂进 StateLayer，与 desire/life 平级。数值不进 prompt，只注入超阈值表现指引。
// 详见 docs/intimacy-design.md。

import { supabase } from '../config.js';
import { PARAMS } from '../params.js';
import {
  clampRepertoire,
  detectPositionMentions,
  formatKnowledgePrompt,
  normalizeIntimacyKnowledge,
  pickIntimacyKnowledge,
  pushRepertoirePositions,
} from './intimacyKnowledge.js';

const HOUR = 60 * 60 * 1000;

export const INTIMACY_SCALAR_KEYS = [
  'arousal',
  'engagement',
  'aftercare_need',
  'sexual_tension',
  'sexual_openness',
  'satisfaction',
];

export const INTIMACY_PHASES = ['none', 'flirting', 'foreplay', 'peak', 'aftercare', 'cooldown'];

/** 阶段“亲密强度”排序，用于门控截断。aftercare/cooldown 单独处理。 */
const PHASE_RANK = { none: 0, flirting: 1, foreplay: 2, peak: 3, aftercare: 2, cooldown: 0 };

const DEFAULT_CONSENT = { active: false, pace: 'normal', stop_signal: false };

// ============================================================
//  纯逻辑
// ============================================================

export function defaultIntimacy(overrides = null) {
  const base = {
    arousal: 0,
    engagement: 0,
    aftercare_need: 0,
    sexual_tension: 0,
    sexual_openness: 0.35,
    satisfaction: 0.5,
    scene_phase: 'none',
    last_intimate_at: null,
    consent: { ...DEFAULT_CONSENT },
    body_focus: null,
    repertoire: clampRepertoire({}),
    updated_at: null,
  };
  return clampIntimacy(overrides ? { ...base, ...overrides, consent: { ...DEFAULT_CONSENT, ...(overrides.consent ?? {}) } } : base);
}

export function clampIntimacy(value = {}) {
  const d = {
    arousal: 0,
    engagement: 0,
    aftercare_need: 0,
    sexual_tension: 0,
    sexual_openness: 0.35,
    satisfaction: 0.5,
    scene_phase: 'none',
    last_intimate_at: null,
    consent: { ...DEFAULT_CONSENT },
    body_focus: null,
    repertoire: clampRepertoire({}),
    updated_at: null,
  };
  const out = { ...d, ...(value ?? {}) };
  for (const key of INTIMACY_SCALAR_KEYS) out[key] = clamp(num(out[key], d[key]), 0, 1);
  out.scene_phase = INTIMACY_PHASES.includes(out.scene_phase) ? out.scene_phase : 'none';
  out.last_intimate_at = out.last_intimate_at ? String(out.last_intimate_at) : null;
  const c = { ...DEFAULT_CONSENT, ...(out.consent ?? {}) };
  c.active = Boolean(c.active);
  c.stop_signal = Boolean(c.stop_signal);
  c.pace = ['slow', 'normal', 'eager'].includes(c.pace) ? c.pace : 'normal';
  out.consent = c;
  // body_focus 后期；非法时置 null
  out.body_focus = out.body_focus && typeof out.body_focus === 'object' ? out.body_focus : null;
  out.repertoire = clampRepertoire(out.repertoire);
  out.updated_at = out.updated_at ?? null;
  return out;
}

/** 沉默期间惰性演变：唤起/投入回落，张力可缓升，openness/satisfaction 不随时间漂移。 */
export function evolveIntimacyOverTime(state = {}, hours = 0, config = PARAMS.intimacy) {
  const current = clampIntimacy(state);
  const elapsed = Math.max(0, num(hours));
  if (!elapsed) return current;

  const halfLives = config?.halfLifeHours ?? {};
  const next = { ...current };

  for (const key of ['arousal', 'engagement', 'aftercare_need']) {
    const halfLife = num(halfLives[key]);
    if (halfLife > 0) next[key] = decayToward(current[key], 0, elapsed, halfLife);
  }

  // sexual_tension: 开放度够高（已有性关系的角色）或曾亲密/低满足 → 随沉默缓升
  // libido 高的角色增速更快（drive.libido 或 growth 覆盖）
  const libido = clamp(num(config?.libido, 0.5), 0, 1);
  const tensionGrowth =
    Math.max(0, num(config?.growthPerHour?.sexual_tension, 0)) * (0.65 + libido * 0.9);
  const canAccumulate =
    current.sexual_openness >= num(config?.tensionAccumulateMinOpenness, 0.45)
    || current.sexual_tension > 0.02
    || current.last_intimate_at
    || current.satisfaction < 0.5
    || libido >= 0.6;
  if (canAccumulate && tensionGrowth > 0) {
    const halfLife = num(halfLives.sexual_tension, 72);
    const linear = current.sexual_tension + elapsed * tensionGrowth;
    const saturation = halfLife > 0 ? 1 - (1 - current.sexual_tension) * Math.pow(0.5, elapsed / halfLife) : linear;
    next.sexual_tension = clamp(Math.max(linear, saturation, current.sexual_tension), 0, 1);
  }

  // 高欲望：未亲密时满足感缓慢回落，更容易再次想要
  const satDecay = Math.max(0, num(config?.satisfactionDecayPerHour, 0));
  if (satDecay > 0 && elapsed > 0) {
    const floor = clamp(num(config?.satisfactionFloor, 0.25), 0, 0.6);
    next.satisfaction = clamp(Math.max(floor, current.satisfaction - elapsed * satDecay * (0.5 + libido)), 0, 1);
  }

  // 会话阶段不因时间单独从 peak 跳 none；长时间沉默后降低 engagement 即可
  if (elapsed >= 4 && ['flirting', 'foreplay', 'peak'].includes(current.scene_phase)) {
    next.scene_phase = 'cooldown';
    next.consent = { ...current.consent, active: false };
  }
  if (elapsed >= 12 && ['aftercare', 'cooldown'].includes(next.scene_phase)) {
    next.scene_phase = 'none';
  }

  return clampIntimacy(next);
}

/**
 * 从对话文本抽取亲密信号（启发式，可单测）。
 * subtle: 拍屁股/蹭/摸腿等不必直说的暗示——姐姐人设应读懂，不当傻。
 * @returns {{ invite, subtle, refuse, stop, aftercare, peak, end, romantic, dismissive, caring, lead }}
 */
export function detectIntimacySignals(turns = []) {
  const userText = turns
    .filter((t) => t?.role === 'user')
    .map((t) => String(t?.content ?? ''))
    .join('\n');
  const asstText = turns
    .filter((t) => t?.role === 'assistant')
    .map((t) => String(t?.content ?? ''))
    .join('\n');
  const all = `${userText}\n${asstText}`;

  const invite =
    /(想要你|要你|做吧|做吗|做爱|上床|想和你|想跟你|想摸摸|抱紧我|进来|插|舔|亲我|想被你|想干|想搞|今晚做|继续|别停|快一点|深一点)/u.test(
      userText
    ) || /(想要你|做吧|进来|别停|深一点)/u.test(asstText);
  // 身体小动作 / 半句话暗示：不用「我们做爱」也能懂
  // 覆盖：拍了拍她的屁股 / 拍拍屁股 / 摸了摸你的腿 / 动作括号描写 等
  const subtle =
    /(拍(了|拍|一下|一拍)*\s*(我的|你的|她的|他的)?\s*屁股|拍拍屁股|揉(了|揉|一下)*\s*(我的|你的|她的|他的)?\s*屁股|掐腰|搂腰|摸(了|摸|一下)*\s*(我的|你的|她的|他的)?\s*(腿|腰|胸|屁股)|手(滑|伸|往下|放在)|蹭(了|过来|上来|着)?|顶(着|过来)|咬(耳朵|脖|唇)|亲(脖|锁骨|耳垂)|把我按|压过来|拉进怀里|从后面抱|贴着(我|她)睡|腿环|骑上来|解开|拉链|衣角|往下摸|不安分)/u.test(
      userText
    ) ||
    /(拍.{0,6}屁股|摸腿|蹭过来|咬耳朵|手不安分)/u.test(all);
  const refuse =
    /(不要|别这样|不想做|做不了|太累|生病|身体不舒服|先别|冷静|还没和好|心情不好|没兴趣)/u.test(userText);
  const stop =
    /(停下|停止|不要了|停|疼|不舒服|扫兴|滚|恶心|够了)/u.test(userText) ||
    /(停下|不要了|先停)/u.test(asstText);
  const aftercare =
    /(抱抱|抱着我|别走|陪我|事后|还想贴着|累了|缓一缓|亲一下额头)/u.test(all);
  const peak =
    /(高潮|射|顶|插|进进出出|太深|夹紧|湿透|喘|啊啊)/u.test(all);
  const end =
    /(做完了|结束了|休息吧|睡吧|够了今天|收尾)/u.test(all);
  const romantic =
    /(亲亲|想你|喜欢你|爱你|暧昧|撒娇|靠近|贴着)/u.test(userText);
  const dismissive = /^(嗯+|哦+|好吧|行吧|随便|呵呵)[。.!！?？~～]*$/u.test(userText.trim());
  const caring = /(辛苦|抱抱|心疼|还好吗|怎么了|照顾|温柔|慢一点|别勉强)/u.test(userText);
  // 她侧主导迹象（回复或用户描述她在带）
  const lead =
    /(姐带|我来|坐好|听话|乖|别动|让姐|学姐|我教你|自己坐上来|帮你)/u.test(asstText) ||
    /(你主动|你来|你带我|你教我)/u.test(userText);

  return {
    invite: invite || subtle, // 暗示在关系够时等同邀请入口
    subtle,
    explicitInvite: invite,
    refuse,
    stop,
    aftercare,
    peak,
    end,
    romantic: romantic || subtle,
    dismissive,
    caring,
    lead,
    userText,
  };
}

/**
 * 门控：返回本轮允许的最高“推进强度”阶段（flirting|foreplay|peak）。
 * 失败时最多 flirting。
 */
export function maxAllowedPhase(ctx = {}, config = PARAMS.intimacy) {
  const gates = config?.gates ?? {};
  const rel = ctx.relationship ?? {};
  const life = ctx.life ?? {};
  const intimacy = clampIntimacy(ctx.intimacy ?? {});

  if (intimacy.consent?.stop_signal) return 'none';

  const closeness = num(rel.closeness, 0.5);
  const trust = num(rel.trust, 0.5);
  const tension = num(rel.tension, 0);
  const repair = num(rel.repair_debt, 0);
  const energy = num(life.energy, 0.6);
  const health = num(life.health, 1);

  if (tension >= num(gates.maxTensionForIntimate, 0.7)) return 'flirting';
  if (repair >= num(gates.maxRepairDebtForIntimate, 0.55)) return 'flirting';
  if (energy < num(gates.minEnergy, 0.25) || health < 0.45) return 'flirting';
  if (closeness < num(gates.minCloseness, 0.55)) return 'flirting';
  if (trust < num(gates.minTrust, 0.45)) return 'flirting';
  if (intimacy.sexual_openness < num(gates.minOpennessForPeak, 0.4)) return 'foreplay';
  return 'peak';
}

export function capPhase(phase, maxPhase) {
  const p = INTIMACY_PHASES.includes(phase) ? phase : 'none';
  if (p === 'aftercare' || p === 'cooldown' || p === 'none') return p;
  const max = INTIMACY_PHASES.includes(maxPhase) ? maxPhase : 'flirting';
  if ((PHASE_RANK[p] ?? 0) <= (PHASE_RANK[max] ?? 0)) return p;
  return max === 'none' ? 'none' : max;
}

/**
 * 阶段迁移 + 标量启发式结算。
 * @param ctx {{ relationship, life, desires, sceneType, now }}
 */
export function settleIntimacyFromTurns(state = {}, turns = [], ctx = {}, config = PARAMS.intimacy) {
  let next = clampIntimacy(state);
  const signals = detectIntimacySignals(turns);
  const sceneType = ctx.sceneType ?? null;
  const maxPhase = maxAllowedPhase({ ...ctx, intimacy: next }, config);
  const gatedOut = maxPhase === 'flirting' || maxPhase === 'none';

  // stop 优先
  if (signals.stop) {
    next.consent = { ...next.consent, active: false, stop_signal: true };
    next.arousal = Math.max(0, next.arousal - 0.4);
    next.engagement = Math.max(0, next.engagement - 0.5);
    next.sexual_tension = clamp(next.sexual_tension + 0.05, 0, 1);
    next.satisfaction = clamp(next.satisfaction - 0.08, 0, 1);
    next.scene_phase = next.scene_phase === 'peak' || next.scene_phase === 'foreplay' ? 'aftercare' : 'cooldown';
    if (next.scene_phase === 'aftercare') next.aftercare_need = clamp(next.aftercare_need + 0.35, 0, 1);
    return { state: clampIntimacy(next), signals, maxPhase, affectDelta: feedbackDelta('stopOrBad', config), desireDelta: { security: 0.1 } };
  }

  // 拒绝 / 门控拦截下的强邀请
  if (signals.refuse || (signals.invite && gatedOut && maxPhase === 'flirting' && (num(ctx.relationship?.tension) > 0.5 || num(ctx.relationship?.repair_debt) > 0.4))) {
    if (signals.refuse || signals.invite) {
      // 保持可亲密依赖，但不进 peak
      next.scene_phase = capPhase(signals.romantic || sceneType === 'romantic' ? 'flirting' : next.scene_phase, maxPhase);
      next.consent = { ...next.consent, active: false };
      if (signals.invite && gatedOut) {
        next.sexual_tension = clamp(next.sexual_tension + 0.05, 0, 1);
      }
    }
  }

  // 场景分类推进
  let target = next.scene_phase;
  const initiateAt = num(config?.proactive?.initiateThreshold, 0.78);
  const sisterLead = config?.style?.sisterLead !== false;
  // 姐系高张力：她可以先动，不必等对方邀请 —— 至少进入 flirting（门控允许暧昧即可，不必已可 peak）
  if (
    sisterLead
    && maxPhase !== 'none'
    && next.scene_phase === 'none'
    && next.sexual_tension >= initiateAt
    && !signals.refuse
    && !signals.stop
  ) {
    target = 'flirting';
    next.engagement = clamp(next.engagement + 0.08, 0, 1);
    next.arousal = clamp(next.arousal + 0.06, 0, 1);
  }
  if (sceneType === 'daily' && !signals.invite && !signals.peak && !['aftercare', 'foreplay', 'peak'].includes(next.scene_phase)) {
    // 高张力主动 flirting 时不要被 daily 立刻打回 none
    if (next.scene_phase === 'flirting' && !signals.romantic && next.sexual_tension < initiateAt) target = 'none';
  }
  if (sceneType === 'romantic' || signals.romantic || signals.subtle) {
    target = target === 'none' || target === 'cooldown' ? 'flirting' : target;
  }
  // 明示邀请、身体暗示、或已在亲密场景 → 推进
  const wantIn = sceneType === 'intimate' || signals.explicitInvite || signals.invite || signals.subtle;
  if (wantIn) {
    if (next.consent.active || signals.explicitInvite || signals.invite || (signals.subtle && !gatedOut)) {
      // 暗示在关系门控通过时直接当她读懂了，进 foreplay；纯暧昧未够门控则停 flirting
      if (signals.subtle && !signals.explicitInvite && !signals.peak && next.scene_phase === 'none') {
        target = gatedOut ? 'flirting' : 'foreplay';
      } else {
        target = signals.peak ? 'peak' : next.scene_phase === 'peak' ? 'peak' : 'foreplay';
      }
      if (!gatedOut) next.consent = { ...next.consent, active: true, stop_signal: false };
    } else {
      target = 'flirting';
    }
  }
  if (signals.peak && next.consent.active) target = 'peak';
  if (signals.end || (signals.aftercare && ['peak', 'foreplay'].includes(next.scene_phase))) target = 'aftercare';
  if (signals.aftercare && next.scene_phase === 'aftercare') {
    next.aftercare_need = clamp(next.aftercare_need - 0.45, 0, 1);
  }
  if (sceneType === 'daily' && next.scene_phase === 'aftercare' && !signals.aftercare) target = 'cooldown';
  if (next.scene_phase === 'cooldown' && sceneType === 'daily' && !signals.romantic && !signals.subtle) target = 'none';

  // consent 建立：明示或（门控通过下的）暗示
  if ((signals.explicitInvite || signals.subtle || signals.invite) && !gatedOut) {
    next.consent = { ...next.consent, active: true, stop_signal: false };
    if (signals.caring) next.consent.pace = 'slow';
  }
  // 姐主导：她带节奏时略抬 engagement，不另改 phase
  if (signals.lead && ['flirting', 'foreplay', 'peak'].includes(target || next.scene_phase)) {
    next.engagement = clamp(next.engagement + 0.08, 0, 1);
  }
  if (config?.gates?.requireConsentForPeak !== false && target === 'peak' && !next.consent.active) {
    target = 'foreplay';
  }

  target = capPhase(target, maxPhase === 'none' ? 'none' : maxPhase);
  // aftercare 不受 peak 门控截断为 flirting
  if (['aftercare', 'cooldown'].includes(next.scene_phase) && (signals.aftercare || signals.end)) {
    target = signals.aftercare || next.scene_phase === 'aftercare' ? 'aftercare' : target;
  }

  next.scene_phase = target;

  // 标量
  if (['flirting', 'foreplay', 'peak'].includes(target)) {
    next.engagement = clamp(next.engagement + (target === 'peak' ? 0.25 : 0.12), 0, 1);
    next.arousal = clamp(next.arousal + (target === 'peak' ? 0.3 : target === 'foreplay' ? 0.18 : 0.08), 0, 1);
    next.last_intimate_at = ctx.now ? new Date(ctx.now).toISOString() : next.last_intimate_at ?? new Date().toISOString();
  }
  if (target === 'peak') {
    next.sexual_tension = clamp(next.sexual_tension - 0.25, 0, 1);
    next.aftercare_need = clamp(next.aftercare_need + 0.3, 0, 1);
  }
  // 姿势知识：从本轮对话检测用过的体位，写入 repertoire 避免下一轮只会同一种
  if (['foreplay', 'peak'].includes(target)) {
    const allText = (turns ?? []).map((t) => t?.content ?? '').join('\n');
    const hits = detectPositionMentions(allText, config?.knowledge);
    if (hits.length) next.repertoire = pushRepertoirePositions(next.repertoire, hits);
    else if (target === 'peak' && !next.repertoire?.focus_position) {
      // 未点名姿势时也记一个本场焦点，便于下轮换
      const pick = pickIntimacyKnowledge(config?.knowledge, next.repertoire, 'peak');
      if (pick?.position?.id) {
        next.repertoire = pushRepertoirePositions(next.repertoire, [pick.position.id]);
      }
    }
  }
  if (target === 'aftercare') {
    next.arousal = clamp(next.arousal - 0.15, 0, 1);
    if (signals.caring || signals.aftercare) {
      next.aftercare_need = clamp(next.aftercare_need - 0.4, 0, 1);
      next.satisfaction = clamp(next.satisfaction + 0.08, 0, 1);
      next.sexual_openness = clamp(next.sexual_openness + 0.02, 0, 1);
    }
  }
  if (signals.dismissive && ['foreplay', 'peak', 'flirting'].includes(next.scene_phase)) {
    next.engagement = clamp(next.engagement - 0.2, 0, 1);
    next.satisfaction = clamp(next.satisfaction - 0.05, 0, 1);
  }
  if (signals.caring && !signals.stop) {
    next.engagement = clamp(next.engagement + 0.05, 0, 1);
  }

  // 节奏
  if (/(慢一点|温柔|别急)/u.test(signals.userText ?? '')) next.consent.pace = 'slow';
  if (/(快一点|用力|深一点)/u.test(signals.userText ?? '')) next.consent.pace = 'eager';

  let affectKind = null;
  if (target === 'peak' && next.engagement > 0.4) affectKind = 'goodPeak';
  else if (target === 'aftercare' && (signals.caring || signals.aftercare)) affectKind = 'goodAftercare';
  else if (signals.dismissive && ['foreplay', 'peak'].includes(target)) affectKind = 'stopOrBad';

  return {
    state: clampIntimacy(next),
    signals,
    maxPhase,
    affectDelta: affectKind ? feedbackDelta(affectKind, config) : null,
    desireDelta: affectKind === 'stopOrBad' ? { security: 0.08 } : null,
  };
}

/** 回复前：根据当前消息 + 场景预演 phase（不写库，供旁白/prompt）。 */
export function prepareIntimacyForTurn(state = {}, ctx = {}, config = PARAMS.intimacy) {
  const turns = [{ role: 'user', content: ctx.userMessage ?? '' }];
  const settled = settleIntimacyFromTurns(state, turns, ctx, config);
  return settled.state;
}

function feedbackDelta(kind, config) {
  const fb = config?.feedback?.[kind];
  if (!fb) return null;
  const mood = {};
  const relationship = {};
  if (fb.valence != null) mood.valence = num(fb.valence);
  if (fb.arousal != null) mood.arousal = num(fb.arousal);
  if (fb.closeness != null) relationship.closeness = num(fb.closeness);
  if (fb.trust != null) relationship.trust = num(fb.trust);
  if (fb.tension != null) relationship.tension = num(fb.tension);
  if (!Object.keys(mood).length && !Object.keys(relationship).length) return null;
  return {
    mood: Object.keys(mood).length ? mood : undefined,
    relationship: Object.keys(relationship).length ? relationship : undefined,
  };
}

export function applyIntimacyDeltas(state = {}, deltas = {}, maxStep = PARAMS.intimacy?.maxStepPerTurn ?? PARAMS.state?.maxStepPerTurn ?? 0.35) {
  const next = clampIntimacy(state);
  for (const key of INTIMACY_SCALAR_KEYS) {
    if (deltas?.[key] == null) continue;
    next[key] = clamp(next[key] + clamp(num(deltas[key]), -maxStep, maxStep), 0, 1);
  }
  return clampIntimacy(next);
}

/** 数值不进 prompt。门控失败与超阈值状态 → 表现指引。 */
export function toIntimacyPrompt(state, ctx = {}, config = PARAMS.intimacy) {
  if (config?.enabled === false) return '';
  if (!state) return '';
  const s = clampIntimacy(state);
  const th = config?.promptThreshold ?? {};
  const maxPhase = maxAllowedPhase({ ...ctx, intimacy: s }, config);
  const lines = [];

  const gated =
    maxPhase === 'flirting' &&
    (num(ctx.relationship?.tension) >= num(config?.gates?.maxTensionForIntimate, 0.7) ||
      num(ctx.relationship?.repair_debt) >= num(config?.gates?.maxRepairDebtForIntimate, 0.55) ||
      num(ctx.life?.energy, 1) < num(config?.gates?.minEnergy, 0.25));

  if (gated || s.consent.stop_signal) {
    lines.push('你现在不适合进入性爱正戏：可能太累、还没和好、或心里别扭。可以亲密依赖、要抱抱，但应温柔拒绝或延后正戏，留台阶，不要表面顺从硬写下去。拒绝时话只围绕「现在为何不宜」，禁止硬接无关的上课/吃饭提醒。');
  } else if (num(ctx.relationship?.closeness, 1) < num(config?.gates?.minCloseness, 0.55)) {
    lines.push('你们还没到可以很放得开的亲密程度；最多停留在暧昧试探，不要突然进入具体性爱动作。');
  }

  // 只有真的进入亲密相关状态时才注入姐系/阶段指引——高亲密日常聊天不硬灌「懂暗示」
  const intimateNow = ['flirting', 'foreplay', 'peak', 'aftercare'].includes(s.scene_phase)
    || s.arousal >= num(th.arousal, 0.45)
    || s.sexual_tension >= num(th.sexual_tension, 0.55)
    || s.aftercare_need >= num(th.aftercare_need, 0.4)
    || (s.satisfaction <= num(th.satisfactionLow, 0.35) && s.scene_phase !== 'none');

  const sisterLead = config?.style?.sisterLead !== false;
  if (
    sisterLead
    && intimateNow
    && !gated
    && num(ctx.relationship?.closeness, 0) >= num(config?.gates?.minCloseness, 0.55)
  ) {
    lines.push(
      '你比他更会读空气、更敢带一点节奏；对方小动作你心里懂，用反应/半句调侃/顺势接住即可，不要装傻追问，也不要把「我很懂」说出口。'
    );
  }

  if (s.scene_phase === 'aftercare' || s.aftercare_need >= num(th.aftercare_need, 0.4)) {
    lines.push('事后余韵：话少一点、贴着就好；别急着开玩笑扫兴，也别无缝续车。');
  }
  if (s.arousal >= num(th.arousal, 0.45) && ['flirting', 'foreplay', 'peak'].includes(s.scene_phase)) {
    if (s.consent.pace === 'slow') {
      lines.push('身体已经热了，但你想慢一点；用动作和语气把节奏放缓，而不是讲道理。');
    } else if (s.consent.pace === 'eager') {
      lines.push('你已经很投入，可以更主动地带一下，但台词仍要像真人随口说的，不是技巧说明书。');
    } else {
      lines.push('身体已经有反应；可以先动或先接住他，别跳戏，也别汇报自己的状态。');
    }
  }
  const libido = clamp(num(config?.libido, 0.5), 0, 1);
  if (s.sexual_tension >= num(th.sexual_tension, 0.55) && s.scene_phase === 'none') {
    const initiateAt = num(config?.proactive?.initiateThreshold, 0.78);
    if (s.sexual_tension >= initiateAt && sisterLead && !gated) {
      lines.push(
        libido >= 0.7
          ? '你对他的欲望不低，现在就想要：可以主动发起亲密——黏、拉近、半命令式把他拽过来，用动作或人话带进暧昧/前戏，不必等他先开口。仍像真人，先黏再推进，别自我播报「我欲望很强」。'
          : '你现在很想要他：可以主动发起亲密——拉近、半命令式把他拽过来、用动作或一两句人话带进暧昧/前戏，不必等他先开口。仍要像真人，第一句别突然黄暴长文，可以先黏再推进。'
      );
    } else {
      lines.push(
        libido >= 0.7
          ? '身体上的想念不少；可以先靠近、先撩，时机对就再往前带，别装淡定到像没感觉。'
          : '心里有一点亲近欲；可以先靠近、先撩一下，点到为止。时机对也可以再往前带一点。'
      );
    }
  }
  if (s.satisfaction <= num(th.satisfactionLow, 0.35) && s.scene_phase === 'none') {
    lines.push(
      libido >= 0.7
        ? '最近少被好好碰过，身体有点空；可以黏过去、你先动手，傲娇可以，别抱怨着要。'
        : '最近少了一点贴近；可以自然黏过去，傲娇可以，别抱怨、别索取。想要的话也可以你先动手。'
    );
  }
  if (s.scene_phase === 'foreplay') {
    lines.push('前戏/亲密推进中：用身体反应和一两句自然的话推进，可主导；不要瞬间收尾。你懂多种前戏与体位，别只会一种套路。');
  }
  if (s.scene_phase === 'peak') {
    lines.push('已在明确亲密中：投入、具体，双方反应都要写在旁白里；台词短而真，别解说剧情。体位与节奏可换，别整场锁死一个姿势。');
  }
  if (s.scene_phase === 'flirting') {
    lines.push('暧昧试探：神态和距离为主，可以轻轻反将一军；不要跳进具体正戏。');
  }

  // 姿势/前戏/敏感点知识：仅 foreplay/peak 注入，推动多样性
  if (['foreplay', 'peak'].includes(s.scene_phase) && !gated && !s.consent.stop_signal) {
    const knowledge = ctx.knowledge ?? config?.knowledge ?? null;
    const pick = pickIntimacyKnowledge(knowledge, s.repertoire, s.scene_phase);
    const kn = formatKnowledgePrompt(pick, s.scene_phase);
    if (kn) lines.push(kn);
  }

  // 硬边界：仅在亲密相关时注入，避免日常对话被边界条文污染
  const boundaries = ctx.hardBoundaries;
  if (intimateNow && Array.isArray(boundaries) && boundaries.length) {
    lines.push(`行为红线（遵守即可，不要当台词念）：${boundaries.slice(0, 3).join('；')}`);
  }

  // 亲密相关时的台词防破功（日常由 assemble 全局规则管，这里不重复灌）
  if (lines.length) {
    lines.push(
      '【台词】像枕边随口说的：可以一整句或两句连着，允许反问和省略；禁止三句以上电报体；禁止说穿「我懂你/手一碰就知道」；禁止说明书腔；禁止报菜名念姿势名。',
      '【连贯】亲密话题里只谈当下亲密/地点/身体/要不要；若拒绝车震，就说清「车里不方便→回家再说」，整句收在这件事上。禁止末尾硬插「明天上课困了别怪我」这类与本句无关的学姐唠叨。旁白写身体，台词写人话。'
    );
  }

  return lines.length ? `【你此刻的亲密状态（内部指引，禁止复述）】\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}

/**
 * I5：主动性紧迫度。
 * - 中等张力：暧昧想念
 * - 高张力（≥ initiateThreshold）+ 姐系：可以主动发起亲密（仍像真人第一句，不是黄暴刷屏）
 */
export function intimacyUrgency(state = {}, policy = PARAMS.intimacy?.proactive) {
  if (policy?.enabled === false) return { urgent: false, kind: null, tone: '', score: 0, cooldownFactor: 1, canInitiate: false };
  const s = clampIntimacy(state);
  if (['foreplay', 'peak', 'aftercare'].includes(s.scene_phase)) {
    return { urgent: false, kind: null, tone: '', score: 0, cooldownFactor: 1, canInitiate: false };
  }
  const highT = num(policy?.highTensionThreshold, 0.7);
  const initiateAt = num(policy?.initiateThreshold, 0.78);
  const lowS = num(policy?.lowSatisfactionThreshold, 0.35);
  let kind = null;
  let score = 0;
  let tone = '';
  let canInitiate = false;
  if (s.sexual_tension >= highT) {
    kind = 'tension';
    score = s.sexual_tension;
    canInitiate = s.sexual_tension >= initiateAt;
    tone = canInitiate
      ? '你想要他了：主动找他亲近，可以黏、可以半命令式把人拽近，暗示或明确想亲密都可以；第一句仍要像真人随口说，不要上来就黄暴长文，也不要解释「我很主动」'
      : '带一点想念和暧昧，想靠近对方；可以撩，但别一上来就很露骨';
  } else if (s.satisfaction <= lowS) {
    kind = 'satisfaction';
    score = 1 - s.satisfaction;
    tone = '轻轻流露最近有点缺少贴近，想被陪着；可以更黏一点，语气克制，别抱怨';
  }
  if (!kind) return { urgent: false, kind: null, tone: '', score: 0, cooldownFactor: 1, canInitiate: false };
  const minFactor = Math.min(1, Math.max(0.1, num(policy?.minCooldownFactor, 0.5)));
  const progress = Math.min(1, score);
  return { urgent: true, kind, tone, score, cooldownFactor: 1 - progress * (1 - minFactor), canInitiate };
}

// ============================================================
//  IO
// ============================================================

export async function readIntimacy(userId, companionId = 'default') {
  if (!userId) return defaultIntimacy();
  const { data, error } = await supabase
    .from('affective_state')
    .select('intimacy, updated_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .maybeSingle();
  if (error || !data) return defaultIntimacy();
  const raw = data.intimacy && typeof data.intimacy === 'object' ? data.intimacy : {};
  return clampIntimacy({ ...raw, updated_at: raw.updated_at ?? null });
}

export async function writeIntimacy(userId, companionId = 'default', intimacy, now = Date.now()) {
  if (!userId) throw new Error('writeIntimacy 需要 userId');
  const value = clampIntimacy(intimacy);
  const stamp = new Date(now).toISOString();
  const row = {
    user_id: userId,
    companion_id: companionId,
    intimacy: { ...value, updated_at: stamp },
  };
  const { error } = await supabase.from('affective_state').upsert(row, { onConflict: 'user_id,companion_id' });
  if (error) throw error;
  return { ...value, updated_at: stamp };
}

/**
 * 合并全局 PARAMS.intimacy 与角色 drive（companions 下 intimacy.json）。
 * 高 libido 姐姐：张力涨得快、更早主动、满足感更容易回落。
 */
export function mergeIntimacyConfig(base = PARAMS.intimacy, drive = null) {
  const src = base && typeof base === 'object' ? base : PARAMS.intimacy;
  const out = {
    ...src,
    growthPerHour: { ...(src.growthPerHour ?? {}) },
    halfLifeHours: { ...(src.halfLifeHours ?? {}) },
    promptThreshold: { ...(src.promptThreshold ?? {}) },
    gates: { ...(src.gates ?? {}) },
    proactive: { ...(src.proactive ?? {}) },
    style: { ...(src.style ?? {}) },
    feedback: { ...(src.feedback ?? {}) },
  };
  if (!drive || typeof drive !== 'object') return out;

  if (drive.libido != null) out.libido = clamp(num(drive.libido, out.libido ?? 0.5), 0, 1);
  if (drive.tensionGrowthPerHour != null) {
    out.growthPerHour = { ...out.growthPerHour, sexual_tension: Math.max(0, num(drive.tensionGrowthPerHour)) };
  }
  if (drive.satisfactionDecayPerHour != null) out.satisfactionDecayPerHour = Math.max(0, num(drive.satisfactionDecayPerHour));
  if (drive.satisfactionFloor != null) out.satisfactionFloor = clamp(num(drive.satisfactionFloor, 0.25), 0, 0.6);
  if (drive.initiateThreshold != null) {
    out.proactive = { ...out.proactive, initiateThreshold: clamp(num(drive.initiateThreshold, 0.78), 0.4, 0.95) };
  }
  if (drive.highTensionThreshold != null) {
    out.proactive = { ...out.proactive, highTensionThreshold: clamp(num(drive.highTensionThreshold, 0.65), 0.3, 0.95) };
  }
  if (drive.promptTensionThreshold != null) {
    out.promptThreshold = { ...out.promptThreshold, sexual_tension: clamp(num(drive.promptTensionThreshold, 0.55), 0.2, 0.9) };
  }
  if (typeof drive.sisterLead === 'boolean') {
    out.style = { ...out.style, sisterLead: drive.sisterLead };
  }
  return out;
}

export class IntimacyDimension {
  constructor({
    userId,
    companionId = 'default',
    read = readIntimacy,
    write = writeIntimacy,
    now = () => Date.now(),
    config = PARAMS.intimacy,
    baseline = null,
    hardBoundaries = null,
    knowledge = null,
  } = {}) {
    const cfg = { ...(config ?? PARAMS.intimacy) };
    if (knowledge) cfg.knowledge = normalizeIntimacyKnowledge(knowledge);
    else if (cfg.knowledge) cfg.knowledge = normalizeIntimacyKnowledge(cfg.knowledge);
    Object.assign(this, { userId, companionId, read, write, now, config: cfg, baseline, hardBoundaries, knowledge: cfg.knowledge ?? null });
  }

  enabled() {
    return this.config?.enabled !== false;
  }

  async snapshot() {
    if (!this.enabled()) return defaultIntimacy(this.baseline);
    const stored = this.userId
      ? await this.read(this.userId, this.companionId)
      : defaultIntimacy(this.baseline);
    const hours = stored.updated_at ? Math.max(0, (this.now() - new Date(stored.updated_at).getTime()) / HOUR) : 0;
    let evolved = evolveIntimacyOverTime(stored, hours, this.config);
    if (this.baseline && stored.updated_at == null) {
      evolved = clampIntimacy({ ...evolved, ...pickBaseline(this.baseline) });
    }
    return evolved;
  }

  /**
   * @param turns
   * @param ctx {{ relationship, life, desires, sceneType, deltas }}
   */
  async evolve(turns = [], ctx = {}) {
    if (!this.enabled()) return defaultIntimacy(this.baseline);
    let base = await this.snapshot();
    const settled = settleIntimacyFromTurns(base, turns, { ...ctx, now: this.now() }, this.config);
    let next = settled.state;
    if (ctx.deltas) next = applyIntimacyDeltas(next, ctx.deltas, ctx.maxStep ?? this.config?.maxStepPerTurn);
    if (this.userId) await this.write(this.userId, this.companionId, next, this.now());
    return { ...next, _meta: { signals: settled.signals, maxPhase: settled.maxPhase, affectDelta: settled.affectDelta, desireDelta: settled.desireDelta } };
  }

  async accumulate(event = {}) {
    if (!this.enabled()) return defaultIntimacy(this.baseline);
    const next = applyIntimacyDeltas(await this.snapshot(), event?.intimacy ?? event);
    if (this.userId) await this.write(this.userId, this.companionId, next, this.now());
    return next;
  }

  toPrompt(state, ctx = {}) {
    return toIntimacyPrompt(
      state,
      {
        ...ctx,
        hardBoundaries: ctx.hardBoundaries ?? this.hardBoundaries,
        knowledge: ctx.knowledge ?? this.knowledge ?? this.config?.knowledge,
      },
      this.config
    );
  }
}

function pickBaseline(baseline = {}) {
  const out = {};
  for (const key of INTIMACY_SCALAR_KEYS) {
    if (baseline[key] != null) out[key] = baseline[key];
  }
  if (baseline.pace) out.consent = { ...DEFAULT_CONSENT, pace: baseline.pace };
  return out;
}

function decayToward(value, target, hours, halfLifeHours) {
  if (halfLifeHours == null || !(halfLifeHours > 0) || !(hours > 0)) return value;
  const k = Math.pow(0.5, hours / halfLifeHours);
  return target + (value - target) * k;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
