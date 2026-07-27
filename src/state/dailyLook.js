/**
 * 每日穿搭：从衣橱 look + 包柜/鞋柜等抽屉组合「今日一套」，
 * 并支持生成人像成片（lookbook）入库。
 */

import { PARAMS } from '../params.js';
import {
  OUTFIT_CONTEXTS,
  attachDefaultLingerie,
  clampOutfitState,
  inferOutfitContext,
  inferSeason,
  normalizeLook,
  normalizeWardrobe,
  pickOutfit,
  piecesToSummary,
  sanitizeOutfitForImage,
} from './outfit.js';
import { buildUnifiedLookPrompt, imageQualityGate } from '../appearance/selfie.js';

/** 本地日历日 YYYY-MM-DD（相对时区偏移，默认东八区） */
export function localDayKey(now = Date.now(), tzOffsetMinutes = 480) {
  const ms = Number(now) || Date.now();
  const offset = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : 480;
  const d = new Date(ms + offset * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dailyAlbumCardId(dailyKey) {
  return `album:daily:${String(dailyKey || '').slice(0, 16)}`;
}

/** 字符串 → 可复现 [0,1) 随机源 */
export function seedRng(seed = '') {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
}

function asDrawerItems(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item, i) => {
      if (typeof item === 'string') {
        const label = item.trim();
        return label ? { id: `item${i}`, label, contexts: [] } : null;
      }
      if (!item || typeof item !== 'object') return null;
      const label = String(item.label ?? item.name ?? item.title ?? '').trim();
      if (!label) return null;
      return {
        id: String(item.id ?? `item${i}`).slice(0, 40),
        label: label.slice(0, 120),
        contexts: Array.isArray(item.contexts) ? item.contexts : [],
        kind: item.kind || '',
        heel: item.heel || null,
      };
    })
    .filter(Boolean);
}

function filterByContext(items, context) {
  const ctx = OUTFIT_CONTEXTS.includes(context) ? context : 'home';
  const hit = items.filter((x) => !x.contexts?.length || x.contexts.includes(ctx));
  return hit.length ? hit : items;
}

function pickItem(items, rng, context) {
  const pool = filterByContext(items, context);
  if (!pool.length) return null;
  const i = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[i];
}

/**
 * 从抽屉补全/轮换包、鞋、表、珠宝（衣服底装仍以 look 为准）。
 */
