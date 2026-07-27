/**
 * 穿搭系统 UI 卡片目录：把 wardrobe / bags / beauty / lingerie 展成可展示卡片，
 * 每张卡有默认出图提示词；图片与自定义提示词存在 companions/<id>/outfit-assets。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWardrobe, PIECE_KEYS } from './outfit.js';
import { applyPromptKit, applyProductPromptKit, isPersonOutfitCard, assemblePersonImagePrompt } from '../appearance/promptKit.js';
import {
  OUTFIT_SECTIONS,
  OUTFIT_SECTION_IDS,
  stampCardCategory,
} from './outfitTaxonomy.js';
import {
  STOCK_ACCESSORIES,
  STOCK_BAGS,
  STOCK_BOTTOMS,
  STOCK_DRESSES,
  STOCK_HAIR,
  STOCK_JEWELRY,
  STOCK_LINGERIE,
  STOCK_OUTERWEAR,
  STOCK_SHOES,
  STOCK_TOPS,
  STOCK_TRAVEL,
  STOCK_WATCHES,
  padWithStock,
} from './outfitCatalogStock.js';

const ALLOWED = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

const PIECE_LABELS = {
  top: '上衣',
  bottom: '下装',
  dress: '裙装',
  outer: '外套',
  shoes: '鞋履',
  lingerie: '内衣套装',
  bra: '文胸',
  panties: '内裤',
  hosiery: '丝袜/吊带',
  bag: '包袋',
  jewelry: '珠宝',
  watch: '腕表',
  perfume: '香氛',
  accessories: '配饰',
  hair: '发型',
  makeup: '妆容',
  skincare: '护肤',
  nails: '甲油',
  lips: '唇妆',
  eyes: '眼妆',
};

const BEAUTY_LABELS = {
  skincare: '护肤',
  base: '底妆',
  eyes: '眼妆',
  lips: '唇妆',
  nails: '甲油',
  fragrance: '香氛',
  tools: '工具',
  travel_mini: '旅行护肤 mini',
};

function slugPart(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u4e00-\u9fff._-]+/g, '')
    .slice(0, 80) || 'item';
}

export function cardId(kind, ...parts) {
  return [kind, ...parts.map(slugPart)].join(':').slice(0, 160);
}

function piecesText(pieces = {}) {
  const parts = [];
  for (const key of PIECE_KEYS) {
    const v = pieces[key];
    if (v == null || v === '') continue;
    const label = PIECE_LABELS[key] || key;
    if (Array.isArray(v)) parts.push(`${label}：${v.join('、')}`);
    else parts.push(`${label}：${v}`);
  }
  return parts.join('；');
}

/**
 * 默认出图提示词（英文为主，方便 SD / MJ / GPT Image）
 * - look / lingerie：有人，全身套装
 * - bag / shoe / beauty / …：纯产品静物，禁止出人
 */
