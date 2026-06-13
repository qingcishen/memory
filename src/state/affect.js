// M1 · 关系-情感状态机 (整个系统的心脏, 见 docs/DEVELOPMENT.md §1.1)。
//
// 维护两样东西:
//   mood          —— 她当下的心情 { valence: -1..1, arousal: 0..1 }, 瞬时, 随时间回落基线
//   relationship  —— 你俩关系的状态 { closeness, tension, repair_debt, trust }, 黏着, 主要被事件改变
//
// 下游 (M2 心情门控检索 / M3 重构) 全部依赖这个状态。
// 本文件上半部是【纯逻辑】(可离线单测), 下半部才碰 IO (supabase / LLM)。

import { supabase, llm, LLM_MODEL, PARAMS } from '../config.js';

const HOUR = 1000 * 60 * 60;
const MOOD_FIELDS = ['valence', 'arousal'];
const REL_FIELDS = ['closeness', 'tension', 'repair_debt', 'trust'];
const FIELD_RANGE = {
  valence: [-1, 1],
  arousal: [0, 1],
  closeness: [0, 1],
  tension: [0, 1],
  repair_debt: [0, 1],
  trust: [0, 1],
};

// ============================================================
//  纯逻辑 (无 IO, 离线可测)
// ============================================================

/** 全新关系的初始状态 (= 各字段基线)。 */
export function defaultState() {
  const b = PARAMS.state.baseline;
  return {
    mood: { valence: b.valence, arousal: b.arousal },
    relationship: {
      closeness: b.closeness,
      tension: b.tension,
      repair_debt: b.repair_debt,
      trust: b.trust,
    },
  };
}

/** 把任意 (可能越界/缺字段) 的状态裁剪、补默认成合法状态。 */
export function clampState(state = {}) {
  const d = defaultState();
  const mood = { ...d.mood, ...(state.mood ?? {}) };
  const relationship = { ...d.relationship, ...(state.relationship ?? {}) };
  for (const f of MOOD_FIELDS) mood[f] = clampField(f, mood[f]);
  for (const f of REL_FIELDS) relationship[f] = clampField(f, relationship[f]);
  return { mood, relationship };
}

/**
 * 让状态随时间向基线回落。心情几小时就平复, 紧张缓和得慢, 亲密/信任/和好债不随时间动。
 * @param state 当前状态
 * @param hours 距上次更新过去的小时数
 */
export function decayState(state, hours) {
  const s = clampState(state);
  const { halfLifeHours, baseline } = PARAMS.state;
  const out = { mood: { ...s.mood }, relationship: { ...s.relationship } };
  for (const f of MOOD_FIELDS) out.mood[f] = decayToward(s.mood[f], baseline[f], hours, halfLifeHours[f]);
  for (const f of REL_FIELDS)
    out.relationship[f] = decayToward(s.relationship[f], baseline[f], hours, halfLifeHours[f]);
  return clampState(out);
}

/**
 * 把一组增量叠加到状态上 (吵架/和好等事件的结果)。
 * 每个字段的单次推动被夹在 ±maxStepPerTurn, 防止一句话把状态推爆。
 * @param deltas { mood?:{valence?,arousal?}, relationship?:{closeness?,tension?,repair_debt?,trust?} }
 */
export function applyDeltas(state, deltas = {}) {
  const s = clampState(state);
  const cap = PARAMS.state.maxStepPerTurn;
  const out = { mood: { ...s.mood }, relationship: { ...s.relationship } };
  const dm = deltas.mood ?? {};
  const dr = deltas.relationship ?? {};
  for (const f of MOOD_FIELDS) if (dm[f] != null) out.mood[f] = s.mood[f] + clampMag(dm[f], cap);
  for (const f of REL_FIELDS) if (dr[f] != null) out.relationship[f] = s.relationship[f] + clampMag(dr[f], cap);
  return clampState(out);
}

