// A1 · 外貌/自拍 · 策略(纯逻辑) + 门面(IO)。
//
// 自拍【被状态触发, 不是随机/有求必应】(见 appearance-life-design.md 关键原则④):
//   - 主动发: 关系够亲密 + 正向情境(心情好/刚健身完) + 冷却未到; 生病/低落不主动。
//   - 被要求: ctx.requested 放行(仍受冷却约束)。
// 门面 selfie() 先查图库命中(按状态 tags), miss 再调出图 provider 生成并入库。异步, 不阻塞对话。

import { supabase, PARAMS } from '../config.js';
import { defaultImageProvider } from './provider.js';

const DAY = 24 * 60 * 60 * 1000;

// ============================================================
//  纯逻辑 (无 IO, 离线可测)
// ============================================================

/**
 * 从状态快照 + 情境判断此刻该不该发自拍。
 * @param snapshot stateLayer.snapshot() 的结果 { emotion:{valence,warmth}, life:{energy,health,current_activity,...} }
 * @param ctx { requested?: 用户是否明确要看, rateState?: 自拍发送轨迹 }
 * @returns { ok:boolean, reason:string }
 */
export function shouldSendSelfie(snapshot, ctx = {}, now = Date.now(), policy = {}) {
  const p = { ...PARAMS.appearance, ...policy };
  const emotion = snapshot?.emotion ?? {};
  const life = snapshot?.life ?? {};

  // 冷却永远先判 (被要求也不能刷屏)
  const cool = canSendSelfie(ctx.rateState ?? {}, now, p.selfie);
  if (!cool.ok) return { ok: false, reason: cool.reason };

  // 生病时不发自拍 (憔悴, 也不想被看到)
  if (isSickLife(life, now)) return { ok: false, reason: 'sick' };

  // 被明确要求: 放行
  if (ctx.requested) return { ok: true, reason: 'requested' };

  // 主动发: 关系要够亲密
  const closeness = num(emotion.warmth, 0);
  if (closeness < p.minClosenessForSelfie) return { ok: false, reason: 'not_close_enough' };

  // 正向情境才主动: 心情好, 或刚健身完
  const happy = num(emotion.valence, 0) > 0.3;
  const postWorkout = /健身/.test(String(life.current_activity ?? ''));
  if (happy || postWorkout) return { ok: true, reason: postWorkout ? 'post_workout' : 'good_mood' };

  return { ok: false, reason: 'no_trigger' };
}

/** 自拍冷却 (仿 scheduler.canSendProactive): minInterval + maxPerDay。 */
export function canSendSelfie(rateState = {}, now = Date.now(), policy = {}) {
  const p = { ...PARAMS.appearance.selfie, ...policy };
  const sent = (rateState.sentAt ?? [])
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t) && t <= now);
  const last = sent.at(-1);
  const minGap = Math.max(0, Number(p.minIntervalMinutes) || 0) * 60 * 1000;
  if (last != null && now - last < minGap) return { ok: false, reason: 'cooldown' };
  const since = now - DAY;
  if (sent.filter((t) => t >= since).length >= p.maxPerDay) return { ok: false, reason: 'daily_limit' };
  return { ok: true, reason: 'ok' };
}

/**
 * 把状态快照 + 角色外貌描述拼成出图 prompt, 并产出一组状态 tags(给图库命中复用)。
 * @param appearance CompanionConfig.appearance 文本 (五官/发型/穿着的固定描述)
 * @returns { prompt:string, tags:string[] }
 */