export function defaultPromptForCard(card) {
  const title = card.title || card.summary || '';
  const brand = card.brand ? ` by ${card.brand}` : '';

  // —— 整套套装：有人 ——
  if (card.kind === 'look') {
    const pieceLine = piecesText(card.pieces || {});
    const assembled = assemblePersonImagePrompt({
      appearance: 'elegant adult East Asian woman, refined facial proportions',
      outfitMods: [
        `wearing complete look: ${card.summary || title}`,
        pieceLine ? `details: ${pieceLine}` : '',
        card.pieces?.shoes
          ? `shoes: ${card.pieces.shoes}, fully visible`
          : 'complete elegant footwear fully visible',
      ].filter(Boolean),
      scene: `context mood: ${card.context || 'daily'}, refined lifestyle or soft editorial set`,
      kind: 'lookbook',
      pieces: card.pieces || {},
      appendNegative: true,
    });
    return assembled.prompt;
  }

  if (card.kind === 'lingerie') {
    const detail = [card.bra, card.panties, card.color].filter(Boolean).join(', ');
    const assembled = assemblePersonImagePrompt({
      appearance: 'elegant adult East Asian woman, refined facial proportions',
      outfitMods: [
        `tasteful luxury lingerie look (artistic, non-explicit): ${title}`,
        detail,
        'silk and lace texture, high-end La Perla aesthetic, covered elegant styling',
        'soft house slippers or elegant mules fully visible, not barefoot',
      ].filter(Boolean),
      scene: 'soft boudoir lighting, refined private interior, classy not vulgar',
      kind: 'lookbook',
      appendNegative: true,
    });
    return assembled.prompt;
  }

  // —— 以下全部：只有单品，没有人 ——
  const product = (desc) =>
    [
      'Luxury product photography, single item only, no person, no model, no human face, no body,',
      desc,
      'premium materials, soft studio shadows, clean background, magazine still-life quality,',
      'no text, no watermark, no logo.',
      'Avoid: person, model, woman, face, portrait, full body, hands as lifestyle portrait subject, collage, low quality.',
    ].join(' ');

  if (card.kind === 'piece') {
    return product(
      `Garment still life of ${card.pieceKeyLabel || 'fashion piece'}: ${title}. ` +
        'Flat-lay or on a minimal hanger / bust form without face, fabric weave and construction detail.',
    );
  }
  if (card.kind === 'bag') {
    return product(
      `Luxury handbag only: ${title}${brand}. Hermès/Chanel-level leather grain and hardware, ` +
        'hero product angle, optional soft reflection surface, no model carrying it as a portrait.',
    );
  }
  if (card.kind === 'beauty') {
    return product(
      `Luxury beauty product packaging only: ${title} (${card.beautyCategoryLabel || 'beauty'})${brand}. ` +
        'Chanel/Dior/CPB-level bottle or compact, vanity flat-lay, clean glam light.',
    );
  }
  if (card.kind === 'shoe') {
    const detail = [card.brand, card.itemKind, card.heel, card.material].filter(Boolean).join(', ');
    return product(
      `Luxury footwear product shot only: ${title}. ${detail}. ` +
        'Single pair or hero shoe, full shoe silhouette clear, Manolo/Louboutin/Chanel craftsmanship, no person wearing them in full-body portrait.',
    );
  }
  if (card.kind === 'jewelry') {
    return product(
      `High jewelry still life only: ${title}${brand}. Cartier/Van Cleef aesthetic, soft sparkle, macro metal and stone detail, no model face.`,
    );
  }
  if (card.kind === 'watch') {
    return product(
      `Luxury women's watch product photography only: ${title}${brand}. ` +
        'Cartier Tank level, watch alone or on a neutral display, optional anonymous wrist crop without face/body, refined steel gold.',
    );
  }
  if (card.kind === 'accessory') {
    return product(
      `Luxury accessory still life only: ${title}${brand} (${card.itemKind || 'accessory'}). ` +
        'Hermès scarf / Celine sunglasses level, product only, clean editorial light.',
    );
  }
  if (card.kind === 'outerwear') {
    return product(
      `Luxury outerwear garment still life: ${title}${brand}. ` +
        'Coat on a minimal form or hanger, Max Mara/The Row/Loro Piana cashmere wool texture, full garment silhouette, no face no lifestyle model.',
    );
  }
  if (card.kind === 'travel') {
    return product(
      `Luxury travel item still life: ${title}${brand} (${card.itemKind || 'travel'}). ` +
        'Rimowa / first-class aesthetic, luggage or beauty mini kit only, soft hotel light, no person.',
    );
  }
  return product(title || 'premium luxury item');
}

function drawerToCards(list, kind, subtitleDefault) {
  return (list || []).map((item) => ({
    id: cardId(kind, item.id || item.label),
    kind,
    title: item.label,
    subtitle: [item.brand, item.kind].filter(Boolean).join(' · ') || subtitleDefault,
    summary: item.notes || item.label,
    brand: item.brand || '',
    itemKind: item.kind || '',
    heel: item.heel || null,
    material: item.material || null,
    color: item.color || null,
    contexts: item.contexts || [],
    wearable: false,
    tags: [item.brand, item.kind, item.heel, ...(item.contexts || [])].filter(Boolean),
  }));
}

