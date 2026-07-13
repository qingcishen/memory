/**
 * 用户自定义整套造型（look 卡）
 * 存在 companions/<id>/outfit-custom-looks.json，与衣橱默认 look 合并展示。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OUTFIT_CONTEXTS, normalizeLook, PIECE_KEYS } from './outfit.js';

export function customLooksFilePath(companionRoot) {
  return path.join(companionRoot, 'outfit-custom-looks.json');
}

export function readCustomLooks(companionRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(customLooksFilePath(companionRoot), 'utf8'));
    const list = Array.isArray(raw?.looks) ? raw.looks : Array.isArray(raw) ? raw : [];
    return list.map(normalizeCustomLook).filter(Boolean);
  } catch {
    return [];
  }
}

export function writeCustomLooks(companionRoot, looks = []) {
  const dir = companionRoot;
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    looks: (looks || []).map(normalizeCustomLook).filter(Boolean),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(customLooksFilePath(companionRoot), `${JSON.stringify(payload, null, 2)}\n`);
  return payload.looks;
}

function slugId(title = '') {
  const base = String(title || 'look')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u4e00-\u9fff._-]+/g, '')
    .slice(0, 40) || 'look';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `custom_${base}_${suffix}`.slice(0, 60);
}

export function normalizeCustomLook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.style || raw.title || raw.label || '').trim().slice(0, 80);
  const summary = String(raw.summary || raw.notes || title).trim().slice(0, 400);
  if (!title && !summary) return null;
  const id = String(raw.id || '').trim().slice(0, 60) || slugId(title || summary);
  const pieces = {};
  if (raw.pieces && typeof raw.pieces === 'object' && !Array.isArray(raw.pieces)) {
    for (const key of PIECE_KEYS) {
      if (raw.pieces[key] == null || raw.pieces[key] === '') continue;
      pieces[key] = Array.isArray(raw.pieces[key])
        ? raw.pieces[key].map(String).filter(Boolean).slice(0, 8)
        : String(raw.pieces[key]).slice(0, 120);
    }
  }
  // 快捷字段：用户只填裙子/鞋/包时也能落 pieces
  for (const key of ['dress', 'top', 'bottom', 'outer', 'shoes', 'bag', 'jewelry', 'watch', 'hair', 'makeup']) {
    if (raw[key] && !pieces[key]) pieces[key] = String(raw[key]).slice(0, 120);
  }
  const look = normalizeLook({
    id,
    context: OUTFIT_CONTEXTS.includes(raw.context) ? raw.context : 'home',
    summary: summary || title,
    style: title || summary.slice(0, 28),
    pieces,
    season: raw.season || null,
  });
  if (!look) return null;
  return {
    ...look,
    source: 'custom',
    created_at: raw.created_at || new Date().toISOString(),
    updated_at: raw.updated_at || new Date().toISOString(),
    // 创建时可选初始提示词（也会写入 card assets）
    prompt: raw.prompt ? String(raw.prompt).slice(0, 4000) : '',
  };
}

/**
 * 新建自定义造型
 */
export function createCustomLook(companionRoot, entry = {}) {
  const list = readCustomLooks(companionRoot);
  const look = normalizeCustomLook({
    ...entry,
    id: entry.id || slugId(entry.title || entry.style || entry.summary),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (!look) throw new Error('请填写造型标题或摘要');
  if (list.some((x) => x.id === look.id)) throw new Error('造型 ID 已存在');
  list.unshift(look);
  writeCustomLooks(companionRoot, list);
  return look;
}

export function updateCustomLook(companionRoot, lookId, patch = {}) {
  const list = readCustomLooks(companionRoot);
  const i = list.findIndex((x) => x.id === String(lookId));
  if (i < 0) return null;
  const next = normalizeCustomLook({
    ...list[i],
    ...patch,
    id: list[i].id,
    created_at: list[i].created_at,
    updated_at: new Date().toISOString(),
  });
  if (!next) throw new Error('更新后内容无效');
  list[i] = next;
  writeCustomLooks(companionRoot, list);
  return next;
}

export function deleteCustomLook(companionRoot, lookId) {
  const list = readCustomLooks(companionRoot);
  const next = list.filter((x) => x.id !== String(lookId));
  if (next.length === list.length) return false;
  writeCustomLooks(companionRoot, next);
  return true;
}

export function findCustomLook(companionRoot, lookId) {
  return readCustomLooks(companionRoot).find((x) => x.id === String(lookId)) || null;
}

/** 合并进 buildOutfitCatalog 用的 wardrobe 条目形态 */
export function customLookToWardrobeItem(look) {
  const L = normalizeCustomLook(look);
  if (!L) return null;
  return {
    id: L.id,
    context: L.context,
    summary: L.summary,
    style: L.style,
    pieces: L.pieces,
    season: L.season,
    source: 'custom',
  };
}
