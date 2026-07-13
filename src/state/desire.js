// Desire · 需求/驱力维度。四项驱力限制在 0..1，读取时惰性演变。
import { supabase } from '../config.js';
import { PARAMS } from '../params.js';

const HOUR = 60 * 60 * 1000;
export const DESIRE_KEYS = ['attention', 'sharing', 'comfort', 'security'];

export function defaultDesires() {
  return { attention: 0, sharing: 0, comfort: 0, security: 0 };
}

export function clampDesires(value = {}) {
  const defaults = defaultDesires();
  return Object.fromEntries(DESIRE_KEYS.map((key) => [key, clamp(num(value?.[key], defaults[key]), 0, 1)]));
}

/** 沉默期间自然演变；非 attention 需求只有被事件播种后才会继续累积。 */
export function evolveDesiresOverTime(desires = {}, hours = 0, config = PARAMS.desire) {
  const current = clampDesires(desires);
  const elapsed = Math.max(0, num(hours));
  if (!elapsed) return current;
  const growth = config?.growthPerHour ?? {};
  const halfLives = config?.halfLifeHours ?? {};
  const next = {};
  for (const key of DESIRE_KEYS) {
    if (key !== 'attention' && current[key] === 0) {
      next[key] = 0;
      continue;
    }
    const linear = current[key] + elapsed * Math.max(0, num(growth[key]));
    const halfLife = num(halfLives[key]);
    const saturation = halfLife > 0 ? 1 - (1 - current[key]) * Math.pow(0.5, elapsed / halfLife) : linear;
    next[key] = clamp(Math.max(linear, saturation), 0, 1);
  }
  return clampDesires(next);
}

/** 对话后的确定性消解。D2 会在此基础上合并 LLM 增量。 */
export function settleDesiresFromTurns(desires = {}, turns = [], config = PARAMS.desire) {
  const next = clampDesires(desires);
  const userText = turns.filter((t) => t?.role === 'user').map((t) => String(t?.content ?? '').trim()).filter(Boolean).join('\n');
  if (!userText) return next;
  const dismissive = /^(嗯+|哦+|好吧|行吧|知道了|呵呵|随便)[。.!！?？~～]*$/u.test(userText.trim());
  const thoughtful = userText.length >= (config?.thoughtfulMinChars ?? 12) && !dismissive;
  const care = /(辛苦|抱抱|心疼|还好吗|怎么了|不舒服|照顾|别难过)/u.test(userText);
  const reassurance = /(对不起|抱歉|不会忘|在乎你|喜欢你|爱你|我在|陪你)/u.test(userText);
  if (dismissive) {
    next.attention += config?.dismissiveAttentionGain ?? 0.08;
    next.security += config?.dismissiveSecurityGain ?? 0.06;
  } else {
    next.attention -= thoughtful ? (config?.thoughtfulAttentionRelief ?? 0.55) : (config?.replyAttentionRelief ?? 0.22);
    if (thoughtful) next.sharing -= config?.thoughtfulSharingRelief ?? 0.35;
  }
  if (care) next.comfort -= config?.careComfortRelief ?? 0.6;
  if (reassurance) next.security -= config?.reassuranceSecurityRelief ?? 0.6;
  return clampDesires(next);
}

export function accumulateDesires(desires = {}, event = {}) {
  const next = clampDesires(desires);
  const delta = event?.desires ?? event;
  for (const key of DESIRE_KEYS) next[key] += num(delta?.[key]);
  return clampDesires(next);
}

export function applyDesireDeltas(desires = {}, deltas = {}, maxStep = PARAMS.state.maxStepPerTurn) {
  const limited = {};
  for (const key of DESIRE_KEYS) limited[key] = clamp(num(deltas?.[key]), -maxStep, maxStep);
  return accumulateDesires(desires, limited);
}

/** 只把越过阈值的需求翻译成表现指引，不向模型暴露数值。 */
export function toDesirePrompt(desires, config = PARAMS.desire) {
  if (!desires) return '';
  const d = clampDesires(desires);
  const threshold = clamp(num(config?.promptThreshold, 0.55), 0, 1);
  const lines = [];
  if (d.attention >= threshold) lines.push('你这几天没被好好关注，想从对方那里得到一点确认；可以嘴硬地求关注一点，别直接索取，也别说「你是不是把我忘了」这类太破功的台词除非真的很久没聊。');
  if (d.sharing >= threshold) lines.push('你心里攒着一件很想和对方分享的事；找自然时机像真忍不住那样提一句，别硬转话题。');
  if (d.comfort >= threshold) lines.push('你现在有些想被安慰和照顾；可以稍微露出脆弱，给对方机会，但不要情绪勒索，也别自我诊断「我需要安慰」。');
  if (d.security >= threshold) lines.push('你对这段关系有一点不踏实，想听到在乎；语气可以试探，别逼对方证明感情，也别念「给我一点安全感」。');
  return lines.length ? `【你此刻没有直说的需要（内部指引，别复述）】\n${lines.join('\n')}` : '';
}

export async function readDesires(userId, companionId = 'default') {
  if (!userId) return { ...defaultDesires(), updated_at: null };
  const { data, error } = await supabase.from('affective_state').select('desires, updated_at').eq('user_id', userId).eq('companion_id', companionId).maybeSingle();
  if (error || !data) return { ...defaultDesires(), updated_at: null };
  // 需求用自己的时间锚，避免需求写入重置 mood/relationship 的衰减时钟。
  return { ...clampDesires(data.desires), updated_at: data.desires?.updated_at ?? data.updated_at };
}

export async function writeDesires(userId, companionId = 'default', desires, now = Date.now()) {
  if (!userId) throw new Error('writeDesires 需要 userId');
  const value = clampDesires(desires);
  const desireUpdatedAt = new Date(now).toISOString();
  const row = { user_id: userId, companion_id: companionId, desires: { ...value, updated_at: desireUpdatedAt } };
  const { error } = await supabase.from('affective_state').upsert(row, { onConflict: 'user_id,companion_id' });
  if (error) throw error;
  return { ...value, updated_at: desireUpdatedAt };
}

export class DesireDimension {
  constructor({ userId, companionId = 'default', read = readDesires, write = writeDesires, now = () => Date.now(), config = PARAMS.desire } = {}) {
    Object.assign(this, { userId, companionId, read, write, now, config });
  }
  async snapshot() {
    const stored = this.userId ? await this.read(this.userId, this.companionId) : { ...defaultDesires(), updated_at: null };
    const hours = stored.updated_at ? Math.max(0, (this.now() - new Date(stored.updated_at).getTime()) / HOUR) : 0;
    return evolveDesiresOverTime(stored, hours, this.config);
  }
  async evolve(turns = [], ctx = {}) {
    let next = settleDesiresFromTurns(await this.snapshot(), turns, this.config);
    if (ctx.deltas) next = applyDesireDeltas(next, ctx.deltas, ctx.maxStep);
    if (this.userId) await this.write(this.userId, this.companionId, next, this.now());
    return next;
  }
  async accumulate(event = {}) {
    const next = accumulateDesires(await this.snapshot(), event);
    if (this.userId) await this.write(this.userId, this.companionId, next, this.now());
    return next;
  }
  toPrompt(desires) { return toDesirePrompt(desires, this.config); }
}

function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
