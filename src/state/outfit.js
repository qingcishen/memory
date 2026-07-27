// Outfit · 穿搭状态维度。
// 可感知：对方问「今天穿什么」/ 描述外貌 / 自拍出图 都用同一份当前穿搭。
// 不做每件衣服的物理仿真，只维护「此刻穿着 + 衣橱目录 + 随场景切换」。

import { supabase } from '../config.js';
import { PARAMS } from '../params.js';
import { isSick } from './health.js';

const HOUR = 60 * 60 * 1000;

export const OUTFIT_CONTEXTS = ['home', 'work', 'date', 'outing', 'sport', 'sleep', 'intimate', 'sick'];

export function defaultOutfitState(overrides = null) {
  const base = {
    current: null, // { id, context, summary, pieces, style }
    context: 'home',
    changed_at: null,
    updated_at: null,
    daily_key: null,
    composed_from: null,
    daily_photo: null,
  };
  return clampOutfitState(overrides ? { ...base, ...overrides } : base);
}

function clampDailyPhoto(value) {
  if (!value || typeof value !== 'object') return null;
  const url = value.url ? String(value.url).slice(0, 2000) : null;
  if (!url && !value.at) return null;
  return {
    at: value.at ? String(value.at) : null,
    url,
    albumCardId: value.albumCardId ? String(value.albumCardId).slice(0, 80) : null,
    sharedAt: value.sharedAt ? String(value.sharedAt) : null,
  };
}

export function clampOutfitState(value = {}) {
  const ctx = OUTFIT_CONTEXTS.includes(value?.context) ? value.context : 'home';
  const current = normalizeLook(value?.current);
  return {
    current,
    context: current?.context && OUTFIT_CONTEXTS.includes(current.context) ? current.context : ctx,
    changed_at: value?.changed_at ? String(value.changed_at) : null,
    updated_at: value?.updated_at ?? null,
    daily_key: value?.daily_key ? String(value.daily_key).slice(0, 16) : null,
    composed_from: value?.composed_from && typeof value.composed_from === 'object' ? value.composed_from : null,
    daily_photo: clampDailyPhoto(value?.daily_photo),
  };
}

export const OUTFIT_SEASONS = ['spring', 'summer', 'autumn', 'winter'];