export function enrichLookFromDrawers(look, wardrobe, {
  context = null,
  dailyKey = '',
  rotateAccessories = true,
  rng = null,
} = {}) {
  const L = normalizeLook(look);
  if (!L) return null;
  const cat = normalizeWardrobe(wardrobe);
  const ctx = OUTFIT_CONTEXTS.includes(context || L.context) ? (context || L.context) : 'home';
  const rand = rng || seedRng(`${dailyKey}|${L.id}|enrich`);
  const pieces = { ...(L.pieces || {}) };
  const composedFrom = { lookId: L.id };

  const bags = asDrawerItems(cat.bags);
  const shoes = asDrawerItems(cat.shoes);
  const watches = asDrawerItems(cat.watches);
  const jewelry = asDrawerItems(cat.jewelry);

  const needBag = !pieces.bag || rotateAccessories;
  if (needBag && bags.length) {
    const bag = pickItem(bags, rand, ctx);
    if (bag) {
      pieces.bag = bag.label;
      composedFrom.bag = bag.id || bag.label;
    }
  } else if (pieces.bag) {
    composedFrom.bag = pieces.bag;
  }

  const needShoes = !pieces.shoes || /赤脚|光脚|barefoot/i.test(String(pieces.shoes)) || rotateAccessories;
  if (needShoes && shoes.length) {
    // 情境启发式：职场偏低跟/乐福，约会细跟，运动球鞋
    let shoePool = filterByContext(shoes, ctx);
    if (ctx === 'work') {
      const pref = shoePool.filter((s) => /loafer|low|低跟|中跟|slingback|乐福|ballet|平底/i.test(`${s.kind} ${s.heel} ${s.label}`));
      if (pref.length) shoePool = pref;
    } else if (ctx === 'date') {
      const pref = shoePool.filter((s) => /heel|细跟|高跟|红底|Manolo|Louboutin|Jimmy/i.test(`${s.kind} ${s.heel} ${s.label}`));
      if (pref.length) shoePool = pref;
    } else if (ctx === 'sport') {
      const pref = shoePool.filter((s) => /sneaker|跑|运动|Nike|球鞋/i.test(`${s.kind} ${s.label}`));
      if (pref.length) shoePool = pref;
    } else if (ctx === 'home' || ctx === 'sleep' || ctx === 'sick') {
      const pref = shoePool.filter((s) => /mule|拖鞋|家居|sandal|Oran|平底|ballet/i.test(`${s.kind} ${s.label}`));
      if (pref.length) shoePool = pref;
    }
    const shoe = pickItem(shoePool, rand, ctx);
    if (shoe) {
      pieces.shoes = shoe.label;
      composedFrom.shoes = shoe.id || shoe.label;
    }
  } else if (pieces.shoes) {
    composedFrom.shoes = pieces.shoes;
  }

  if ((!pieces.watch || rotateAccessories) && watches.length && ['work', 'date', 'outing'].includes(ctx)) {
    const w = pickItem(watches, rand, ctx);
    if (w) {
      pieces.watch = w.label;
      composedFrom.watch = w.id || w.label;
    }
  } else if (pieces.watch) {
    composedFrom.watch = pieces.watch;
  }

  if ((!pieces.jewelry || rotateAccessories) && jewelry.length && ['date', 'outing', 'work'].includes(ctx)) {
    const j = pickItem(jewelry, rand, ctx);
    if (j) {
      pieces.jewelry = j.label;
      composedFrom.jewelry = j.id || j.label;
    }
  } else if (pieces.jewelry) {
    composedFrom.jewelry = Array.isArray(pieces.jewelry) ? pieces.jewelry.join('、') : pieces.jewelry;
  }

  const withLg = attachDefaultLingerie({ ...L, context: ctx, pieces }, cat.lingerie) || { ...L, context: ctx, pieces };
  const summary = piecesToSummary(withLg.pieces) || withLg.summary;
  return {
    look: normalizeLook({
      ...withLg,
      context: ctx,
      summary,
      pieces: withLg.pieces,
    }),
    composedFrom,
  };
}

/**
 * 组合今日主 look：pickOutfit + 抽屉补全。
 */
export function composeDailyLook({
  wardrobe = null,
  context = 'home',
  season = null,
  now = Date.now(),
  avoidLookId = null,
  preferLookId = null,
  dailyKey = null,
  rotateAccessories = true,
  rng = null,
} = {}) {
  const cat = normalizeWardrobe(wardrobe);
  const dayKey = dailyKey || localDayKey(now);
  const ctx = OUTFIT_CONTEXTS.includes(context) ? context : 'home';
  const seasonNow = season || inferSeason(now);
  const rand = rng || seedRng(`${dayKey}|${ctx}|compose`);

  const base = pickOutfit(cat, ctx, {
    preferId: preferLookId,
    avoidId: avoidLookId,
    rng: rand,
    season: seasonNow,
    now,
  });
  const enriched = enrichLookFromDrawers(base, cat, {
    context: ctx,
    dailyKey: dayKey,
    rotateAccessories,
    rng: rand,
  });
  return {
    look: enriched.look,
    composedFrom: enriched.composedFrom,
    dailyKey: dayKey,
    context: ctx,
    summary: enriched.look?.summary || '',
  };
}

/**
 * 若跨日或无 current，则组合今日装并写入 meta。
 * 同日已有 daily_key + current 则原样返回（保留 daily_photo）。
 */
