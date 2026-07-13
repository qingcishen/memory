/**
 * P2 · 租户账单骨架（本地 ledger，非支付通道）
 * 按 userId 记消息/出图/拦截次数，供配额与日后计费对齐。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeKey } from './quota.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_LEDGER = path.join(ROOT, 'logs', 'product-billing.json');

export function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function monthKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

export function loadLedger(file = DEFAULT_LEDGER) {
  try {
    if (!fs.existsSync(file)) return { tenants: {}, updatedAt: null };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { tenants: {}, updatedAt: null };
  }
}

export function saveLedger(ledger, file = DEFAULT_LEDGER) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...ledger, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function tenantBucket(ledger, userId, companionId = 'default') {
  const key = scopeKey(userId, companionId);
  if (!ledger.tenants[key]) {
    ledger.tenants[key] = {
      userId,
      companionId,
      messagesByDay: {},
      photosByDay: {},
      blockedByDay: {},
      tokensByMonth: {},
    };
  }
  return ledger.tenants[key];
}

/** 记一次允许通过的消息 */
export function recordMessageUsage(userId, companionId = 'default', { now = Date.now(), file = DEFAULT_LEDGER } = {}) {
  if (!userId) return null;
  const ledger = loadLedger(file);
  const t = tenantBucket(ledger, userId, companionId);
  const d = dayKey(now);
  t.messagesByDay[d] = (t.messagesByDay[d] || 0) + 1;
  saveLedger(ledger, file);
  return t.messagesByDay[d];
}

export function recordPhotoUsage(userId, companionId = 'default', { now = Date.now(), file = DEFAULT_LEDGER } = {}) {
  if (!userId) return null;
  const ledger = loadLedger(file);
  const t = tenantBucket(ledger, userId, companionId);
  const d = dayKey(now);
  t.photosByDay[d] = (t.photosByDay[d] || 0) + 1;
  saveLedger(ledger, file);
  return t.photosByDay[d];
}

export function recordBlocked(userId, companionId = 'default', { now = Date.now(), file = DEFAULT_LEDGER } = {}) {
  if (!userId) return null;
  const ledger = loadLedger(file);
  const t = tenantBucket(ledger, userId, companionId);
  const d = dayKey(now);
  t.blockedByDay[d] = (t.blockedByDay[d] || 0) + 1;
  saveLedger(ledger, file);
  return t.blockedByDay[d];
}

export function getTenantUsage(userId, companionId = 'default', { now = Date.now(), file = DEFAULT_LEDGER } = {}) {
  const ledger = loadLedger(file);
  const t = tenantBucket(ledger, userId || '_', companionId);
  const d = dayKey(now);
  const m = monthKey(now);
  return {
    messagesToday: t.messagesByDay[d] || 0,
    photosToday: t.photosByDay[d] || 0,
    blockedToday: t.blockedByDay[d] || 0,
    tokensMonth: t.tokensByMonth[m] || 0,
    memories: 0,
    companions: 1,
  };
}

/**
 * 简单账单摘要：本月消息/图/拦截 → 预估点（非真钱）
 */
export function buildBillingSummary(userId, companionId = 'default', { now = Date.now(), file = DEFAULT_LEDGER, rates } = {}) {
  const r = {
    messagePoint: 1,
    photoPoint: 8,
    ...(rates || {}),
  };
  const ledger = loadLedger(file);
  const t = tenantBucket(ledger, userId || '_', companionId);
  const m = monthKey(now);
  let messagesMonth = 0;
  let photosMonth = 0;
  let blockedMonth = 0;
  for (const [day, n] of Object.entries(t.messagesByDay || {})) {
    if (day.startsWith(m)) messagesMonth += n;
  }
  for (const [day, n] of Object.entries(t.photosByDay || {})) {
    if (day.startsWith(m)) photosMonth += n;
  }
  for (const [day, n] of Object.entries(t.blockedByDay || {})) {
    if (day.startsWith(m)) blockedMonth += n;
  }
  const points = messagesMonth * r.messagePoint + photosMonth * r.photoPoint;
  return {
    month: m,
    messagesMonth,
    photosMonth,
    blockedMonth,
    points,
    currency: 'points',
    note: '本地预估点，非支付通道。接入 Stripe 等时在此映射金额。',
  };
}

export { DEFAULT_LEDGER };
