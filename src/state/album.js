/**
 * 穿搭相册（Lookbook）：展示「她穿上之后」的效果图。
 * 卡片与穿搭系统同构：正面照片 / 背面 AI 提示词；图与自定义提示词存在 companions/<id>/album-assets。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWardrobe, PIECE_KEYS, OUTFIT_CONTEXTS } from './outfit.js';

const ALLOWED = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

const CONTEXT_SCENE = {
  work: 'modern luxury office or boardroom corridor, soft daylight',
  home: 'soft luxury apartment interior, warm evening light',
  intimate: 'intimate private suite, dim warm lamp, tasteful non-explicit',
  date: 'upscale restaurant or evening city, cinematic soft light',
  outing: 'quiet city street or gallery cafe, natural daylight',
  sport: 'premium fitness studio or park path, clean daylight',
  sleep: 'luxury bedroom morning light, soft and quiet',
  sick: 'home rest, soft muted light, understated',
};

function piecesLine(pieces = {}) {
  const parts = [];
  for (const key of PIECE_KEYS) {
    const v = pieces[key];
    if (v == null || v === '') continue;
    if (Array.isArray(v)) parts.push(v.join(', '));
    else parts.push(String(v));
  }
  return parts.join('; ');
}

export function albumCardId(lookId) {
  return `album:look:${String(lookId || '').slice(0, 60)}`;
}

export function defaultWearingPrompt(look) {
  const summary = look.summary || look.title || look.style || '';
  const pieces = piecesLine(look.pieces || {});
  const scene = CONTEXT_SCENE[look.context] || 'refined lifestyle setting';
  const season = look.season ? `Season mood: ${look.season}` : '';
  const shoes = look.pieces?.shoes;
  // 延迟 import 避免环依赖：album ← outfit ← appearance
  // assemble 用字符串拼接，与 promptKit 语义对齐
  const shoeLine = shoes && !/赤脚|光脚|barefoot/i.test(String(shoes))
    ? `Shoes fully visible: ${shoes}.`
    : 'Complete visible elegant footwear required, no barefoot.';
  return [
    'Photorealistic full-body head-to-toe fashion portrait of a mature elegant adult East Asian woman,',
    'refined married-woman elegance, soft warmth, tasteful femininity, identity lock: face shape and facial proportions only,',
    'same woman consistently, not schoolgirl, not vulgar sexy.',
    `Wearing: ${summary}.`,
    pieces ? `Outfit details: ${pieces}.` : '',
    shoeLine,
    `Setting: ${scene}.${season ? ` ${season}.` : ''}`,
    'Full-length figure, feet not cropped, shoes complete and clear, fabric drape and tailoring detail,',
    'soft film grain, low saturation, shallow DOF, realistic skin pores, luxury lifestyle editorial,',
    'no text, no watermark, no logo.',
    'Avoid: barefoot, cropped feet, childish face, copied generic stock pose, cheap sexy, plastic skin, collage.',
  ].filter(Boolean).join(' ');
}

/**
 * 从衣橱造型生成相册卡片（每套 look 一张「上身效果」卡）
 */
export function buildAlbumCatalog(rawWardrobe = null, customEntries = []) {
  const cat = normalizeWardrobe(rawWardrobe);
  const cards = [];

  for (const look of cat.wardrobe || []) {
    const card = {
      id: albumCardId(look.id),
      kind: 'wearing',
      source: 'look',
      lookId: look.id,
      title: look.style || look.summary?.slice(0, 28) || look.id,
      subtitle: [look.context, look.season, look.id].filter(Boolean).join(' · '),
      summary: look.summary || '',
      context: look.context || 'home',
      season: look.season || null,
      style: look.style || '',
      pieces: look.pieces || {},
      tags: [look.context, look.style, look.season].filter(Boolean),
      defaultPrompt: defaultWearingPrompt(look),
    };
    cards.push(card);
  }

  for (const raw of customEntries || []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim().slice(0, 80);
    const title = String(raw.title || raw.label || '').trim().slice(0, 80);
    if (!id || !title) continue;
    cards.push({
      id: id.startsWith('album:') ? id : `album:custom:${id}`,
      kind: 'wearing',
      source: 'custom',
      lookId: null,
      title,
      subtitle: String(raw.subtitle || '自定义').slice(0, 80),
      summary: String(raw.summary || raw.notes || title).slice(0, 240),
      context: OUTFIT_CONTEXTS.includes(raw.context) ? raw.context : 'home',
      season: null,
      style: String(raw.style || '自定义').slice(0, 40),
      pieces: {},
      tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 6) : ['自定义'],
      defaultPrompt: String(raw.prompt || raw.defaultPrompt || defaultWearingPrompt({
        summary: raw.summary || title,
        context: raw.context || 'home',
        pieces: {},
      })).slice(0, 4000),
    });
  }

  const byContext = {};
  for (const c of OUTFIT_CONTEXTS) byContext[c] = 0;
  for (const c of cards) {
    if (byContext[c.context] != null) byContext[c.context] += 1;
  }

  return {
    cards,
    counts: {
      total: cards.length,
      withLooks: cards.filter((c) => c.source === 'look').length,
      custom: cards.filter((c) => c.source === 'custom').length,
      ...byContext,
    },
  };
}