/** 按月份推断季节（北半球） */
export function inferSeason(now = Date.now()) {
  const m = new Date(now).getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

export function normalizeLook(look) {
  if (!look || typeof look !== 'object') return null;
  const id = String(look.id ?? '').trim().slice(0, 60) || 'custom';
  const summary = String(look.summary ?? look.label ?? '').trim().slice(0, 200);
  if (!summary && !look.pieces) return null;
  const pieces = normalizePieces(look.pieces);
  const season = OUTFIT_SEASONS.includes(look.season) ? look.season : null;
  return {
    id,
    context: OUTFIT_CONTEXTS.includes(look.context) ? look.context : 'home',
    summary: summary || piecesToSummary(pieces),
    pieces,
    style: String(look.style ?? '').trim().slice(0, 80) || null,
    season,
  };
}

/** 单品字段：衣裤裙鞋 + 内衣 + 包饰 + 美妆护肤（奢侈线角色用品牌名写在字符串里） */
export const PIECE_KEYS = [
  'top', 'bottom', 'dress', 'outer', 'shoes',
  'lingerie', 'bra', 'panties', 'hosiery', // 内衣套装 / 文胸 / 内裤 / 丝袜吊带
  'bag', 'jewelry', 'watch', 'perfume',
  'accessories',
  'hair', 'makeup', 'skincare', 'nails', 'lips', 'eyes',
];

function normalizePieces(pieces) {
  if (!pieces || typeof pieces !== 'object' || Array.isArray(pieces)) return {};
  const out = {};
  for (const k of PIECE_KEYS) {
    if (pieces[k] == null || pieces[k] === '') continue;
    if ((k === 'accessories' || k === 'jewelry') && Array.isArray(pieces[k])) {
      out[k] = pieces[k].map(String).filter(Boolean).slice(0, 8);
    } else {
      out[k] = String(pieces[k]).slice(0, 120);
    }
  }
  // 若只写了 bra+panties 没写 lingerie，拼一套摘要字段方便读取
  if (!out.lingerie && (out.bra || out.panties)) {
    out.lingerie = [out.bra, out.panties].filter(Boolean).join(' + ');
  }
  return out;
}

export function piecesToSummary(pieces = {}) {
  const parts = [];
  if (pieces.dress) parts.push(pieces.dress);
  else {
    if (pieces.top) parts.push(pieces.top);
    if (pieces.bottom) parts.push(pieces.bottom);
  }
  if (pieces.outer) parts.push(pieces.outer);
  if (pieces.shoes) parts.push(pieces.shoes);
  if (pieces.bag) parts.push(pieces.bag);
  // 内衣默认不进对外 summary（避免每套都念内裤）；亲密装再带
  if (pieces.lingerie && /蕾丝|真空|La Perla|Agent|私密|衬衫/.test(String(pieces.lingerie) + String(pieces.top ?? ''))) {
    parts.push(pieces.lingerie);
  }
  if (Array.isArray(pieces.jewelry) && pieces.jewelry.length) parts.push(pieces.jewelry.join('、'));
  else if (pieces.jewelry) parts.push(pieces.jewelry);
  if (pieces.watch) parts.push(pieces.watch);
  if (Array.isArray(pieces.accessories) && pieces.accessories.length) parts.push(pieces.accessories.join('、'));
  if (pieces.makeup) parts.push(pieces.makeup);
  if (pieces.perfume) parts.push(pieces.perfume);
  return parts.join('，') || '高级简约装扮';
}

/** 内衣抽屉：日常款 + 精致款 + 私密款，全是一线 */
export function normalizeLingerieDrawer(raw = null) {
  if (!Array.isArray(raw) || !raw.length) return defaultLingerieDrawer();
  return raw
    .map((item, i) => {
      if (typeof item === 'string') {
        return { id: `lg${i}`, label: item, kind: 'set', brand: '', contexts: ['home', 'work', 'outing'] };
      }
      if (!item || typeof item !== 'object') return null;
      const label = String(item.label ?? item.name ?? item.set ?? '').trim();
      if (!label) return null;
      return {
        id: String(item.id ?? `lg${i}`).slice(0, 40),
        label: label.slice(0, 100),
        kind: ['set', 'bra', 'panties', 'hosiery', 'bodysuit'].includes(item.kind) ? item.kind : 'set',
        brand: String(item.brand ?? '').slice(0, 40),
        bra: item.bra ? String(item.bra).slice(0, 80) : null,
        panties: item.panties ? String(item.panties).slice(0, 80) : null,
        color: item.color ? String(item.color).slice(0, 30) : null,
        contexts: Array.isArray(item.contexts)
          ? item.contexts.filter((c) => OUTFIT_CONTEXTS.includes(c)).slice(0, 6)
          : ['home'],
        notes: item.notes ? String(item.notes).slice(0, 120) : '',
      };
    })
    .filter(Boolean)
    .slice(0, 40);
}

export function defaultLingerieDrawer() {
  return [
    { id: 'daily_nude_set', label: 'La Perla 裸色无痕套装', kind: 'set', brand: 'La Perla', bra: '无痕软钢圈', panties: '同色三角/平角', color: '裸粉', contexts: ['work', 'outing', 'home'], notes: '日常隐形，外穿不露痕' },
    { id: 'daily_black_set', label: 'La Perla 黑色基础套装', kind: 'set', brand: 'La Perla', bra: '简约黑', panties: '低腰三角', color: '黑', contexts: ['work', 'outing', 'date'] },
    { id: 'sport_set', label: 'Lululemon 运动内衣 + 内裤', kind: 'set', brand: 'Lululemon', bra: '运动内衣', panties: '运动款', contexts: ['sport'] },
    { id: 'silk_sleep', label: '真丝睡眠内衣/短裤', kind: 'set', brand: 'Olivia von Halle', contexts: ['sleep', 'home'], notes: '睡觉舒适' },
    { id: 'lace_black', label: 'La Perla 黑色蕾丝套装', kind: 'set', brand: 'La Perla', bra: '蕾丝文胸', panties: '蕾丝丁字/三角', color: '黑', contexts: ['date', 'intimate'], notes: '约会或私密' },
    { id: 'lace_wine', label: 'Agent Provocateur 酒红蕾丝', kind: 'set', brand: 'Agent Provocateur', color: '酒红', contexts: ['intimate', 'date'] },
    { id: 'bodysuit_black', label: 'Wolford / La Perla 黑色连体衣', kind: 'bodysuit', brand: 'Wolford', contexts: ['date', 'outing'], notes: '外搭西装或裙装' },
    { id: 'hosiery_sheer', label: 'Wolford 薄透丝袜', kind: 'hosiery', brand: 'Wolford', contexts: ['work', 'date'], notes: '裙装时' },
    { id: 'garter', label: '吊带袜套装', kind: 'hosiery', brand: 'Agent Provocateur', contexts: ['intimate'], notes: '私密场合' },
    { id: 'none', label: '真空', kind: 'set', brand: '', contexts: ['intimate', 'home'], notes: '只穿他衬衫时' },
  ];
}

/** 按情境给 look 补默认内衣（未写 bra/panties/lingerie 时） */
export function attachDefaultLingerie(look, lingerieDrawer = null) {
  const L = normalizeLook(look);
  if (!L) return null;
  const pieces = { ...(L.pieces || {}) };
  if (pieces.lingerie || pieces.bra || pieces.panties) return L;
  const drawer = normalizeLingerieDrawer(lingerieDrawer);
  const ctx = L.context || 'home';
  const pool = drawer.filter((x) => (x.contexts || []).includes(ctx));
  const pick = (pool.length ? pool : drawer)[0];
  if (pick) {
    if (pick.kind === 'set' || pick.kind === 'bodysuit') {
      pieces.lingerie = pick.label;
      if (pick.bra) pieces.bra = pick.bra;
      if (pick.panties) pieces.panties = pick.panties;
    } else if (pick.kind === 'hosiery') {
      pieces.hosiery = pick.label;
    }
  }
  return { ...L, pieces: normalizePieces(pieces) };
}

/** 美妆台/化妆品柜规范化 */
export function normalizeBeautyVanity(raw = null) {
  if (!raw || typeof raw !== 'object') return defaultBeautyVanity();
  const list = (key, fallback) => {
    if (!Array.isArray(raw[key]) || !raw[key].length) return fallback;
    return raw[key].map(String).filter(Boolean).slice(0, 24);
  };
  return {
    skincare: list('skincare', defaultBeautyVanity().skincare),
    base: list('base', defaultBeautyVanity().base),
    eyes: list('eyes', defaultBeautyVanity().eyes),
    lips: list('lips', defaultBeautyVanity().lips),
    nails: list('nails', defaultBeautyVanity().nails),
    fragrance: list('fragrance', defaultBeautyVanity().fragrance),
    tools: list('tools', defaultBeautyVanity().tools),
    travel_mini: list('travel_mini', defaultBeautyVanity().travel_mini),
    notes: String(raw.notes ?? '').slice(0, 240) || defaultBeautyVanity().notes,
  };
}

export function defaultBeautyVanity() {
  return {
    skincare: ['La Mer 精华', 'SK-II 神仙水', 'Sisley 黑玫瑰', 'Clé de Peau 面霜'],
    base: ['Chanel 妆前', 'Clé de Peau 粉底', 'Hourglass 修容', 'Dior 遮瑕'],
    eyes: ['Chanel 眼影盘', 'Dior 睫毛膏', 'Tom Ford 眼线'],
    lips: ['Chanel 唇膏', 'Dior 唇釉', 'Hermès 唇膏'],
    nails: ['Chanel 指甲油', 'Dior 甲油'],
    fragrance: ['Chanel No.5', 'Maison Francis Kurkdjian Baccarat Rouge 540', 'Hermès 大地'],
    tools: ['西门子级洁面仪', '高端吹风机', '专业化妆刷组'],
    travel_mini: [
      'La Mer 精华面霜 旅行装',
      'SK-II 神仙水 小样',
      'CPB 钻光粉底 分装',
      'Chanel 唇膏 1 支',
      '卸妆棉 + 温和卸妆水小支',
      '高倍防晒小支',
    ],
    notes: '只用法式/日系一线贵妇线，不碰杂牌；妆容克制高级，不浓不土。',
  };
}

/** 通用「柜」：字符串或 {id,label,brand,kind,...} */
export function normalizeItemDrawer(raw, { fallback = [], max = 40, kinds = null } = {}) {
  if (!Array.isArray(raw) || !raw.length) {
    return (fallback || []).map((item, i) => (typeof item === 'string'
      ? { id: `item${i}`, label: item, brand: '', kind: 'item', notes: '' }
      : item));
  }
  return raw
    .map((item, i) => {
      if (typeof item === 'string') {
        return { id: `item${i}`, label: item.slice(0, 100), brand: '', kind: 'item', notes: '' };
      }
      if (!item || typeof item !== 'object') return null;
      const label = String(item.label ?? item.name ?? item.title ?? '').trim();
      if (!label) return null;
      const kind = item.kind ? String(item.kind).slice(0, 30) : 'item';
      if (kinds && !kinds.includes(kind)) {
        // 仍接受，方便扩展
      }
      return {
        id: String(item.id ?? `item${i}`).slice(0, 40),
        label: label.slice(0, 100),
        brand: item.brand ? String(item.brand).slice(0, 40) : '',
        kind,
        color: item.color ? String(item.color).slice(0, 30) : null,
        heel: item.heel ? String(item.heel).slice(0, 40) : null,
        material: item.material ? String(item.material).slice(0, 40) : null,
        contexts: Array.isArray(item.contexts)
          ? item.contexts.filter((c) => OUTFIT_CONTEXTS.includes(c)).slice(0, 6)
          : [],
        notes: item.notes ? String(item.notes).slice(0, 120) : '',
      };
    })
    .filter(Boolean)
    .slice(0, max);
}

export function defaultShoesDrawer() {
  return [
    { id: 'heel_manolo_hangisi', label: 'Manolo Blahnik Hangisi 黑缎细跟', brand: 'Manolo Blahnik', kind: 'heel', heel: '细高跟', contexts: ['date', 'work'], notes: '经典晚宴/正装' },
    { id: 'heel_louboutin_so_kate', label: 'Christian Louboutin So Kate 黑红底', brand: 'Christian Louboutin', kind: 'heel', heel: '细高跟 120mm', contexts: ['date'], notes: '高挑红底' },
    { id: 'heel_jc_pump', label: 'Jimmy Choo 黑色经典细跟', brand: 'Jimmy Choo', kind: 'heel', heel: '细高跟', contexts: ['date', 'outing'] },
    { id: 'heel_chanel_slingback', label: 'Chanel 双C 拼色 Slingback', brand: 'Chanel', kind: 'heel', heel: '中细跟', contexts: ['work', 'outing'] },
    { id: 'heel_dior_jadior', label: 'Dior J\'Adior 丝带平底/低跟', brand: 'Dior', kind: 'flat', contexts: ['outing', 'date'] },
    { id: 'heel_hermes_oran', label: 'Hermès Oran 凉鞋 H扣', brand: 'Hermès', kind: 'sandal', contexts: ['outing', 'home'] },
    { id: 'loafer_loro', label: 'Loro Piana Summer Walk 乐福', brand: 'Loro Piana', kind: 'loafer', contexts: ['work', 'outing'] },
    { id: 'loafer_therow', label: 'The Row 简约乐福', brand: 'The Row', kind: 'loafer', contexts: ['outing', 'work'] },
    { id: 'flat_chanel_ballet', label: 'Chanel 双C 芭蕾平底', brand: 'Chanel', kind: 'flat', contexts: ['outing', 'home'] },
    { id: 'boot_therow_ankle', label: 'The Row 短靴', brand: 'The Row', kind: 'boot', contexts: ['outing', 'work'], notes: '秋冬' },
    { id: 'boot_hermes_kelly', label: 'Hermès 短靴（Kelly 扣）', brand: 'Hermès', kind: 'boot', contexts: ['outing', 'date'] },
    { id: 'sneaker_cp', label: 'Common Projects Achilles 小白鞋', brand: 'Common Projects', kind: 'sneaker', contexts: ['outing'] },
    { id: 'sneaker_gg', label: 'Golden Goose 做旧球鞋', brand: 'Golden Goose', kind: 'sneaker', contexts: ['outing'] },
    { id: 'sport_nike', label: 'Nike 限定训练/跑鞋', brand: 'Nike', kind: 'sport', contexts: ['sport'] },
    { id: 'slipper_loro', label: 'Loro Piana 羊绒家居拖鞋', brand: 'Loro Piana', kind: 'slipper', contexts: ['home', 'sleep'] },
    { id: 'heel_jc_sandal', label: 'Jimmy Choo 细跟凉鞋', brand: 'Jimmy Choo', kind: 'sandal', heel: '细高跟', contexts: ['date'] },
  ];
}

export function defaultJewelryDrawer() {
  return [
    { id: 'cartier_love_narrow', label: 'Cartier 窄版 LOVE 手镯 黄金', brand: 'Cartier', kind: 'bracelet' },
    { id: 'cartier_love_white', label: 'Cartier LOVE 白金镶钻', brand: 'Cartier', kind: 'bracelet' },
    { id: 'cartier_juste', label: 'Cartier Juste un Clou 手镯', brand: 'Cartier', kind: 'bracelet' },
    { id: 'vca_alhambra_ear', label: 'Van Cleef 白金四叶草耳钉', brand: 'Van Cleef & Arpels', kind: 'earring' },
    { id: 'vca_alhambra_neck', label: 'Van Cleef 五花四叶草项链', brand: 'Van Cleef & Arpels', kind: 'necklace' },
    { id: 'diamond_studs', label: '经典小钻耳钉', brand: '', kind: 'earring', notes: '日常几乎不摘' },
    { id: 'cartier_clash', label: 'Cartier Clash 耳钉或戒指', brand: 'Cartier', kind: 'earring' },
    { id: 'cartier_trinity', label: 'Cartier Trinity 三环戒', brand: 'Cartier', kind: 'ring' },
    { id: 'hermes_clic', label: 'Hermès Clic H 手镯', brand: 'Hermès', kind: 'bracelet' },
    { id: 'dior_rose', label: 'Dior Rose des Vents 耳饰', brand: 'Dior', kind: 'earring' },
    { id: 'tennis_bracelet', label: '细钻 tennis 手链', brand: '', kind: 'bracelet', notes: '晚宴加持' },
    { id: 'pearl_studs', label: 'Akoya 小珍珠耳钉', brand: '', kind: 'earring', notes: '素净日' },
  ];
}

export function defaultWatchesDrawer() {
  return [
    { id: 'cartier_tank_must', label: 'Cartier Tank Must', brand: 'Cartier', kind: 'watch', notes: '日常主表' },
    { id: 'cartier_tank_lc', label: 'Cartier Tank Louis 小尺寸', brand: 'Cartier', kind: 'watch' },
    { id: 'cartier_ballon', label: 'Cartier Ballon Bleu 小号', brand: 'Cartier', kind: 'watch' },
    { id: 'rolex_lady', label: 'Rolex Lady-Datejust 金钢', brand: 'Rolex', kind: 'watch', notes: '正式场合' },
    { id: 'jlc_reverso', label: 'Jaeger-LeCoultre Reverso 女款', brand: 'Jaeger-LeCoultre', kind: 'watch' },
    { id: 'apple_watch', label: 'Apple Watch 运动/机场', brand: 'Apple', kind: 'sport', contexts: ['sport', 'outing'] },
  ];
}

export function defaultAccessoriesDrawer() {
  return [
    { id: 'hermes_carre', label: 'Hermès 真丝方巾（多色轮换）', brand: 'Hermès', kind: 'scarf', notes: '包柄/颈间/头发' },
    { id: 'hermes_cashmere_shawl', label: 'Hermès / Loro 羊绒大披肩', brand: 'Hermès', kind: 'shawl', contexts: ['outing', 'travel'] },
    { id: 'hermes_belt', label: 'Hermès 皮带 H 扣', brand: 'Hermès', kind: 'belt' },
    { id: 'celine_sunglasses', label: 'Celine 墨镜', brand: 'Celine', kind: 'sunglasses' },
    { id: 'chanel_sunglasses', label: 'Chanel 墨镜', brand: 'Chanel', kind: 'sunglasses' },
    { id: 'dior_sunglasses', label: 'Dior 墨镜', brand: 'Dior', kind: 'sunglasses' },
    { id: 'saint_laurent_sl', label: 'Saint Laurent 猫眼墨镜', brand: 'Saint Laurent', kind: 'sunglasses' },
    { id: 'baseball_cap', label: 'The Row / 极简棒球帽', brand: 'The Row', kind: 'hat', contexts: ['outing'], notes: '机场' },
    { id: 'silk_scrunchie', label: '真丝发圈/发夹组', brand: '', kind: 'hair', notes: '居家与低马尾' },
    { id: 'airpods', label: 'AirPods Pro / Max', brand: 'Apple', kind: 'tech' },
    { id: 'glove_cashmere', label: '羊绒手套', brand: 'Loro Piana', kind: 'glove', notes: '冬季' },
    { id: 'eres_swim', label: 'Eres 泳装（度假）', brand: 'Eres', kind: 'swim', contexts: ['outing'], notes: '旅行度假' },
  ];
}

export function defaultOuterwearDrawer() {
  return [
    { id: 'maxmara_101801', label: 'Max Mara 经典驼大衣 101801', brand: 'Max Mara', kind: 'coat', notes: '冬日门面' },
    { id: 'therow_long_black', label: 'The Row 长款黑大衣', brand: 'The Row', kind: 'coat' },
    { id: 'celine_coat', label: 'Celine 长款大衣', brand: 'Celine', kind: 'coat' },
    { id: 'loro_cashmere_coat', label: 'Loro Piana 羊绒大衣', brand: 'Loro Piana', kind: 'coat' },
    { id: 'bottega_leather', label: 'Bottega Veneta 皮外套', brand: 'Bottega Veneta', kind: 'jacket' },
    { id: 'therow_blazer', label: 'The Row 黑色西装外套', brand: 'The Row', kind: 'blazer', contexts: ['work'] },
    { id: 'loro_cardigan', label: 'Loro Piana 驼羊绒开衫', brand: 'Loro Piana', kind: 'knit', contexts: ['work', 'home'] },
    { id: 'ovh_robe', label: 'Olivia von Halle 丝质晨袍', brand: 'Olivia von Halle', kind: 'robe', contexts: ['home', 'intimate'] },
  ];
}

/** 衣橱目录规范化 */
export function normalizeWardrobe(raw = null) {
  const style = String(raw?.style ?? '高级简约奢侈').slice(0, 120);
  const items = Array.isArray(raw?.wardrobe)
    ? raw.wardrobe.map(normalizeLook).filter(Boolean).slice(0, 80)
    : defaultWardrobeCatalog();
  const defaults = raw?.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  const beauty = normalizeBeautyVanity(raw?.beauty ?? raw?.cosmetics ?? null);
  const bags = Array.isArray(raw?.bags)
    ? raw.bags.map((b) => (typeof b === 'string' ? b : b?.name || b?.label)).filter(Boolean).slice(0, 30)
    : defaultBags();
  const lingerie = normalizeLingerieDrawer(raw?.lingerie ?? raw?.underwear ?? null);
  const shoes = normalizeItemDrawer(raw?.shoes ?? raw?.shoe_closet ?? null, {
    fallback: defaultShoesDrawer(),
    max: 40,
  });
  const jewelry = normalizeItemDrawer(raw?.jewelry ?? raw?.jewellery ?? null, {
    fallback: defaultJewelryDrawer(),
    max: 40,
  });
  const watches = normalizeItemDrawer(raw?.watches ?? raw?.watch_tray ?? null, {
    fallback: defaultWatchesDrawer(),
    max: 20,
  });
  const accessories = normalizeItemDrawer(raw?.accessories ?? raw?.accessory_drawer ?? null, {
    fallback: defaultAccessoriesDrawer(),
    max: 40,
  });
  const outerwear = normalizeItemDrawer(raw?.outerwear ?? raw?.coats ?? null, {
    fallback: defaultOuterwearDrawer(),
    max: 24,
  });
  const travel = normalizeItemDrawer(raw?.travel ?? raw?.luggage ?? null, {
    fallback: defaultTravelDrawer(),
    max: 30,
  });
  const seasonalDefaults =
    raw?.seasonal && typeof raw.seasonal === 'object'
      ? Object.fromEntries(
          OUTFIT_SEASONS.map((s) => [s, raw.seasonal[s] ? String(raw.seasonal[s]).slice(0, 60) : null]).filter(([, v]) => v),
        )
      : {};
  return {
    style,
    wardrobe: items.length ? items : defaultWardrobeCatalog(),
    defaults,
    seasonal: seasonalDefaults,
    beauty,
    bags,
    lingerie,
    shoes,
    jewelry,
    watches,
    accessories,
    outerwear,
    travel,
  };
}

export function defaultTravelDrawer() {
  return [
    { id: 'rimowa_cabin', label: 'Rimowa Essential Cabin 登机箱', brand: 'Rimowa', kind: 'carryon', notes: '短差标配' },
    { id: 'rimowa_checkin', label: 'Rimowa Check-In L 托运', brand: 'Rimowa', kind: 'luggage', notes: '长途' },
    { id: 'tumi_compact', label: 'Tumi 商务登机箱', brand: 'Tumi', kind: 'carryon' },
    { id: 'goyard_boheme', label: 'Goyard Bohème 软托特（舱内）', brand: 'Goyard', kind: 'tote' },
    { id: 'therow_margaux_travel', label: 'The Row Margaux 大号（机场）', brand: 'The Row', kind: 'tote' },
    { id: 'pack_cubes', label: 'Rimowa / 高端收纳袋组', brand: 'Rimowa', kind: 'organizer' },
    { id: 'beauty_mini_lamer', label: '旅行护肤 mini：La Mer + SK-II 小样组', brand: 'La Mer', kind: 'beauty_mini', notes: '精华霜/水/洁面分装' },
    { id: 'beauty_mini_cpb', label: '旅行底妆 mini：CPB 粉底 + Chanel 唇', brand: 'Clé de Peau', kind: 'beauty_mini' },
    { id: 'beauty_mini_spf', label: '旅行防晒 + 卸妆棉巾组', brand: '', kind: 'beauty_mini' },
    { id: 'passport_holder', label: 'Hermès / 极简护照夹套装', brand: 'Hermès', kind: 'document' },
  ];
}

export function defaultBags() {
  return [
    'Hermès Birkin 25 黑金',
    'Hermès Kelly 28',
    'Chanel Classic Flap 中号',
    'Chanel 22 垃圾袋',
    'Dior Book Tote',
    'Bottega Veneta Jodie',
    'The Row Margaux',
    'Celine Triomphe',
    'Saint Laurent Lou Camera',
    'Loewe Puzzle 迷你',
  ];
}

export function defaultWardrobeCatalog() {
  // 兜底目录（有钱线）；角色应以 companions/*/outfit.json 为准
  return [
    {
      id: 'work_board',
      context: 'work',
      style: '职场',
      summary: 'The Row 黑色西装套装，Hermès 丝质衬衫，Chanel 低跟，Cartier 表，妆容克制',
      pieces: {
        top: 'Hermès 白丝衬衫', bottom: 'The Row 黑色西裤', outer: 'The Row 西装外套',
        shoes: 'Chanel 黑色低跟', bag: 'Hermès Kelly 28', watch: 'Cartier Tank',
        makeup: 'Chanel 底妆+裸唇', hair: '低马尾',
      },
    },
    {
      id: 'home_lounge',
      context: 'home',
      style: '居家',
      summary: 'Loro Piana 羊绒家居针织，Brunello Cucinelli 长裤，Loro Piana 羊绒拖鞋，松弛有女人味',
      pieces: { top: 'Loro Piana 羊绒衫', bottom: 'Brunello Cucinelli 休闲裤', shoes: 'Loro Piana 羊绒拖鞋', makeup: '护肤后极淡', hair: '披肩' },
    },
    {
      id: 'home_shirt',
      context: 'intimate',
      style: '亲密',
      summary: '只穿他的白衬衫，下摆到大腿，米白家居穆勒鞋，头发微乱，克制私密感',
      pieces: { top: '他的白衬衫', lingerie: 'La Perla 或真空', shoes: '米白家居穆勒鞋', hair: '微乱', perfume: '他留下的气息' },
    },
    {
      id: 'date_night',
      context: 'date',
      style: '约会',
      summary: 'Saint Laurent 小黑裙，Jimmy Choo 细跟，Chanel 包，Dior 红唇',
      pieces: {
        dress: 'Saint Laurent 黑色修身裙', shoes: 'Jimmy Choo 细跟', bag: 'Chanel Classic 中号',
        jewelry: ['Van Cleef 四叶草耳钉'], makeup: 'Dior 红唇+Chanel 眼妆', perfume: 'MFK BR540',
      },
    },
    {
      id: 'outing_casual',
      context: 'outing',
      style: '外出',
      summary: 'Celine 大衣，Totême 上衣，The Row 牛仔裤，小白鞋，Loewe 包',
      pieces: {
        top: 'Totême 简约上衣', bottom: 'The Row 直筒牛仔裤', outer: 'Celine 长款大衣',
        shoes: 'Common Projects 小白鞋', bag: 'Loewe Puzzle 迷你',
      },
    },
    {
      id: 'sport',
      context: 'sport',
      style: '运动',
      summary: 'Lululemon 运动套装，Alo 或 Loro 运动外套，New Balance 或 Nike 限定',
      pieces: { top: 'Lululemon 运动内衣', bottom: 'Lululemon 紧身裤', shoes: 'Nike 限定跑鞋', bag: 'Loro Piana 运动托特', hair: '高马尾' },
    },
    {
      id: 'sleep',
      context: 'sleep',
      style: '睡衣',
      summary: 'Olivia von Halle 丝质睡衣，卸妆后护肤，头发散着',
      pieces: { top: '丝质睡衣上衣', bottom: '配套睡裤', makeup: '卸妆+La Mer 晚霜', skincare: 'SK-II+La Mer', hair: '披散' },
    },
    {
      id: 'sick_rest',
      context: 'sick',
      style: '病中',
      summary: '宽大 Loro 羊绒家居服，素颜，薄毯子或羊绒披肩',
      pieces: { top: 'Loro Piana 家居羊绒', bottom: '宽松长裤', outer: '羊绒披肩', makeup: '素颜', skincare: '保湿为主' },
    },
  ].map(normalizeLook);
}

/**
 * 根据时间/活动/健康/亲密阶段推断穿搭情境。
 */
export function inferOutfitContext({ hour = 12, life = null, intimacy = null, now = Date.now() } = {}) {
  if (isSick(life, now)) return 'sick';
  const phase = intimacy?.scene_phase;
  if (['foreplay', 'peak', 'aftercare', 'flirting'].includes(phase) && (hour >= 21 || hour < 9 || phase !== 'flirting')) {
    if (['foreplay', 'peak', 'aftercare'].includes(phase)) return 'intimate';
  }
  const act = String(life?.current_activity ?? '');
  if (/健身|运动|跑步/.test(act)) return 'sport';
  if (/睡|床上|被窝|困/.test(act) || hour >= 23 || hour < 6) return 'sleep';
  if (/开会|公司|办公|董事长|工位/.test(act) || (hour >= 9 && hour < 18 && !/在家|居家/.test(act))) return 'work';
  if (/约会|餐厅|电影|逛街/.test(act)) return 'date';
  if (/外面|出门|咖啡|商场|公园/.test(act)) return 'outing';
  if (hour >= 21 || hour < 8) return 'home';
  return 'home';
}

/** 从衣橱按情境选一套；preferId 优先；outing/home 可按季节偏好四季主 look。 */
export function pickOutfit(wardrobe, context = 'home', { preferId = null, avoidId = null, rng = Math.random, season = null, now = Date.now() } = {}) {
  const cat = normalizeWardrobe(wardrobe);
  const ctx = OUTFIT_CONTEXTS.includes(context) ? context : 'home';
  const seasonNow = OUTFIT_SEASONS.includes(season) ? season : inferSeason(now);
  let pool = cat.wardrobe.filter((w) => w.context === ctx || (Array.isArray(w.contexts) && w.contexts.includes(ctx)));
  // contexts 字段兼容：normalizeLook 只存单一 context；支持 multi via raw
  if (!pool.length) {
    pool = cat.wardrobe.filter((w) => w.context === ctx);
  }
  if (!pool.length && ctx === 'intimate') pool = cat.wardrobe.filter((w) => w.context === 'home' || w.id.includes('shirt'));
  if (!pool.length && ctx === 'sick') pool = cat.wardrobe.filter((w) => w.context === 'home');
  if (!pool.length) pool = cat.wardrobe;

  if (preferId) {
    const hit = pool.find((w) => w.id === preferId) || cat.wardrobe.find((w) => w.id === preferId);
    if (hit) return attachDefaultLingerie({ ...hit, context: ctx }, cat.lingerie) || { ...hit, context: ctx };
  }
  // 季节主 look：outing / 无强默认时优先
  const seasonalId = cat.seasonal?.[seasonNow];
  if (seasonalId && (ctx === 'outing' || ctx === 'home' || ctx === 'date')) {
    const hit = cat.wardrobe.find((w) => w.id === seasonalId);
    if (hit && hit.id !== avoidId) {
      return attachDefaultLingerie({ ...hit, context: ctx }, cat.lingerie) || { ...hit, context: ctx };
    }
  }
  // 同情境池里优先当季 season 字段
  const seasonalPool = pool.filter((w) => w.season === seasonNow);
  if (seasonalPool.length && (ctx === 'outing' || ctx === 'date')) {
    pool = seasonalPool;
  }
  const defaultId = cat.defaults?.[ctx];
  if (defaultId) {
    const hit = cat.wardrobe.find((w) => w.id === defaultId);
    if (hit && hit.id !== avoidId) return attachDefaultLingerie({ ...hit, context: ctx }, cat.lingerie) || { ...hit, context: ctx };
  }
  const filtered = avoidId ? pool.filter((w) => w.id !== avoidId) : pool;
  const list = filtered.length ? filtered : pool;
  const i = Math.min(list.length - 1, Math.floor(rng() * list.length));
  const chosen = { ...list[i], context: ctx };
  // 自动补内衣（衣橱未写时从内衣抽屉按情境取）
  return attachDefaultLingerie(chosen, cat.lingerie) || chosen;
}

/**
 * 读取时：若无当前穿搭或情境变了太久，可惰性换装。
 * 不每小时乱换——情境变化或超过 maxHours 才换。
 */
export function evolveOutfitState(state, { hour, life, intimacy, wardrobe, now = Date.now(), config = PARAMS.outfit } = {}) {
  const cur = clampOutfitState(state);
  const targetCtx = inferOutfitContext({ hour, life, intimacy, now });
  const maxHours = num(config?.maxHoursSameOutfit, 14);
  const hoursSince =
    cur.changed_at || cur.updated_at
      ? Math.max(0, (now - new Date(cur.changed_at || cur.updated_at).getTime()) / HOUR)
      : 999;

  const needChange =
    !cur.current ||
    (cur.context !== targetCtx && hoursSince >= num(config?.minHoursBeforeSwitch, 0.5)) ||
    (hoursSince >= maxHours && cur.context !== targetCtx);

  if (!needChange) {
    return clampOutfitState({
      ...cur,
      context: cur.current?.context || cur.context,
      daily_key: cur.daily_key,
      composed_from: cur.composed_from,
      daily_photo: cur.daily_photo,
    });
  }

  const look = pickOutfit(wardrobe, targetCtx, {
    preferId: null,
    avoidId: cur.current?.id,
    now,
    season: inferSeason(now),
  });
  const stamp = new Date(now).toISOString();
  // 同日情境换装：保留 daily_key / 今日成片，不覆盖日更相册
  return clampOutfitState({
    current: look,
    context: targetCtx,
    changed_at: stamp,
    updated_at: stamp,
    daily_key: cur.daily_key,
    composed_from: cur.composed_from,
    daily_photo: cur.daily_photo,
  });
}

/** 对话触发换装（用户说换衣服 / 她说换了衣服） */
export function detectOutfitIntent(text = '') {
  const s = String(text ?? '');
  const change = /(换(件|套|身)?衣服|换装|换好了|穿上了|换上|脱掉|只穿|衬衫|睡衣|西装|裙子|内衣)/u.test(s);
  const ask = /(穿(的|了)?什么|今天穿|你穿|身上|衣服|好看|打扮)/u.test(s);
  return { change, ask };
}

/**
 * 从用户话里粗匹配衣橱条目，或按关键词情境换装。
 */
export function applyOutfitFromTurns(state, turns = [], wardrobe, now = Date.now()) {
  const text = turns.map((t) => t?.content ?? '').join('\n');
  const intent = detectOutfitIntent(text);
  if (!intent.change && !intent.ask) return { state: clampOutfitState(state), changed: false };

  const cat = normalizeWardrobe(wardrobe);
  let look = null;
  if (/衬衫|他的衣服|你的衣服/u.test(text)) look = cat.wardrobe.find((w) => /shirt|衬衫/i.test(w.id) || /衬衫/.test(w.summary));
  if (!look && /睡衣|睡/u.test(text)) look = cat.wardrobe.find((w) => w.context === 'sleep');
  if (!look && /西装|开会|公司/u.test(text)) look = cat.wardrobe.find((w) => w.context === 'work');
  if (!look && /运动|健身/u.test(text)) look = cat.wardrobe.find((w) => w.context === 'sport');
  if (!look && /裙子|约会/u.test(text)) look = cat.wardrobe.find((w) => w.context === 'date');
  if (!look && intent.change) look = pickOutfit(cat, clampOutfitState(state).context || 'home', { avoidId: state?.current?.id });

  if (!look) return { state: clampOutfitState(state), changed: false, asked: intent.ask };
  const stamp = new Date(now).toISOString();
  return {
    state: clampOutfitState({
      current: look,
      context: look.context,
      changed_at: stamp,
      updated_at: stamp,
    }),
    changed: true,
    asked: intent.ask,
  };
}

/**
 * Prompt 注入：有穿搭才写；不主动报清单，问到或刚换装才强调。
 */
export function toOutfitPrompt(outfit, { force = false, justChanged = false, wardrobe = null } = {}) {
  const o = clampOutfitState(outfit);
  if (!o.current?.summary) return '';
  const wealthHint =
    wardrobe?.style || wardrobe?.beauty?.notes
      ? '你的衣服、包、表、化妆品、内衣都是一线奢侈/轻熟贵妇线，有韵味、得体、有女人味；提品牌时自然点到即可，别像导购报货号，也别走幼态网红风。'
      : '穿搭成熟有韵味、得体有女人味，不廉价、不幼态。';
  const bag = o.current.pieces?.bag;
  const makeup = o.current.pieces?.makeup || o.current.pieces?.lips;
  const shoes = o.current.pieces?.shoes;
  const lingerie = o.current.pieces?.lingerie || [o.current.pieces?.bra, o.current.pieces?.panties].filter(Boolean).join(' + ');
  const intimateCtx = o.context === 'intimate' || /衬衫|蕾丝|真空|私密/.test(o.current.summary || '');
  const extras = [
    bag && `包：${bag}`,
    shoes && `鞋：${shoes}`,
    makeup && `妆：${makeup}`,
    intimateCtx && lingerie && `内衣：${lingerie}`,
  ].filter(Boolean).join('；');
  const core = extras ? `${o.current.summary}（${extras}）` : o.current.summary;
  const photoHint =
    '若拍照/发图：必须完整鞋履出镜（禁止赤脚出镜），全身或至少脚部清楚；气质成熟温柔、克制体面。';
  if (!force && !justChanged) {
    return `【此刻穿搭】你现在：${core}。${wealthHint}${photoHint}对方问起穿什么/包/妆/鞋/内衣时按这个说；日常不要主动报内裤文胸，亲密相关或对方问到再说；不要每轮主动报清单。`;
  }
  if (justChanged) {
    return `【此刻穿搭·刚换过】你刚换成：${core}。${wealthHint}${photoHint}相关时可以自然提一句，别硬宣布「我换好了全套」。`;
  }
  return `【此刻穿搭】${core}。${photoHint}`;
}

/**
 * 出图用穿搭：剥离内衣/文胸/内裤等易触发图模安全审核的字段。
 * 对话仍可保留内衣细节；只影响 image mods。
 */
export function sanitizeOutfitForImage(outfit) {
  const o = clampOutfitState(outfit);
  if (!o.current) return o;
  const intimate = o.context === 'intimate';
  const p = { ...(o.current.pieces || {}) };
  if (!intimate) {
    delete p.lingerie;
    delete p.bra;
    delete p.panties;
    delete p.hosiery;
  }
  // 摘要里去掉内衣品牌/描述（La Perla 等会被 piecesToSummary 拼进 summary）
  let summary = String(o.current.summary || piecesToSummary(p));
  if (!intimate) {
    summary = summary
      .replace(/[，,]?\s*La Perla[^，,]*/gi, '')
      .replace(/[，,]?\s*Agent Provocateur[^，,]*/gi, '')
      .replace(/[，,]?\s*(裸色无痕套装|无痕软钢圈|同色三角\/平角|文胸|内裤|内衣)[^，,]*/g, '')
      .replace(/[，,]{2,}/g, '，')
      .replace(/^[，,\s]+|[，,\s]+$/g, '')
      .trim() || piecesToSummary(p);
  }
  return clampOutfitState({
    ...o,
    current: {
      ...o.current,
      summary,
      pieces: p,
    },
  });
}

/** 给自拍/出图用的服装修饰语（禁止赤脚；强制可识别鞋履） */
export function outfitToImageMods(outfit) {
  const o = sanitizeOutfitForImage(outfit);
  if (!o.current?.summary) return [];
  const mods = [o.current.summary];
  const p = o.current.pieces || {};
  if (p.hair) mods.push(String(p.hair));
  if (p.makeup) mods.push(String(p.makeup));
  if (p.dress) mods.push(String(p.dress));
  if (p.top && !p.dress) mods.push(String(p.top));
  if (p.bottom && !p.dress) mods.push(String(p.bottom));
  if (p.outer) mods.push(String(p.outer));
  if (p.bag) mods.push(`handbag: ${p.bag}`);
  if (p.watch) mods.push(`watch: ${p.watch}`);
  if (p.jewelry) {
    mods.push(`jewelry: ${Array.isArray(p.jewelry) ? p.jewelry.join(', ') : p.jewelry}`);
  }
  // 出图：赤脚/光脚 → 得体可见鞋
  const rawShoes = String(p.shoes || '');
  if (/赤脚|光脚|barefoot/i.test(rawShoes) || !rawShoes) {
    mods.push('elegant visible footwear (soft house mules or low heels), shoes fully visible, not barefoot');
  } else {
    mods.push(`shoes: ${rawShoes}, footwear fully visible`);
  }
  mods.push('full-length outfit readable, mature refined styling');
  return mods;
}

// ---- IO (存 life_state.outfit，与身体同一行，独立 updated_at 在 jsonb 内) ----

export async function readOutfit(userId, companionId = 'default') {
  if (!userId) return defaultOutfitState();
  const { data, error } = await supabase
    .from('life_state')
    .select('outfit, updated_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .maybeSingle();
  if (error || !data) return defaultOutfitState();
  const raw = data.outfit && typeof data.outfit === 'object' ? data.outfit : {};
  return clampOutfitState({ ...raw, updated_at: raw.updated_at ?? null });
}

export async function writeOutfit(userId, companionId = 'default', outfit, now = Date.now()) {
  if (!userId) throw new Error('writeOutfit 需要 userId');
  const value = clampOutfitState(outfit);
  const stamp = new Date(now).toISOString();
  const row = {
    user_id: userId,
    companion_id: companionId,
    outfit: { ...value, updated_at: stamp },
  };
  const { error } = await supabase.from('life_state').upsert(row, { onConflict: 'user_id,companion_id' });
  if (error) throw error;
  return { ...value, updated_at: stamp };
}

export class OutfitDimension {
  constructor({
    userId,
    companionId = 'default',
    read = readOutfit,
    write = writeOutfit,
    now = () => Date.now(),
    wardrobe = null,
    config = PARAMS.outfit,
  } = {}) {
    Object.assign(this, {
      userId,
      companionId,
      read,
      write,
      now,
      wardrobe: normalizeWardrobe(wardrobe),
      config: config ?? PARAMS.outfit,
    });
  }

  /** 妆台/包柜（人设侧，不落库） */
  beauty() {
    return this.wardrobe?.beauty ?? defaultBeautyVanity();
  }

  bags() {
    return this.wardrobe?.bags ?? defaultBags();
  }

  lingerieDrawer() {
    return this.wardrobe?.lingerie ?? defaultLingerieDrawer();
  }

  enabled() {
    return this.config?.enabled !== false;
  }

  async snapshot({ life = null, intimacy = null } = {}) {
    if (!this.enabled()) return defaultOutfitState();
    const stored = this.userId ? await this.read(this.userId, this.companionId) : defaultOutfitState();
    const hour = new Date(this.now()).getHours();
    const now = this.now();
    // 动态 import 避免 outfit ↔ dailyLook 环依赖
    const { ensureDailyLookState } = await import('./dailyLook.js');
    // 新的一天：从衣橱+抽屉组合今日主 look
    const daily = ensureDailyLookState(stored, {
      wardrobe: this.wardrobe,
      life,
      intimacy,
      now,
      config: this.config,
    });
    let base = daily.state;
    const evolved = evolveOutfitState(base, {
      hour,
      life,
      intimacy,
      wardrobe: this.wardrobe,
      now,
      config: this.config,
    });
    // 情境换装后仍挂上 daily_key（若 ensure 刚写入）
    const next = clampOutfitState({
      ...evolved,
      daily_key: evolved.daily_key || base.daily_key,
      composed_from: evolved.composed_from || base.composed_from,
      daily_photo: evolved.daily_photo || base.daily_photo,
    });
    const changed =
      daily.composed
      || (next.changed_at && next.changed_at !== stored.changed_at)
      || next.daily_key !== stored.daily_key;
    if (this.userId && changed) {
      await this.write(this.userId, this.companionId, next, now).catch(() => {});
    }
    return next;
  }

  async evolve(turns = [], ctx = {}) {
    if (!this.enabled()) return defaultOutfitState();
    let base = await this.snapshot(ctx);
    const applied = applyOutfitFromTurns(base, turns, this.wardrobe, this.now());
    let next = applied.state;
    if (!applied.changed) {
      // 仍按情境惰性校正
      next = evolveOutfitState(next, {
        hour: new Date(this.now()).getHours(),
        life: ctx.life,
        intimacy: ctx.intimacy,
        wardrobe: this.wardrobe,
        now: this.now(),
        config: this.config,
      });
    }
    next = clampOutfitState({
      ...next,
      daily_key: next.daily_key || base.daily_key,
      composed_from: next.composed_from || base.composed_from,
      daily_photo: next.daily_photo ?? base.daily_photo,
    });
    if (this.userId) await this.write(this.userId, this.companionId, next, this.now());
    return { ...next, _meta: { changed: applied.changed || next.changed_at !== base.changed_at, asked: applied.asked } };
  }

  toPrompt(outfit, opts = {}) {
    return toOutfitPrompt(outfit, { ...opts, wardrobe: this.wardrobe });
  }
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