export function buildSelfiePrompt(snapshot, appearance = '', now = Date.now()) {
  const emotion = snapshot?.emotion ?? {};
  const life = snapshot?.life ?? {};
  const tags = [];
  const mods = [];

  if (isSickLife(life, now)) {
    tags.push('sick');
    mods.push('脸色有些憔悴、没什么精神、像是生病了');
  } else if (/健身/.test(String(life.current_activity ?? ''))) {
    tags.push('post-workout');
    mods.push('刚健身完, 微微出汗、运动装、气色红润');
  }
  if (num(emotion.valence, 0) > 0.3) {
    tags.push('happy');
    mods.push('笑容明媚、心情很好');
  } else if (num(emotion.valence, 0) < -0.2) {
    tags.push('low');
    mods.push('表情有点淡淡的、没什么精神');
  }
  // 作息: 晚上居家
  const hour = new Date(now).getHours();
  if (hour >= 21 || hour < 7) {
    tags.push('home');
    mods.push('在家、居家穿着、灯光柔和');
  }
  if (tags.length === 0) tags.push('default');
  tags.unshift('selfie'); // 区分自拍 vs 随手拍, 给图库命中分桶

  const base = appearance ? appearance.trim() : '一个年轻女生';
  const prompt = [base, ...mods, '自拍视角, 自然真实'].join(', ');
  return { prompt, tags };
}

// 当下活动 → "她看到的世界" (随手拍的题材)。命中才返回, 否则 null (没什么好拍的)。
const SCENE_BY_ACTIVITY = [
  { re: /公园|散步|遛|户外|外面|逛/, scene: '公园里的风景, 也许还有一只可爱的狗狗', tag: 'park' },
  { re: /健身/, scene: '健身房一角 / 运动后的天空', tag: 'gym' },
  { re: /咖啡|奶茶/, scene: '咖啡馆的拿铁拉花和窗边光线', tag: 'cafe' },
  { re: /吃|饭|晚饭|午饭|做饭/, scene: '刚做好/点的一桌好吃的', tag: 'food' },
  { re: /追剧|看书|在家|手机|沙发/, scene: '窝在家里的小角落, 也许有只赖着的猫', tag: 'home-pet' },
  { re: /旅行|出差|路上|地铁|赶车/, scene: '路上看到的街景', tag: 'street' },
];

/**
 * 随手拍: 把当下活动拼成"她看到的东西"的出图 prompt + tags。没有合适题材时返回 null。
 * @returns { prompt, tags } | null
 */
export function buildScenePrompt(snapshot, now = Date.now()) {
  const life = snapshot?.life ?? {};
  if (isSickLife(life, now)) return null; // 病着不会出去拍风景
  const activity = String(life.current_activity ?? '');
  const hit = SCENE_BY_ACTIVITY.find((s) => s.re.test(activity));
  if (!hit) return null;
  return { prompt: `${hit.scene}, 随手拍, 生活感, 没有人物`, tags: ['scene', hit.tag] };
}

/**
 * 统一决策: 此刻要不要拍照分享, 拍哪种(selfie 自拍 / scene 随手拍)。
 * - 被点名要看她 → selfie。
 * - 冷却未过 → 不发。
 * - 在外面/有好题材 → scene (门槛低, "你看我遇到只狗")。
 * - 否则够亲密 + 正向情境 → selfie。
 * @returns { ok, kind?: 'selfie'|'scene', reason }
 */
export function decidePhoto(snapshot, ctx = {}, now = Date.now(), policy = {}) {
  const p = { ...PARAMS.appearance, ...policy };
  const cool = canSendSelfie(ctx.rateState ?? {}, now, p.selfie);
  if (!cool.ok) return { ok: false, reason: cool.reason };

  // 被明确要求看她本人 → 自拍 (生病也不发自拍, 交给 shouldSendSelfie 判)
  if (ctx.requested) {
    const s = shouldSendSelfie(snapshot, ctx, now, policy);
    return s.ok ? { ok: true, kind: 'selfie', reason: 'requested' } : { ok: false, reason: s.reason };
  }

  // 随手拍: 有好题材就分享 (亲密度门槛更低 —— 分享一只狗不需要多熟)
  const scene = buildScenePrompt(snapshot, now);
  const warmth = num(snapshot?.emotion?.warmth, 0);
  if (scene && warmth >= p.minClosenessForScene) {
    return { ok: true, kind: 'scene', reason: 'saw_something' };
  }

  // 否则走主动自拍 (亲密度高 + 心情好/刚健身)
  const s = shouldSendSelfie(snapshot, ctx, now, policy);
  return s.ok ? { ok: true, kind: 'selfie', reason: s.reason } : { ok: false, reason: s.reason };
}