function stockPieceToCard(item, kind, pieceKey, subtitle) {
  return {
    id: cardId(kind, item.id || item.label),
    kind,
    title: item.label,
    subtitle: [item.brand, item.kind].filter(Boolean).join(' · ') || subtitle,
    summary: item.notes || item.label,
    brand: item.brand || '',
    itemKind: item.kind || '',
    pieceKey,
    pieceKeyLabel: PIECE_LABELS[pieceKey] || subtitle,
    heel: item.heel || null,
    material: item.material || null,
    color: item.color || null,
    contexts: item.contexts || [],
    fromLooks: [],
    wearable: false,
    tags: [item.brand, item.kind, item.heel, ...(item.contexts || [])].filter(Boolean),
  };
}

function padCards(existing, stockCards, minCount = 30) {
  return padWithStock(existing, stockCards, {
    minCount,
    keyFn: (card) => card?.title || card?.id,
  });
}

/**
 * 从规范化衣橱构建全部 UI 卡片（无图片状态）。
 * @param rawWardrobe 角色 outfit.json
 * @param customLooks 用户自定义造型（outfit-custom-looks.json）
 */
export function buildOutfitCatalog(rawWardrobe = null, customLooks = []) {
  const cat = normalizeWardrobe(rawWardrobe);
  const looks = [];
  const pieceMap = new Map();
  const customItems = (Array.isArray(customLooks) ? customLooks : [])
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      return {
        id: x.id,
        context: x.context || 'home',
        summary: x.summary || x.style || '',
        style: x.style || x.title || '',
        pieces: x.pieces || {},
        season: x.season || null,
        source: 'custom',
        prompt: x.prompt || '',
        seriesId: x.seriesId || null,
        seriesIndex: x.seriesIndex ?? null,
        seriesTitle: x.seriesTitle || null,
        gallery: Array.isArray(x.gallery) ? x.gallery : [],
      };
    })
    .filter((x) => x?.id && x.summary);

  // 自定义：系列按 seriesIndex，再按更新；系统衣橱接后
  const customSorted = [...customItems].sort((a, b) => {
    if (a.seriesId && b.seriesId && a.seriesId === b.seriesId) {
      return (a.seriesIndex || 0) - (b.seriesIndex || 0);
    }
    if (a.seriesId && !b.seriesId) return -1;
    if (!a.seriesId && b.seriesId) return 1;
    return 0;
  });
  const allLooks = [...customSorted, ...(cat.wardrobe || [])];

  // 衣橱拆类：裙 / 上 / 下 / 发 / 外（不再混进一个「单品」堆）
  const topsMap = new Map();
  const bottomsMap = new Map();
  const dressesMap = new Map();
  const hairMap = new Map();
  const outerFromLooks = new Map();

  const putPiece = (map, key, text, lookId, kind, subtitle) => {
    const id = cardId(kind === 'piece' ? 'piece' : kind, key, text);
    if (map.has(id)) {
      const prev = map.get(id);
      if (lookId && !prev.fromLooks.includes(lookId)) prev.fromLooks.push(lookId);
      return;
    }
    map.set(id, {
      id,
      kind,
      title: text,
      subtitle,
      pieceKey: key,
      pieceKeyLabel: PIECE_LABELS[key] || key,
      summary: text,
      fromLooks: lookId ? [lookId] : [],
      wearable: false,
      tags: [subtitle],
    });
  };

  for (const look of allLooks) {
    const seasonLabel = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' }[look.season] || null;
    const isCustom = look.source === 'custom' || String(look.id || '').startsWith('custom_');
    const seriesTag = look.seriesTitle
      ? `${look.seriesTitle}${look.seriesIndex != null ? ` · ${look.seriesIndex}` : ''}`
      : null;
    const lookCard = {
      id: cardId('look', look.id),
      kind: 'look',
      title: look.style || look.summary?.slice(0, 24) || look.id,
      subtitle: [isCustom ? '自定义' : null, seriesTag, look.context || 'home', seasonLabel, look.id]
        .filter(Boolean)
        .join(' · '),
      summary: look.summary || '',
      context: look.context || 'home',
      style: look.style || '',
      season: look.season || null,
      lookId: look.id,
      pieces: look.pieces || {},
      wearable: true,
      source: isCustom ? 'custom' : 'wardrobe',
      seriesId: look.seriesId || null,
      seriesIndex: look.seriesIndex ?? null,
      seriesTitle: look.seriesTitle || null,
      gallery: look.gallery || [],
      seedPrompt: look.prompt || '',
      tags: [
        isCustom ? '自定义' : null,
        look.seriesId ? '系列' : null,
        look.context,
        look.style,
        seasonLabel && `${seasonLabel}季`,
      ].filter(Boolean),
    };
    looks.push(lookCard);

    for (const key of PIECE_KEYS) {
      const v = look.pieces?.[key];
      if (v == null || v === '') continue;
      const values = Array.isArray(v) ? v : [v];
      for (const item of values) {
        const text = String(item).trim();
        if (!text || text === '无' || text === '不出门') continue;
        // 已有专柜的不再塞进衣片
        if (['bag', 'makeup', 'skincare', 'lips', 'eyes', 'nails', 'perfume', 'shoes', 'jewelry', 'watch', 'accessories', 'bra', 'panties', 'hosiery', 'lingerie'].includes(key)) {
          continue;
        }
        if (key === 'dress') putPiece(dressesMap, key, text, look.id, 'dress', '裙装');
        else if (key === 'top') putPiece(topsMap, key, text, look.id, 'top', '上装');
        else if (key === 'bottom') putPiece(bottomsMap, key, text, look.id, 'bottom', '下装');
        else if (key === 'hair') putPiece(hairMap, key, text, look.id, 'hair', '发型');
        else if (key === 'outer') putPiece(outerFromLooks, key, text, look.id, 'outerwear', '外套');
        else {
          // 兜底进上装池，避免丢失
          putPiece(topsMap, key, text, look.id, 'piece', PIECE_LABELS[key] || key);
        }
      }
    }
  }

  const bagInventory = padWithStock(cat.bags, STOCK_BAGS);
  const bags = bagInventory.map((label, i) => ({
    id: cardId('bag', label || i),
    kind: 'bag',
    title: String(label),
    subtitle: '包袋',
    summary: String(label),
    wearable: false,
    tags: ['包'],
  }));

  const beauty = [];
  const vanity = cat.beauty || {};
  for (const [catKey, label] of Object.entries(BEAUTY_LABELS)) {
    const list = Array.isArray(vanity[catKey]) ? vanity[catKey] : [];
    for (const item of list) {
      const title = String(item);
      beauty.push({
        id: cardId('beauty', catKey, title),
        kind: 'beauty',
        title,
        subtitle: label,
        summary: title,
        beautyCategory: catKey,
        beautyCategoryLabel: label,
        wearable: false,
        tags: [label],
      });
    }
  }

  const lingerieInventory = padWithStock(cat.lingerie, STOCK_LINGERIE);
  const lingerie = lingerieInventory.map((item) => ({
    id: cardId('lingerie', item.id || item.label),
    kind: 'lingerie',
    title: item.label,
    subtitle: [item.brand, item.kind].filter(Boolean).join(' · ') || '内衣',
    summary: item.notes || item.label,
    brand: item.brand || '',
    itemKind: item.kind || '',
    bra: item.bra || null,
    panties: item.panties || null,
    color: item.color || null,
    contexts: item.contexts || [],
    wearable: false,
    tags: [item.brand, item.kind, ...(item.contexts || [])].filter(Boolean),
  }));

  // 外套柜 + look 里的 outer 合并（按 id 去重）
  const outerwearDrawer = drawerToCards(cat.outerwear, 'outerwear', '外套');
  const outerwearMerged = [...outerwearDrawer];
  for (const card of outerFromLooks.values()) {
    if (!outerwearMerged.some((x) => x.title === card.title)) outerwearMerged.push(card);
  }

  const outerwear = padCards(outerwearMerged, drawerToCards(STOCK_OUTERWEAR, 'outerwear', '外套'));
  const shoes = drawerToCards(padWithStock(cat.shoes, STOCK_SHOES), 'shoe', '鞋履');
  const jewelry = drawerToCards(padWithStock(cat.jewelry, STOCK_JEWELRY), 'jewelry', '珠宝');
  const watches = drawerToCards(padWithStock(cat.watches, STOCK_WATCHES), 'watch', '腕表');
  const accessories = drawerToCards(padWithStock(cat.accessories, STOCK_ACCESSORIES), 'accessory', '配饰');
  const travel = drawerToCards(padWithStock(cat.travel, STOCK_TRAVEL), 'travel', '旅行');

  const finalize = (sectionId, list) =>
    (list || []).map((card) => {
      const stamped = stampCardCategory(sectionId, card);
      return {
        ...stamped,
        defaultPrompt: (card.seedPrompt && String(card.seedPrompt).trim()) || defaultPromptForCard(card),
      };
    });

  const tops = finalize('tops', padCards(
    [...topsMap.values()],
    STOCK_TOPS.map((item) => stockPieceToCard(item, 'top', 'top', '上装')),
  ));
  const bottoms = finalize('bottoms', padCards(
    [...bottomsMap.values()],
    STOCK_BOTTOMS.map((item) => stockPieceToCard(item, 'bottom', 'bottom', '下装')),
  ));
  const dresses = finalize('dresses', padCards(
    [...dressesMap.values()],
    STOCK_DRESSES.map((item) => stockPieceToCard(item, 'dress', 'dress', '裙装')),
  ));
  const hair = finalize('hair', padCards(
    [...hairMap.values()],
    STOCK_HAIR.map((item) => stockPieceToCard(item, 'hair', 'hair', '发型')),
  ));
  // 兼容旧「单品」视图：衣片合计（不含发型）
  const pieces = [...tops, ...bottoms, ...dresses];

  const sectioned = {
    looks: finalize('looks', looks),
    dresses,
    tops,
    bottoms,
    outerwear: finalize('outerwear', outerwear),
    hair,
    shoes: finalize('shoes', shoes),
    bags: finalize('bags', bags),
    lingerie: finalize('lingerie', lingerie),
    jewelry: finalize('jewelry', jewelry),
    watches: finalize('watches', watches),
    accessories: finalize('accessories', accessories),
    beauty: finalize('beauty', beauty),
    travel: finalize('travel', travel),
    // 兼容
    pieces,
  };

  const counts = {};
  for (const id of OUTFIT_SECTION_IDS) {
    counts[id] = Array.isArray(sectioned[id]) ? sectioned[id].length : 0;
  }
  counts.pieces = pieces.length;

  return {
    style: cat.style || '',
    beautyNotes: vanity.notes || '',
    defaults: cat.defaults || {},
    seasonal: cat.seasonal || {},
    taxonomy: OUTFIT_SECTIONS,
    counts,
    ...sectioned,
  };
}