export function ensureDailyLookState(state, {
  wardrobe = null,
  life = null,
  intimacy = null,
  now = Date.now(),
  config = PARAMS.outfit,
  force = false,
} = {}) {
  const dl = config?.dailyLook || {};
  if (dl.enabled === false || dl.autoCompose === false) {
    return { state: clampOutfitState(state), composed: false };
  }
  const tz = dl.timezoneOffsetMinutes ?? PARAMS.timezoneOffsetMinutes ?? 480;
  const dayKey = localDayKey(now, tz);
  const cur = clampOutfitState(state);

  if (!force && cur.daily_key === dayKey && cur.current) {
    return { state: cur, composed: false };
  }

  const hour = new Date(now).getHours();
  const ctx = inferOutfitContext({ hour, life, intimacy, now });
  const composed = composeDailyLook({
    wardrobe,
    context: ctx,
    now,
    avoidLookId: cur.current?.id,
    dailyKey: dayKey,
    rotateAccessories: dl.rotateAccessories !== false,
  });
  const stamp = new Date(now).toISOString();
  const next = clampOutfitState({
    current: composed.look,
    context: composed.context,
    changed_at: stamp,
    updated_at: stamp,
    daily_key: dayKey,
    composed_from: composed.composedFrom,
    daily_photo: null,
  });
  return { state: next, composed: true, dailyKey: dayKey };
}

export function shouldGenerateDailyPhoto(outfit, { force = false } = {}) {
  const o = clampOutfitState(outfit);
  if (!o.current?.summary) return { ok: false, reason: 'no_outfit' };
  if (!o.daily_key) return { ok: false, reason: 'no_daily_key' };
  if (!force && o.daily_photo?.url && o.daily_photo?.at) {
    return { ok: false, reason: 'already', url: o.daily_photo.url, albumCardId: o.daily_photo.albumCardId };
  }
  return { ok: true, reason: 'need', dailyKey: o.daily_key };
}

export function shouldShareDailyPhoto(outfit, { force = false } = {}) {
  const o = clampOutfitState(outfit);
  if (!o.daily_photo?.url) return { ok: false, reason: 'no_photo' };
  if (!force && o.daily_photo.sharedAt) return { ok: false, reason: 'already_shared' };
  return { ok: true, url: o.daily_photo.url, reason: 'share' };
}

/**
 * 构建今日成片 prompt（人像 lookbook，非单品）。
 */
export function buildDailyLookPrompt(snapshot, appearance = '', now = Date.now(), { hasReferences = false } = {}) {
  // 出图前剥离内衣字段，避免 gpt-image 以 sexual 拒图
  const safeSnap = {
    ...(snapshot || {}),
    outfit: sanitizeOutfitForImage(snapshot?.outfit),
  };
  return buildUnifiedLookPrompt(safeSnap, appearance, now, { kind: 'lookbook', hasReferences });
}

/**
 * 生成今日成片（依赖注入，便于测试与 server/orchestrator 复用）。
 *
 * @param deps.provider  { generate, edit? }
 * @param deps.getReferences () => [{path,mime,name}]
 * @param deps.saveAlbum? (cardId, { url, prompt, mime, base64 }) => Promise<{ok, imageUrl?}>
 * @param deps.writeAppearance? (asset) => Promise
 * @param deps.writeOutfit? (outfit) => Promise
 */