/**
 * 不连网的启发式: 从对话文本里嗅出情绪/关系信号, 给出增量。
 * 作为状态机的常驻骨架 (LLM 推断是低频增强, 见 inferDeltasLLM)。
 * 只扫"对方"(user) 的话 —— 她的情绪由她说的决定。
 * @returns deltas 同 applyDeltas 的入参; 命中多条信号会叠加 (最终仍被 applyDeltas 夹住)
 */
export function inferHeuristicDeltas(turns = []) {
  const text = turns
    .filter((t) => t.role === 'user')
    .map((t) => String(t.content ?? ''))
    .join('\n');

  const d = { mood: { valence: 0, arousal: 0 }, relationship: { closeness: 0, tension: 0, repair_debt: 0, trust: 0 } };
  const hit = (re) => (re.test(text) ? 1 : 0);

  // 冲突 / 生气 (升 tension + repair_debt, 心情转负且唤起↑)
  const conflict = hit(/生气|吵架|吵|烦死|很烦|讨厌你|失望|凶|别理我|不想理|滚|分手|冷战|委屈|伤心|难过|哭/);
  if (conflict) {
    d.mood.valence -= 0.4;
    d.mood.arousal += 0.3;
    d.relationship.tension += 0.35;
    d.relationship.repair_debt += 0.3;
    d.relationship.trust -= 0.05;
  }

  // 和好 / 道歉 (清和好债, 降 tension, 升亲密, 心情回暖)
  const repair = hit(/对不起|抱歉|我错了|原谅|和好|别生气了?|没事了|不气了|亲亲|抱抱|乖|和解/);
  if (repair) {
    d.mood.valence += 0.3;
    d.relationship.tension -= 0.4;
    d.relationship.repair_debt -= 0.6;
    d.relationship.closeness += 0.05;
    d.relationship.trust += 0.05;
  }

  // 温情 / 正面 (心情上扬, 亲密微升)
  const warm = hit(/喜欢你|爱你|想你|开心|高兴|谢谢|幸福|哈哈|嘻嘻|么么|宝贝|甜/);
  if (warm) {
    d.mood.valence += 0.25;
    d.mood.arousal += 0.1;
    d.relationship.closeness += 0.04;
  }

  return d;
}

/** 两个状态之间的总变化幅度 (各字段绝对差之和)。用于判断是否值得记一条历史快照。 */
export function stateDelta(before, after) {
  const a = clampState(before);
  const b = clampState(after);
  let sum = 0;
  for (const f of MOOD_FIELDS) sum += Math.abs(b.mood[f] - a.mood[f]);
  for (const f of REL_FIELDS) sum += Math.abs(b.relationship[f] - a.relationship[f]);
  return sum;
}

/** 给"从 before 到 after 这次变化"贴一个事件标签 (吵架/和好/变亲密…), 取动得最猛的方向。 */
export function labelStateEvent(before, after) {
  const a = clampState(before);
  const b = clampState(after);
  const dRepair = b.relationship.repair_debt - a.relationship.repair_debt;
  const dTension = b.relationship.tension - a.relationship.tension;
  const dCloseness = b.relationship.closeness - a.relationship.closeness;
  const dValence = b.mood.valence - a.mood.valence;

  if (dRepair > 0.1 && dTension > 0.05) return '吵架';
  if (dRepair < -0.15) return '和好';
  if (dCloseness > 0.08) return '变亲密';
  if (dValence > 0.2) return '开心';
  if (dValence < -0.2) return '低落';
  return null;
}

/**
 * 概括一段状态历史的走向 (纯逻辑)。history 按时间升序 (最早在前)。
 * @returns { points, span, closenessTrend, trustTrend, peakTension, repairs, first, last }
 */