// ============================================================
//  IO 门面
// ============================================================

/** 自拍门面: 查图库命中 → miss 则调 provider 生成并入库。 */
export class Selfie {
  constructor({ userId, companionId = 'default', provider = defaultImageProvider, read = readAppearanceAssets, write = insertAppearanceAsset } = {}) {
    this.userId = userId;
    this.companionId = companionId;
    this.provider = provider;
    this.read = read;
    this.write = write;
  }

  /**
   * 产出一张照片 (异步, 调用方 fire-and-forget; 不进 reply 同步路径)。
   * @param snapshot stateLayer 快照
   * @param opts { kind:'selfie'|'scene', appearance, now, seed }
   * @returns { url, tags, kind, cached, seed } | null (scene 无合适题材时返回 null)
   */
  async photo(snapshot, opts = {}) {
    const now = opts.now ?? Date.now();
    const kind = opts.kind ?? 'selfie';
    const built = kind === 'scene' ? buildScenePrompt(snapshot, now) : buildSelfiePrompt(snapshot, opts.appearance ?? '', now);
    if (!built) return null; // scene 没题材
    const { prompt, tags } = built;

    // 先查图库: 同 kind/状态 tags 命中过就复用 (省一次出图)
    const hit = await this.read(this.userId, this.companionId, { tags }).catch(() => null);
    if (hit) return { url: hit.url, tags, kind, cached: true, seed: hit.seed ?? null };

    const img = await this.provider.generate(prompt, { seed: opts.seed });
    await this.write(this.userId, this.companionId, { url: img.url, tags, prompt, seed: img.seed, meta: { ...img.meta, kind } }).catch(() => {});
    return { url: img.url, tags, kind, cached: false, seed: img.seed };
  }

  /** 自拍 (= photo({kind:'selfie'})); 保留旧名便于直接调用。 */
  async selfie(snapshot, opts = {}) {
    return this.photo(snapshot, { ...opts, kind: 'selfie' });
  }

  /** 取冷却用的发送轨迹 (图库 created_at)。封装成方法便于注入/测试。 */
  async rateState(opts = {}) {
    return recentPhotoRateState(this.userId, this.companionId, opts);
  }
}

// ---- IO: appearance_assets 图库 ----

/** 按状态 tags 查最近一张命中的自拍 (tags 数组重叠)。 */
export async function readAppearanceAssets(userId, companionId = 'default', { tags = [], limit = 1 } = {}) {
  let q = supabase
    .from('appearance_assets')
    .select('id, url, tags, seed, created_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId);
  if (tags.length) q = q.overlaps('tags', tags);
  q = q.order('created_at', { ascending: false }).limit(limit);
  const { data, error } = await q;
  if (error || !data || data.length === 0) return null;
  return data[0];
}

/** 取最近发过的照片时间(图库 created_at 当作发送轨迹, 给冷却用), 返回 {sentAt:[...]}。 */
export async function recentPhotoRateState(userId, companionId = 'default', { sinceMs = 2 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const { data, error } = await supabase
    .from('appearance_assets')
    .select('created_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .gte('created_at', new Date(now - sinceMs).toISOString())
    .order('created_at', { ascending: true });
  if (error || !data) return { sentAt: [] };
  return { sentAt: data.map((r) => r.created_at) };
}

/** 入库一张新生成的照片(自拍/随手拍)。 */
export async function insertAppearanceAsset(userId, companionId = 'default', asset = {}) {
  const row = {
    user_id: userId,
    companion_id: companionId,
    url: asset.url,
    tags: asset.tags ?? [],
    prompt: asset.prompt ?? null,
    seed: asset.seed != null ? String(asset.seed) : null,
    meta: asset.meta ?? {},
  };
  const { data, error } = await supabase.from('appearance_assets').insert(row).select().single();
  if (error) throw error;
  return data;
}

// ---- helpers ----
function num(v, d = 0) {
  const n = Number(v);
  return Number.isNaN(n) ? d : n;
}
function isSickLife(life, now) {
  return !!life?.sick_until && new Date(life.sick_until).getTime() > now;
}