// ---------- 资产存储（每角色一份） ----------

export function outfitAssetsDir(companionRoot) {
  return path.join(companionRoot, 'outfit-assets');
}

export function outfitAssetsIndexPath(companionRoot) {
  return path.join(outfitAssetsDir(companionRoot), 'index.json');
}

export function readOutfitAssets(companionRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(outfitAssetsIndexPath(companionRoot), 'utf8'));
    return raw && typeof raw === 'object' ? raw : { cards: {} };
  } catch {
    return { cards: {} };
  }
}

export function writeOutfitAssets(companionRoot, data) {
  const dir = outfitAssetsDir(companionRoot);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    cards: data?.cards && typeof data.cards === 'object' ? data.cards : {},
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(outfitAssetsIndexPath(companionRoot), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function getAssetEntry(companionRoot, cardKey) {
  const index = readOutfitAssets(companionRoot);
  return index.cards?.[cardKey] || null;
}

export function saveCardPrompt(companionRoot, cardKey, prompt) {
  const index = readOutfitAssets(companionRoot);
  const prev = index.cards[cardKey] || {};
  index.cards[cardKey] = {
    ...prev,
    prompt: String(prompt || '').slice(0, 4000),
    updatedAt: new Date().toISOString(),
  };
  writeOutfitAssets(companionRoot, index);
  return index.cards[cardKey];
}

export function saveCardImage(companionRoot, cardKey, { mime, data, name = '' }) {
  const ext = ALLOWED.get(String(mime || '').toLowerCase());
  if (!ext) throw new Error('只支持 PNG、JPEG 和 WebP');
  const buffer = Buffer.from(String(data || ''), 'base64');
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('单张图片不能超过 20MB');

  const dir = outfitAssetsDir(companionRoot);
  fs.mkdirSync(dir, { recursive: true });
  const index = readOutfitAssets(companionRoot);
  const prev = index.cards[cardKey] || {};
  if (prev.file) {
    try {
      fs.unlinkSync(path.join(dir, path.basename(prev.file)));
    } catch {
      /* ignore */
    }
  }
  const id = crypto.randomUUID();
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buffer);
  index.cards[cardKey] = {
    ...prev,
    file,
    mime: String(mime),
    bytes: buffer.length,
    name: String(name || file).slice(0, 160),
    updatedAt: new Date().toISOString(),
  };
  writeOutfitAssets(companionRoot, index);
  return index.cards[cardKey];
}

export function clearCardImage(companionRoot, cardKey) {
  const index = readOutfitAssets(companionRoot);
  const prev = index.cards[cardKey];
  if (!prev) return null;
  if (prev.file) {
    try {
      fs.unlinkSync(path.join(outfitAssetsDir(companionRoot), path.basename(prev.file)));
    } catch {
      /* ignore */
    }
  }
  const { file, mime, bytes, name, ...rest } = prev;
  index.cards[cardKey] = { ...rest, updatedAt: new Date().toISOString() };
  if (!index.cards[cardKey].prompt) delete index.cards[cardKey];
  writeOutfitAssets(companionRoot, index);
  return true;
}

export function resolveAssetFile(companionRoot, cardKey) {
  const entry = getAssetEntry(companionRoot, cardKey);
  if (!entry?.file) return null;
  const full = path.join(outfitAssetsDir(companionRoot), path.basename(entry.file));
  if (!fs.existsSync(full)) return null;
  return { path: full, mime: entry.mime || 'image/png', entry };
}

/**
 * 合并目录卡 + 本地资产 → API 形态
 */
export function enrichCatalogWithAssets(catalog, companionRoot, { companionId = 'default' } = {}) {
  const assets = readOutfitAssets(companionRoot);
  const enrich = (card) => {
    const entry = assets.cards?.[card.id] || {};
    const rawPrompt = entry.prompt?.trim() ? entry.prompt : card.defaultPrompt;
    // 套装/内衣着装 → 人像 kit；包鞋美妆等 → 纯产品 kit（禁止套用全身人像）
    const prompt = isPersonOutfitCard(card.kind)
      ? applyPromptKit(rawPrompt || '', { forceFullBody: true, appendNegative: true }).prompt
      : applyProductPromptKit(rawPrompt || card.title || '', { appendNegative: true }).prompt;
    return {
      ...card,
      prompt,
      promptMode: isPersonOutfitCard(card.kind) ? 'person_look' : 'product_only',
      hasCustomPrompt: Boolean(entry.prompt?.trim()),
      imageUrl: entry.file
        ? `/api/outfit/media/${encodeURIComponent(card.id)}/file?companionId=${encodeURIComponent(companionId)}&t=${encodeURIComponent(entry.updatedAt || '')}`
        : null,
      hasImage: Boolean(entry.file),
      updatedAt: entry.updatedAt || null,
    };
  };
  return {
    style: catalog.style,
    beautyNotes: catalog.beautyNotes,
    defaults: catalog.defaults,
    counts: catalog.counts,
    looks: catalog.looks.map(enrich),
    pieces: catalog.pieces.map(enrich),
    bags: catalog.bags.map(enrich),
    beauty: catalog.beauty.map(enrich),
    lingerie: catalog.lingerie.map(enrich),
    shoes: (catalog.shoes || []).map(enrich),
    jewelry: (catalog.jewelry || []).map(enrich),
    watches: (catalog.watches || []).map(enrich),
    accessories: (catalog.accessories || []).map(enrich),
    outerwear: (catalog.outerwear || []).map(enrich),
    travel: (catalog.travel || []).map(enrich),
  };
}

/** 从 look 卡片 / wardrobe 条目构造 life_state.outfit.current */
export function lookToOutfitState(look, { stamp = new Date().toISOString() } = {}) {
  if (!look) return null;
  const pieces = look.pieces && typeof look.pieces === 'object' ? look.pieces : {};
  return {
    current: {
      id: look.lookId || look.id,
      context: look.context || 'home',
      summary: look.summary || look.title || '',
      style: look.style || '',
      pieces,
    },
    context: look.context || 'home',
    changed_at: stamp,
    updated_at: stamp,
  };
}