export function summarizeTrajectory(history = []) {
  const pts = (history ?? [])
    .map((h) => clampState(h))
    .map((h, i) => ({ ...h, created_at: history[i].created_at }));
  if (pts.length === 0) return { points: 0 };

  const first = pts[0];
  const last = pts[pts.length - 1];
  let peakTension = 0;
  let repairs = 0;
  for (let i = 0; i < pts.length; i++) {
    peakTension = Math.max(peakTension, pts[i].relationship.tension);
    if (i > 0 && pts[i].relationship.repair_debt < pts[i - 1].relationship.repair_debt - 0.15) repairs++;
  }
  return {
    points: pts.length,
    span: { from: first.created_at ?? null, to: last.created_at ?? null },
    closenessTrend: trend(first.relationship.closeness, last.relationship.closeness),
    trustTrend: trend(first.relationship.trust, last.relationship.trust),
    peakTension,
    repairs,
    first,
    last,
  };
}

/** 把轨迹概括拼成一句可读的中文 (给关系叙事/调试用)。 */
export function formatTrajectory(summary) {
  if (!summary || !summary.points) return '';
  const map = { rising: '渐渐', falling: '有所', flat: '基本' };
  const parts = [];
  if (summary.closenessTrend === 'rising') parts.push('越来越亲近');
  else if (summary.closenessTrend === 'falling') parts.push('比从前疏远了些');
  if (summary.trustTrend === 'rising') parts.push('信任在加深');
  else if (summary.trustTrend === 'falling') parts.push('信任有过动摇');
  if (summary.repairs > 0) parts.push(`一起走过 ${summary.repairs} 次和好`);
  if (summary.peakTension > 0.6) parts.push('中间有过激烈的争执');
  return parts.length ? `关系走向: ${parts.join(', ')}。` : '';
}

/** 给状态一个可读标签, 便于注入 prompt / 调试 (M2 会正经用到)。 */
export function moodLabel(state) {
  const { mood, relationship } = clampState(state);
  if (relationship.repair_debt > 0.4 || relationship.tension > 0.5) return '受伤/闹脾气';
  if (mood.valence > 0.35) return '开心';
  if (mood.valence < -0.35) return '低落';
  return '平静';
}

// ---- helpers (纯) ----
function clampField(f, v) {
  const [lo, hi] = FIELD_RANGE[f];
  const n = Number(v);
  return Math.min(hi, Math.max(lo, Number.isNaN(n) ? (lo + hi) / 2 : n));
}
function clampMag(x, cap) {
  return Math.min(cap, Math.max(-cap, Number(x) || 0));
}
function decayToward(value, baseline, hours, halfLife) {
  if (halfLife == null || !(hours > 0)) return value; // null = 不随时间衰减
  const factor = Math.pow(0.5, hours / halfLife);
  return baseline + (value - baseline) * factor;
}
/** 比较首尾值给出趋势标签。 */
function trend(from, to, eps = 0.05) {
  if (to - from > eps) return 'rising';
  if (from - to > eps) return 'falling';
  return 'flat';
}

// ============================================================
//  IO 层 (supabase 持久化 + LLM 低频推断)
// ============================================================

