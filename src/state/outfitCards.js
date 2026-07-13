/**
 * 穿搭系统 UI 卡片目录：把 wardrobe / bags / beauty / lingerie 展成可展示卡片，
 * 每张卡有默认出图提示词；图片与自定义提示词存在 companions/<id>/outfit-assets。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWardrobe, PIECE_KEYS } from './outfit.js';

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

/** 默认出图提示词（英文为主，方便 SD / MJ / GPT Image） */
export function defaultPromptForCard(card) {
  const base =
    'Photorealistic luxury editorial, East Asian woman, elegant reserved heiress aesthetic, soft natural light, refined color grading, magazine quality, no text, no watermark, no logo.';
  if (card.kind === 'look') {
    const pieceLine = piecesText(card.pieces || {});
    return `${base} Full-body or three-quarter portrait wearing this complete look: ${card.summary || card.title}. Details: ${pieceLine}. Context mood: ${card.context || 'daily'}.`;
  }
  if (card.kind === 'piece') {
    return `${base} Fashion still-life and worn detail of ${card.pieceKeyLabel || 'garment'}: ${card.title}. Luxury materials, premium craftsmanship, clean studio or soft lifestyle background.`;
  }
  if (card.kind === 'bag') {
    return `${base} Luxury handbag product photography and lifestyle carry shot: ${card.title}. Hermès/Chanel-level craftsmanship feel, soft shadows, premium leather texture.`;
  }
  if (card.kind === 'beauty') {
    return `${base} Luxury beauty product flat-lay and soft glam detail: ${card.title} (${card.beautyCategoryLabel || 'beauty'}). Chanel/Dior/CPB-level packaging aesthetic, clean vanity light.`;
  }
  if (card.kind === 'lingerie') {
    const detail = [card.bra, card.panties, card.color].filter(Boolean).join(', ');
    return `${base} Tasteful luxury lingerie editorial (artistic, non-explicit): ${card.title}. ${detail}. Soft boudoir lighting, silk and lace texture, high-end La Perla aesthetic.`;
  }
  if (card.kind === 'shoe') {
    const detail = [card.brand, card.itemKind, card.heel, card.material].filter(Boolean).join(', ');
    return `${base} Luxury footwear product photography and worn detail: ${card.title}. ${detail}. Manolo/Louboutin/Chanel level, elegant heels or premium flats, soft studio light, leather texture.`;
  }
  if (card.kind === 'jewelry') {
    return `${base} High jewelry still life and on-skin detail: ${card.title}${card.brand ? ` by ${card.brand}` : ''}. Cartier/Van Cleef aesthetic, soft sparkle, platinum gold diamonds, macro luxury photography.`;
  }
  if (card.kind === 'watch') {
    return `${base} Luxury women's watch product shot: ${card.title}${card.brand ? ` by ${card.brand}` : ''}. Cartier Tank aesthetic, wrist detail, refined steel gold, soft daylight.`;
  }
  if (card.kind === 'accessory') {
    return `${base} Luxury accessory still life: ${card.title}${card.brand ? ` by ${card.brand}` : ''} (${card.itemKind || 'accessory'}). Hermès scarf / Celine sunglasses level craftsmanship, clean editorial light.`;
  }
  if (card.kind === 'outerwear') {
    return `${base} Luxury outerwear editorial and garment detail: ${card.title}${card.brand ? ` by ${card.brand}` : ''}. Max Mara/The Row/Loro Piana coat aesthetic, cashmere wool texture, full silhouette.`;
  }
  if (card.kind === 'travel') {
    return `${base} Luxury travel still life: ${card.title}${card.brand ? ` by ${card.brand}` : ''} (${card.itemKind || 'travel'}). Rimowa / first-class cabin aesthetic, polished metal luggage or beauty mini kit, soft hotel light.`;
  }
  return `${base} ${card.title || card.summary || ''}`;
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

/**
 * 从规范化衣橱构建全部 UI 卡片（无图片状态）。
 */
export function buildOutfitCatalog(rawWardrobe = null) {
  const cat = normalizeWardrobe(rawWardrobe);
  const looks = [];
  const pieceMap = new Map();

  for (const look of cat.wardrobe || []) {
    const seasonLabel = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' }[look.season] || null;
    const lookCard = {
      id: cardId('look', look.id),
      kind: 'look',
      title: look.style || look.summary?.slice(0, 24) || look.id,
      subtitle: [look.context || 'home', seasonLabel, look.id].filter(Boolean).join(' · '),
      summary: look.summary || '',
      context: look.context || 'home',
      style: look.style || '',
      season: look.season || null,
      lookId: look.id,
      pieces: look.pieces || {},
      wearable: true,
      tags: [look.context, look.style, seasonLabel && `${seasonLabel}季`].filter(Boolean),
    };
    looks.push(lookCard);

    for (const key of PIECE_KEYS) {
      const v = look.pieces?.[key];
      if (v == null || v === '') continue;
      const values = Array.isArray(v) ? v : [v];
      for (const item of values) {
        const text = String(item).trim();
        if (!text || text === '无' || text === '不出门') continue;
        // 专柜已独立展示的品类，单品区不再重复堆
        if (['bag', 'makeup', 'skincare', 'lips', 'eyes', 'nails', 'perfume', 'shoes', 'jewelry', 'watch', 'accessories'].includes(key)) continue;
        const id = cardId('piece', key, text);
        if (pieceMap.has(id)) {
          const prev = pieceMap.get(id);
          if (!prev.fromLooks.includes(look.id)) prev.fromLooks.push(look.id);
          continue;
        }
        pieceMap.set(id, {
          id,
          kind: 'piece',
          title: text,
          subtitle: PIECE_LABELS[key] || key,
          pieceKey: key,
          pieceKeyLabel: PIECE_LABELS[key] || key,
          summary: text,
          fromLooks: [look.id],
          wearable: false,
          tags: [PIECE_LABELS[key] || key],
        });
      }
    }
  }

  const bags = (cat.bags || []).map((label, i) => ({
    id: cardId('bag', label || i),
    kind: 'bag',
    title: String(label),
    subtitle: '包柜',
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

  const lingerie = (cat.lingerie || []).map((item) => ({
    id: cardId('lingerie', item.id || item.label),
    kind: 'lingerie',
    title: item.label,
    subtitle: [item.brand, item.kind].filter(Boolean).join(' · ') || '内衣',
    summary: item.notes || item.label,
    brand: item.brand || '',
    bra: item.bra || null,
    panties: item.panties || null,
    color: item.color || null,
    contexts: item.contexts || [],
    wearable: false,
    tags: [item.brand, item.kind, ...(item.contexts || [])].filter(Boolean),
  }));

  const shoes = drawerToCards(cat.shoes, 'shoe', '鞋履');
  const jewelry = drawerToCards(cat.jewelry, 'jewelry', '珠宝');
  const watches = drawerToCards(cat.watches, 'watch', '腕表');
  const accessories = drawerToCards(cat.accessories, 'accessory', '配饰');
  const outerwear = drawerToCards(cat.outerwear, 'outerwear', '外套');
  const travel = drawerToCards(cat.travel, 'travel', '旅行');

  const withPrompts = (list) =>
    list.map((card) => ({
      ...card,
      defaultPrompt: defaultPromptForCard(card),
    }));

  return {
    style: cat.style || '',
    beautyNotes: vanity.notes || '',
    defaults: cat.defaults || {},
    seasonal: cat.seasonal || {},
    counts: {
      looks: looks.length,
      pieces: pieceMap.size,
      bags: bags.length,
      beauty: beauty.length,
      lingerie: lingerie.length,
      shoes: shoes.length,
      jewelry: jewelry.length,
      watches: watches.length,
      accessories: accessories.length,
      outerwear: outerwear.length,
      travel: travel.length,
    },
    looks: withPrompts(looks),
    pieces: withPrompts([...pieceMap.values()]),
    bags: withPrompts(bags),
    beauty: withPrompts(beauty),
    lingerie: withPrompts(lingerie),
    shoes: withPrompts(shoes),
    jewelry: withPrompts(jewelry),
    watches: withPrompts(watches),
    accessories: withPrompts(accessories),
    outerwear: withPrompts(outerwear),
    travel: withPrompts(travel),
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
    const prompt = entry.prompt?.trim() ? entry.prompt : card.defaultPrompt;
    return {
      ...card,
      prompt,
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