export async function generateDailyLookPhoto({
  outfit,
  appearance = '',
  snapshot = null,
  now = Date.now(),
  force = false,
  provider = null,
  getReferences = () => [],
  saveAlbum = null,
  writeAppearance = null,
  writeOutfit = null,
  config = PARAMS.outfit,
} = {}) {
  const dl = config?.dailyLook || {};
  if (dl.enabled === false) return { ok: false, reason: 'disabled' };

  let o = clampOutfitState(outfit);
  const need = shouldGenerateDailyPhoto(o, { force });
  if (!need.ok) {
    return {
      ok: need.reason === 'already',
      skipped: true,
      reason: need.reason,
      url: need.url || o.daily_photo?.url || null,
      albumCardId: need.albumCardId || o.daily_photo?.albumCardId || null,
      outfit: o,
    };
  }

  const snap = {
    ...(snapshot || {}),
    outfit: o,
  };
  const refs = typeof getReferences === 'function' ? getReferences() || [] : [];
  const hasReferences = refs.length > 0;
  const built = buildDailyLookPrompt(snap, appearance, now, { hasReferences });
  const gate = imageQualityGate({
    prompt: built.prompt,
    appearance,
    kind: 'lookbook',
    hasReferences,
  });
  if (!gate.ok) return { ok: false, reason: `quality_gate:${gate.reason}`, outfit: o };

  if (!provider || typeof provider.generate !== 'function') {
    return { ok: false, reason: 'no_provider', outfit: o };
  }

  const providerOpts = {
    seed: `${o.daily_key}|${o.current?.id || 'look'}`,
    // 日更：最多 2 张脸参考 + 4 分钟超时（实测 gpt-image 全身常要 1.5～2.5 分钟）
    maxReferences: 2,
    timeoutMs: 240_000,
  };
  let img = null;
  let usedEdit = false;
  if (refs.length && typeof provider.edit === 'function') {
    try {
      img = await provider.edit(built.prompt, refs.slice(0, 2), providerOpts);
      usedEdit = true;
    } catch (error) {
      // 参考图编辑易因体积/网络 fetch failed；降级为纯文生图，保证能出片
      console.error('[dailyLook] edit failed, fallback generate:', error?.message || error);
      img = await provider.generate(built.prompt, providerOpts).catch((e2) => {
        throw new Error(
          `脸参考生成失败且纯生成也失败: ${error?.message || error} | ${e2?.message || e2}`,
        );
      });
    }
  } else {
    img = await provider.generate(built.prompt, providerOpts);
  }
  if (!img?.url) return { ok: false, reason: 'generate_failed', outfit: o };
  if (img.meta) img.meta.dailyUsedEdit = usedEdit;

  const albumCardId = dailyAlbumCardId(o.daily_key);
  let publicUrl = img.url;

  if (typeof saveAlbum === 'function') {
    const saved = await saveAlbum(albumCardId, {
      url: img.url,
      prompt: built.prompt,
      seed: img.seed,
      lookSummary: built.lookSummary,
      mime: img.url.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png',
    }).catch(() => null);
    if (saved?.imageUrl) publicUrl = saved.imageUrl;
    else if (saved?.url) publicUrl = saved.url;
  }

  if (typeof writeAppearance === 'function') {
    await writeAppearance({
      url: publicUrl,
      tags: ['daily', 'lookbook', o.daily_key, o.context || 'dressed'].filter(Boolean),
      prompt: built.prompt,
      seed: img.seed,
      meta: {
        kind: 'lookbook',
        dailyKey: o.daily_key,
        albumCardId,
        lookSummary: built.lookSummary,
        composedFrom: o.composed_from,
      },
    }).catch(() => {});
  }

  const stamp = new Date(now).toISOString();
  o = clampOutfitState({
    ...o,
    daily_photo: {
      at: stamp,
      url: publicUrl,
      albumCardId,
      sharedAt: o.daily_photo?.sharedAt || null,
    },
    updated_at: stamp,
  });

  if (typeof writeOutfit === 'function') {
    await writeOutfit(o).catch(() => {});
  }

  return {
    ok: true,
    url: publicUrl,
    albumCardId,
    prompt: built.prompt,
    tags: built.tags,
    lookSummary: built.lookSummary,
    cached: false,
    kind: 'lookbook',
    reason: 'daily_look',
    outfit: o,
  };
}

export function markDailyPhotoShared(outfit, now = Date.now()) {
  const o = clampOutfitState(outfit);
  if (!o.daily_photo?.url) return o;
  return clampOutfitState({
    ...o,
    daily_photo: {
      ...o.daily_photo,
      sharedAt: new Date(now).toISOString(),
    },
  });
}