// ---------- 资产存储 ----------

export function albumAssetsDir(companionRoot) {
  return path.join(companionRoot, 'album-assets');
}

export function albumAssetsIndexPath(companionRoot) {
  return path.join(albumAssetsDir(companionRoot), 'index.json');
}

export function readAlbumAssets(companionRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(albumAssetsIndexPath(companionRoot), 'utf8'));
    return raw && typeof raw === 'object' ? raw : { cards: {}, custom: [] };
  } catch {
    return { cards: {}, custom: [] };
  }
}

export function writeAlbumAssets(companionRoot, data) {
  const dir = albumAssetsDir(companionRoot);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    cards: data?.cards && typeof data.cards === 'object' ? data.cards : {},
    custom: Array.isArray(data?.custom) ? data.custom : [],
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(albumAssetsIndexPath(companionRoot), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function saveAlbumPrompt(companionRoot, cardKey, prompt) {
  const index = readAlbumAssets(companionRoot);
  const prev = index.cards[cardKey] || {};
  index.cards[cardKey] = {
    ...prev,
    prompt: String(prompt || '').slice(0, 4000),
    updatedAt: new Date().toISOString(),
  };
  writeAlbumAssets(companionRoot, index);
  return index.cards[cardKey];
}

export function saveAlbumImage(companionRoot, cardKey, { mime, data, name = '' }) {
  const ext = ALLOWED.get(String(mime || '').toLowerCase());
  if (!ext) throw new Error('只支持 PNG、JPEG 和 WebP');
  const buffer = Buffer.from(String(data || ''), 'base64');
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('单张图片不能超过 20MB');

  const dir = albumAssetsDir(companionRoot);
  fs.mkdirSync(dir, { recursive: true });
  const index = readAlbumAssets(companionRoot);
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
  writeAlbumAssets(companionRoot, index);
  return index.cards[cardKey];
}

export function clearAlbumImage(companionRoot, cardKey) {
  const index = readAlbumAssets(companionRoot);
  const prev = index.cards[cardKey];
  if (!prev) return null;
  if (prev.file) {
    try {
      fs.unlinkSync(path.join(albumAssetsDir(companionRoot), path.basename(prev.file)));
    } catch {
      /* ignore */
    }
  }
  const { file, mime, bytes, name, ...rest } = prev;
  index.cards[cardKey] = { ...rest, updatedAt: new Date().toISOString() };
  if (!index.cards[cardKey].prompt) delete index.cards[cardKey];
  writeAlbumAssets(companionRoot, index);
  return true;
}

export function resolveAlbumFile(companionRoot, cardKey) {
  const entry = readAlbumAssets(companionRoot).cards?.[cardKey];
  if (!entry?.file) return null;
  const full = path.join(albumAssetsDir(companionRoot), path.basename(entry.file));
  if (!fs.existsSync(full)) return null;
  return { path: full, mime: entry.mime || 'image/png', entry };
}

export function addCustomAlbumEntry(companionRoot, entry = {}) {
  const index = readAlbumAssets(companionRoot);
  const id = String(entry.id || crypto.randomUUID()).slice(0, 40);
  const title = String(entry.title || '').trim().slice(0, 80);
  if (!title) throw new Error('请填写标题');
  const row = {
    id,
    title,
    subtitle: String(entry.subtitle || '自定义').slice(0, 80),
    summary: String(entry.summary || title).slice(0, 240),
    context: OUTFIT_CONTEXTS.includes(entry.context) ? entry.context : 'home',
    style: String(entry.style || '自定义').slice(0, 40),
    prompt: entry.prompt ? String(entry.prompt).slice(0, 4000) : '',
    tags: Array.isArray(entry.tags) ? entry.tags.map(String).slice(0, 6) : ['自定义'],
  };
  index.custom = [...(index.custom || []).filter((x) => x.id !== id), row];
  if (row.prompt) {
    index.cards[`album:custom:${id}`] = {
      ...(index.cards[`album:custom:${id}`] || {}),
      prompt: row.prompt,
      updatedAt: new Date().toISOString(),
    };
  }
  writeAlbumAssets(companionRoot, index);
  return row;
}

export function enrichAlbumWithAssets(catalog, companionRoot, { companionId = 'default' } = {}) {
  const assets = readAlbumAssets(companionRoot);
  const enrich = (card) => {
    const entry = assets.cards?.[card.id] || {};
    const prompt = entry.prompt?.trim() ? entry.prompt : card.defaultPrompt;
    return {
      ...card,
      prompt,
      hasCustomPrompt: Boolean(entry.prompt?.trim()),
      imageUrl: entry.file
        ? `/api/album/media/${encodeURIComponent(card.id)}/file?companionId=${encodeURIComponent(companionId)}&t=${encodeURIComponent(entry.updatedAt || '')}`
        : null,
      hasImage: Boolean(entry.file),
      updatedAt: entry.updatedAt || null,
    };
  };
  const cards = catalog.cards.map(enrich);
  const withImage = cards.filter((c) => c.hasImage).length;
  return {
    counts: {
      ...catalog.counts,
      withImage,
      pending: cards.length - withImage,
    },
    cards,
  };
}
