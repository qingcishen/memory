// M5 · 预期记忆 (prospective memory, 招牌④) —— 唯一面向未来的记忆。
//
// 现存系统全是被动回溯。这里让她【主动】在未来某刻 (time) 或某语境线索 (cue) 把事捞回来:
//   "你上次说今天面试, 怎么样了?"
//
// 流程: observe 阶段识别"未来意图"("我明天面试") → schedule 一条 time 触发;
//       每轮 recall / 定时检查 due → 交给回复层主动提起; 触发后置 fired; 过期降级不打扰。
//
// 上半部纯逻辑 (识别意图 / 相对日期 / 到期判断), 下半部碰 IO (落库 / 查询 / embed)。

import { supabase, PARAMS } from '../config.js';
import { embed } from '../embeddings.js';
import { cosine } from '../engine/vector-index.js';

const HOUR = 1000 * 60 * 60;
const DAY = HOUR * 24;

// ============================================================
//  纯逻辑
// ============================================================

// "未来意图" 关键词 → 相对触发时间 (ms 偏移 / 或当天定点)。
const FUTURE_CUES = [
  { re: /后天/, offsetDays: 2 },
  { re: /明天|明早|明晚/, offsetDays: 1 },
  { re: /大后天/, offsetDays: 3 },
  { re: /下周|下个?星期/, offsetDays: 7 },
  { re: /今晚|今天晚上/, offsetDays: 0, hour: 20 },
  { re: /一会儿|待会|等会|过会/, offsetHours: 2 },
];

// 值得记挂的事件名 (有这些才认为是"未来要发生、之后该关心"的事)
const EVENT_RE = /面试|考试|体检|手术|答辩|出差|旅行|演出|比赛|约会|见面|报告|开会|相亲|搬家|签约|入职|生日|纪念日/;

/** 把"明天/今晚/下周"等相对说法换算成绝对触发时刻。无匹配返回 null。 */
export function relativeTriggerAt(text, now = Date.now()) {
  for (const c of FUTURE_CUES) {
    if (!c.re.test(text)) continue;
    if (c.offsetHours != null) return new Date(now + c.offsetHours * HOUR);
    const base = new Date(now + (c.offsetDays ?? 0) * DAY);
    base.setHours(c.hour ?? PARAMS.prospective.defaultHour, 0, 0, 0);
    return base;
  }
  return null;
}

/**
 * 从对话里识别一条预期记忆 (启发式: 未来时间词 + 值得关心的事件)。
 * @returns { content, trigger_kind:'time', trigger_at, cueText } 或 null
 */
export function detectProspective(turns = [], now = Date.now(), subjectName = '对方') {
  const userText = turns.filter((t) => t.role === 'user').map((t) => String(t.content ?? '')).join('\n');
  if (!EVENT_RE.test(userText)) return null;
  const at = relativeTriggerAt(userText, now);
  if (!at) return null;
  const event = (userText.match(EVENT_RE) || [])[0];
  return {
    content: `${subjectName}之前提过${event}, 主动问问后来怎么样了`,
    trigger_kind: 'time',
    trigger_at: at.toISOString(),
    cueText: event,
  };
}

/** 某条预期记忆此刻是否该触发。time 看时刻, cue 看语境相似度。 */
export function isDue(item, ctx = {}, now = Date.now(), opts = {}) {
  if (!item || item.status !== 'pending') return false;
  if (item.trigger_kind === 'time') {
    return item.trigger_at != null && new Date(item.trigger_at).getTime() <= now && !isExpired(item, now, opts.graceHours);
  }
  if (item.trigger_kind === 'cue') {
    const thr = opts.cueThreshold ?? PARAMS.prospective.cueThreshold;
    if (!Array.isArray(ctx.queryVec) || !Array.isArray(item.cue_embedding)) return false;
    return cosine(ctx.queryVec, item.cue_embedding) >= thr;
  }
  return false;
}

/** time 型: 过了触发时刻又超过 grace 仍没提起, 视为过期 (降级, 不再打扰)。 */
export function isExpired(item, now = Date.now(), graceHours = PARAMS.prospective.graceHours) {
  if (item.trigger_kind !== 'time' || !item.trigger_at) return false;
  return now - new Date(item.trigger_at).getTime() > graceHours * HOUR;
}

// ============================================================
//  IO 层
// ============================================================

/** 排一条预期记忆。cue 型会把 cueText 向量化存入 cue_embedding。 */
export async function scheduleProspective(userId, item) {
  const row = {
    user_id: userId,
    content: item.content,
    trigger_kind: item.trigger_kind,
    trigger_at: item.trigger_at ?? null,
    status: 'pending',
  };
  if (item.trigger_kind === 'cue' && item.cueText) row.cue_embedding = await embed(item.cueText);
  const { data, error } = await supabase.from('prospective').insert(row).select().single();
  if (error) throw error;
  return data;
}

/** observe 阶段顺手识别并排程未来意图; 没识别到返回 null。 */
export async function scheduleFromTurns(userId, turns, now = Date.now(), subjectName = '对方') {
  const p = detectProspective(turns, now, subjectName);
  if (!p) return null;
  return scheduleProspective(userId, p);
}

/**
 * 查当前该主动提起的预期记忆。先扫过期的降级, 再返回 due 列表。
 * @param ctx { query } —— 给 cue 型做语境匹配 (会 embed query)
 */
export async function dueProspectives(userId, ctx = {}, now = Date.now()) {
  const { data: pending, error } = await supabase
    .from('prospective')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending');
  if (error) throw error;
  if (!pending || pending.length === 0) return [];

  // 过期 time 型降级
  const expired = pending.filter((p) => isExpired(p, now));
  if (expired.length > 0) {
    await supabase.from('prospective').update({ status: 'expired' }).in('id', expired.map((p) => p.id));
  }

  // cue 型需要 query 向量
  const needCue = pending.some((p) => p.trigger_kind === 'cue');
  const queryVec = needCue && ctx.query ? parseVec(await embed(ctx.query)) : null;

  const due = pending
    .filter((p) => !isExpired(p, now))
    .map((p) => ({ ...p, cue_embedding: parseVec(p.cue_embedding) }))
    .filter((p) => isDue(p, { queryVec }, now));
  return due;
}

/** 触发后标记 fired, 避免重复打扰。 */
export async function markFired(ids) {
  if (!ids || ids.length === 0) return;
  await supabase.from('prospective').update({ status: 'fired' }).in('id', [].concat(ids));
}

function parseVec(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a : null;
    } catch {
      return null;
    }
  }
  return null;
}