/** 读当前状态; 没有记录则返回基线 (并不落库, 第一次 write 时才建行)。 */
export async function readState(userId) {
  const { data, error } = await supabase
    .from('affective_state')
    .select('mood, relationship, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return { ...defaultState(), updated_at: null };
  return { ...clampState({ mood: data.mood, relationship: data.relationship }), updated_at: data.updated_at };
}

/** upsert 当前状态。 */
export async function writeState(userId, state) {
  const s = clampState(state);
  const { error } = await supabase
    .from('affective_state')
    .upsert(
      { user_id: userId, mood: s.mood, relationship: s.relationship, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  if (error) throw error;
  return s;
}

/** 往状态历史表追加一条快照 (带可选事件标签)。 */
export async function appendStateHistory(userId, state, event = null) {
  const s = clampState(state);
  const { error } = await supabase
    .from('affective_state_history')
    .insert({ user_id: userId, mood: s.mood, relationship: s.relationship, event });
  if (error) throw error;
}

/** 读状态历史 (默认按时间升序, 最早在前, 便于直接喂 summarizeTrajectory)。 */
export async function readStateHistory(userId, opts = {}) {
  let q = supabase
    .from('affective_state_history')
    .select('mood, relationship, event, created_at')
    .eq('user_id', userId);
  if (opts.since) q = q.gte('created_at', new Date(opts.since).toISOString());
  q = q.order('created_at', { ascending: false }).limit(opts.limit ?? 50);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).reverse(); // 反转成升序
}

/** 读 → 按距上次更新的时长向基线回落 → 落库。供"无对话时"的定时调用。 */
export async function decayToBaseline(userId, now = Date.now()) {
  const cur = await readState(userId);
  const hours = cur.updated_at ? Math.max(0, (now - new Date(cur.updated_at).getTime()) / HOUR) : 0;
  const decayed = decayState(cur, hours);
  return writeState(userId, decayed);
}

/**
 * 本轮对话后更新状态: 先按时长回落, 再叠加本轮事件增量, 落库。
 * 默认走启发式; opts.useLLM 时再叠加一次 LLM 推断的增量 (低频, 缺凭证自动降级)。
 * @returns { before, after, deltas }
 */
export async function updateFromTurn(userId, turns, opts = {}) {
  const useLLM = opts.useLLM ?? false;
  const now = opts.now ?? Date.now();

  const cur = await readState(userId);
  const hours = cur.updated_at ? Math.max(0, (now - new Date(cur.updated_at).getTime()) / HOUR) : 0;
  const decayed = decayState(cur, hours);

  let deltas = inferHeuristicDeltas(turns);
  if (useLLM) {
    const llmDeltas = await inferDeltasLLM(turns).catch(() => null);
    if (llmDeltas) deltas = mergeDeltas(deltas, llmDeltas);
  }

  const after = applyDeltas(decayed, deltas);
  await writeState(userId, after);

  // 状态有显著变化才记一条历史快照 (轨迹给关系叙事/情感锚审计用)。
  let snapshot = false;
  if (opts.history !== false && stateDelta(cur, after) >= PARAMS.state.snapshotMinDelta) {
    await appendStateHistory(userId, after, labelStateEvent(cur, after)).catch(() => {});
    snapshot = true;
  }
  return { before: cur, after, deltas, snapshot };
}

/**
 * 低频 LLM 推断: 让模型读对话, 给出情绪/关系增量 (-1..1)。
 * 纯增量, 不让 LLM 直接写绝对状态 —— 状态由本地数值机维护, 更稳。
 */
export async function inferDeltasLLM(turns = []) {
  const transcript = turns.map((t) => `${t.role === 'user' ? '对方' : 'AI'}: ${t.content}`).join('\n');
  const sys = `你在维护一个 AI 伴侣的情绪与关系状态。读这段对话, 只输出本轮带来的【增量】(不是绝对值)。
范围都是 -1..1, 没有变化就给 0。严格输出 JSON, 不要其它内容:
{"mood":{"valence":0,"arousal":0},"relationship":{"closeness":0,"tension":0,"repair_debt":0,"trust":0}}
含义: valence 心情正负, arousal 激动程度, closeness 亲密, tension 紧张/积怨, repair_debt 待和好的债 (吵架升、和好降), trust 信任。`;

  const res = await llm.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: transcript },
    ],
  });
  const parsed = JSON.parse(res.choices[0].message.content);
  return {
    mood: { valence: num(parsed?.mood?.valence), arousal: num(parsed?.mood?.arousal) },
    relationship: {
      closeness: num(parsed?.relationship?.closeness),
      tension: num(parsed?.relationship?.tension),
      repair_debt: num(parsed?.relationship?.repair_debt),
      trust: num(parsed?.relationship?.trust),
    },
  };
}

// ---- helpers (IO 侧) ----
function num(v) {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}
function mergeDeltas(a, b) {
  return {
    mood: { valence: num(a.mood?.valence) + num(b.mood?.valence), arousal: num(a.mood?.arousal) + num(b.mood?.arousal) },
    relationship: Object.fromEntries(
      REL_FIELDS.map((f) => [f, num(a.relationship?.[f]) + num(b.relationship?.[f])])
    ),
  };
}
