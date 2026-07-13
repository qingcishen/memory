/**
 * 穿搭/相册卡片资产元数据 → Supabase
 * 图片本体 → Cloudflare R2（url 字段）；库内不再存 base64。
 */

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const ALLOWED = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

export function normalizeCardKey(cardId) {
  return String(cardId || '').trim().slice(0, 160);
}

export function normalizeCollection(collection) {
  return collection === 'album' ? 'album' : 'outfit';
}

export function rowHasImageFlag(row) {
  if (!row) return false;
  if (row.url) return true;
  if (row.mime) return true;
  if (row.meta && typeof row.meta === 'object' && row.meta.has_image) return true;
  return false;
}

export function rowsToAssetMapLite(rows = []) {
  const map = {};
  for (const row of rows || []) {
    if (!row?.card_id) continue;
    const hasImage = rowHasImageFlag(row);
    map[row.card_id] = {
      prompt: row.prompt || null,
      mime: row.mime || null,
      url: row.url || null,
      r2_key: row.r2_key || row.meta?.r2_key || null,
      meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
      updatedAt: row.updated_at || null,
      hasImage,
    };
  }
  return map;
}

/** @deprecated 兼容旧名 */
export function rowsToAssetMap(rows = []) {
  return rowsToAssetMapLite(rows);
}

/**
 * 卡片列表挂上 prompt / 图片公网 URL（优先 R2 url，不再走本机代理）
 */
export function attachAssetsToCards(cards, assetMap, { companionId = 'default', collection = 'outfit' } = {}) {
  const col = normalizeCollection(collection);
  return (cards || []).map((card) => {
    const entry = assetMap[card.id] || {};
    const prompt = entry.prompt?.trim() ? entry.prompt : card.defaultPrompt || card.prompt || '';
    const hasImage = Boolean(entry.hasImage || entry.url);
    // 有 R2 公网地址直接用；否则回退本机代理（旧 base64 行）
    let imageUrl = null;
    if (entry.url) {
      imageUrl = entry.url;
    } else if (hasImage) {
      const t = entry.updatedAt || '';
      imageUrl = `/api/${col === 'album' ? 'album' : 'outfit'}/media/${encodeURIComponent(card.id)}/file?companionId=${encodeURIComponent(companionId)}&t=${encodeURIComponent(t)}`;
    }
    return {
      ...card,
      prompt,
      hasCustomPrompt: Boolean(entry.prompt?.trim()),
      hasImage,
      imageUrl,
      updatedAt: entry.updatedAt || null,
    };
  });
}

export function validateImagePayload({ mime, data } = {}) {
  const ext = ALLOWED.get(String(mime || '').toLowerCase());
  if (!ext) throw new Error('只支持 PNG、JPEG 和 WebP');
  const base64 = String(data || '').replace(/^data:[^;]+;base64,/, '');
  if (!base64) throw new Error('图片内容为空');
  const approx = Math.floor((base64.length * 3) / 4);
  if (approx > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 15MB');
  return { mime: String(mime).toLowerCase(), base64, bytes: approx, ext };
}

export function listAssetsPath(companionId, collection) {
  const cid = encodeURIComponent(String(companionId || 'default'));
  const col = normalizeCollection(collection);
  return `companion_card_assets?companion_id=eq.${cid}&collection=eq.${col}&select=card_id,prompt,mime,url,r2_key,meta,updated_at&order=updated_at.desc&limit=2000`;
}

export function oneAssetPath(companionId, collection, cardId, { withImage = false } = {}) {
  const cid = encodeURIComponent(String(companionId || 'default'));
  const col = normalizeCollection(collection);
  const kid = encodeURIComponent(normalizeCardKey(cardId));
  // withImage 仅兼容旧 base64 行；新链路用 url
  const select = withImage
    ? 'card_id,prompt,mime,url,r2_key,image_base64,meta,updated_at'
    : 'card_id,prompt,mime,url,r2_key,meta,updated_at';
  return `companion_card_assets?companion_id=eq.${cid}&collection=eq.${col}&card_id=eq.${kid}&select=${select}&limit=1`;
}

export function upsertAssetBody(companionId, collection, cardId, patch = {}) {
  const now = new Date().toISOString();
  const row = {
    companion_id: String(companionId || 'default'),
    collection: normalizeCollection(collection),
    card_id: normalizeCardKey(cardId),
    updated_at: now,
    created_at: now,
  };
  if (patch.prompt !== undefined) row.prompt = patch.prompt == null ? null : String(patch.prompt).slice(0, 4000);
  if (patch.mime !== undefined) row.mime = patch.mime;
  if (patch.url !== undefined) row.url = patch.url;
  if (patch.r2_key !== undefined) row.r2_key = patch.r2_key;
  if (patch.meta !== undefined) row.meta = patch.meta;
  if (patch.clearImage) {
    row.mime = null;
    row.url = null;
    row.r2_key = null;
    row.image_base64 = null;
    row.meta = { ...(patch.meta || {}), has_image: false };
  }
  if (patch.url) {
    row.meta = { ...(row.meta || patch.meta || {}), has_image: true, r2_key: patch.r2_key || undefined };
    // 新图走 R2 后清空库内 base64
    row.image_base64 = null;
  }
  return row;
}

export function listCustomAlbumPath(companionId) {
  const cid = encodeURIComponent(String(companionId || 'default'));
  return `album_custom_entries?companion_id=eq.${cid}&select=id,title,subtitle,summary,context,style,prompt,tags,created_at,updated_at&order=updated_at.desc&limit=200`;
}

export function upsertCustomAlbumBody(companionId, entry = {}) {
  const id = String(entry.id || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`).slice(0, 40);
  const title = String(entry.title || '').trim().slice(0, 80);
  if (!title) throw new Error('请填写标题');
  const now = new Date().toISOString();
  return {
    id,
    companion_id: String(companionId || 'default'),
    title,
    subtitle: String(entry.subtitle || '自定义').slice(0, 80),
    summary: String(entry.summary || title).slice(0, 240),
    context: String(entry.context || 'home').slice(0, 20),
    style: String(entry.style || '自定义').slice(0, 40),
    prompt: entry.prompt ? String(entry.prompt).slice(0, 4000) : null,
    tags: Array.isArray(entry.tags) ? entry.tags.map(String).slice(0, 6) : ['自定义'],
    updated_at: now,
    created_at: entry.created_at || now,
  };
}

export function decodeImageBase64(entry) {
  if (!entry?.image_base64) return null;
  const mime = entry.mime || 'image/png';
  const buf = Buffer.from(String(entry.image_base64), 'base64');
  if (!buf.length) return null;
  return { mime, buffer: buf };
}
