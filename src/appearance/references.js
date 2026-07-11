import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STORE = path.join(ROOT, 'config', 'reference-images');
const INDEX = path.join(STORE, 'index.json');
const ALLOWED = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return []; }
}
function writeIndex(rows) {
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(INDEX, `${JSON.stringify(rows, null, 2)}\n`);
}

export function listReferenceImages(userId, companionId = 'default') {
  return readIndex().filter((x) => x.userId === String(userId) && x.companionId === String(companionId));
}

export function readReferenceById(id) {
  return readIndex().find((x) => x.id === String(id)) || null;
}

export function referenceFilePath(item) {
  const file = path.basename(String(item?.file || ''));
  return file ? path.join(STORE, file) : '';
}

export function saveReferenceImage({ userId, companionId = 'default', name = '', mime = '', data = '' }) {
  const ext = ALLOWED.get(String(mime).toLowerCase());
  if (!ext) throw new Error('只支持 PNG、JPEG 和 WebP 参考图');
  const buffer = Buffer.from(String(data), 'base64');
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > 50 * 1024 * 1024) throw new Error('单张参考图不能超过 50MB');
  const id = crypto.randomUUID();
  const file = `${id}.${ext}`;
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, file), buffer);
  const item = { id, userId: String(userId), companionId: String(companionId), name: String(name || file).slice(0, 160), mime, file, bytes: buffer.length, createdAt: new Date().toISOString() };
  const rows = readIndex();
  rows.push(item);
  writeIndex(rows);
  return item;
}

export function deleteReferenceImage(id, userId, companionId = 'default') {
  const rows = readIndex();
  const item = rows.find((x) => x.id === id && x.userId === String(userId) && x.companionId === String(companionId));
  if (!item) return false;
  try { fs.unlinkSync(referenceFilePath(item)); } catch {}
  writeIndex(rows.filter((x) => x.id !== item.id));
  return true;
}
