/**
 * Cloudflare R2 图床（经 Cloudflare API 上传对象，公网用 r2.dev / 自定义域）。
 * 不依赖 AWS SDK；本地未配 CLOUDFLARE_API_TOKEN 时尝试读 wrangler OAuth。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_ACCOUNT = '2581ca9560b48b398983980c1668d0d2';
const DEFAULT_BUCKET = 'qingci-companion-media';
const DEFAULT_PUBLIC = 'https://pub-3e3edc57d51e421c97cf033aaa061cb0.r2.dev';

function parseTomlOauth(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const m = /^oauth_token\s*=\s*"([^"]+)"/m.exec(text);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

export function resolveR2Config(env = process.env) {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || env.R2_ACCOUNT_ID || DEFAULT_ACCOUNT).trim();
  const bucket = String(env.R2_BUCKET || DEFAULT_BUCKET).trim();
  const publicBase = String(env.R2_PUBLIC_BASE || DEFAULT_PUBLIC).replace(/\/+$/, '');
  let token = String(env.CLOUDFLARE_API_TOKEN || env.R2_API_TOKEN || env.CF_API_TOKEN || '').trim();
  if (!token) {
    // 本机开发：复用 wrangler login 的 token
    const wranglerToml = path.join(os.homedir(), 'Library/Preferences/.wrangler/config/default.toml');
    token = parseTomlOauth(wranglerToml);
  }
  return {
    accountId,
    bucket,
    publicBase,
    token,
    configured: Boolean(accountId && bucket && publicBase),
    canUpload: Boolean(accountId && bucket && publicBase && token),
  };
}

export function r2ObjectKey({ companionId = 'default', collection = 'outfit', cardId = '', ext = 'webp' } = {}) {
  const safeCompanion = String(companionId).replace(/[^\w.-]+/g, '_').slice(0, 64) || 'default';
  const safeCol = collection === 'album' ? 'album' : 'outfit';
  const safeCard = String(cardId)
    .replace(/[^a-zA-Z0-9:._\u4e00-\u9fff-]+/g, '_')
    .slice(0, 120) || crypto.randomUUID();
  const safeExt = String(ext || 'webp').replace(/[^\w]+/g, '') || 'webp';
  // 加短 hash 避免缓存粘住旧图
  const stamp = Date.now().toString(36);
  return `${safeCol}/${safeCompanion}/${safeCard}.${stamp}.${safeExt}`;
}

export function publicUrlForKey(key, env = process.env) {
  const { publicBase } = resolveR2Config(env);
  return `${publicBase}/${String(key).replace(/^\/+/, '')}`;
}

function extFromMime(mime = '') {
  const m = String(mime).toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  return 'bin';
}

/**
 * 上传二进制到 R2
 * @returns {{ ok, key, url, size, etag, message }}
 */
export async function uploadToR2(buffer, { mime = 'application/octet-stream', key, env = process.env } = {}) {
  const cfg = resolveR2Config(env);
  if (!cfg.canUpload) {
    return {
      ok: false,
      message: 'R2 未配置：需要 CLOUDFLARE_API_TOKEN（或本机 wrangler login）以及 R2_BUCKET / R2_PUBLIC_BASE',
    };
  }
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!body.length) return { ok: false, message: '图片内容为空' };
  if (body.length > 15 * 1024 * 1024) return { ok: false, message: '单张图片不能超过 15MB' };

  const objectKey = key || `misc/${crypto.randomUUID()}.${extFromMime(mime)}`;
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${encodeURIComponent(cfg.bucket)}/objects/${objectKey.split('/').map(encodeURIComponent).join('/')}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': mime || 'application/octet-stream',
    },
    body,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) {
    const err = json?.errors?.[0]?.message || json?.messages?.[0] || `HTTP ${res.status}`;
    return { ok: false, message: `R2 上传失败: ${String(err).slice(0, 200)}` };
  }
  return {
    ok: true,
    key: objectKey,
    url: publicUrlForKey(objectKey, env),
    size: body.length,
    etag: json?.result?.etag || null,
    message: '已上传到 Cloudflare R2',
  };
}

export async function uploadBase64ToR2(base64, { mime, companionId, collection, cardId, env = process.env } = {}) {
  const raw = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(raw, 'base64');
  const ext = extFromMime(mime);
  const key = r2ObjectKey({ companionId, collection, cardId, ext });
  return uploadToR2(buffer, { mime, key, env });
}

export async function deleteFromR2(key, env = process.env) {
  const cfg = resolveR2Config(env);
  if (!cfg.canUpload || !key) return { ok: false, message: '无法删除 R2 对象' };
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${encodeURIComponent(cfg.bucket)}/objects/${String(key).split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (res.status === 404) return { ok: true, message: '对象本就不存在' };
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) {
    const err = json?.errors?.[0]?.message || `HTTP ${res.status}`;
    return { ok: false, message: `R2 删除失败: ${String(err).slice(0, 200)}` };
  }
  return { ok: true, message: '已从 R2 删除' };
}

export { extFromMime };
