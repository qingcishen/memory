/**
 * P2 · 身份声明（产品层，非政府 KYC）
 * 存 userId → adultAffirmed / affirmedAt / method
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILE = path.join(ROOT, 'logs', 'product-identity.json');

export function loadIdentityStore(file = DEFAULT_FILE) {
  try {
    if (!fs.existsSync(file)) return { users: {} };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { users: {} };
  }
}

export function saveIdentityStore(store, file = DEFAULT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
  return store;
}

export function getIdentity(userId, file = DEFAULT_FILE) {
  if (!userId) return { adultAffirmed: false, affirmedAt: null, method: null };
  const store = loadIdentityStore(file);
  return store.users[userId] || { adultAffirmed: false, affirmedAt: null, method: null };
}

/**
 * 用户声明成年。method: self_declare | operator | import
 */
export function affirmAdult(userId, { method = 'self_declare', now = Date.now(), file = DEFAULT_FILE } = {}) {
  if (!userId) throw new Error('userId required');
  const store = loadIdentityStore(file);
  store.users[userId] = {
    adultAffirmed: true,
    affirmedAt: new Date(now).toISOString(),
    method,
  };
  saveIdentityStore(store, file);
  return store.users[userId];
}

export function revokeAdult(userId, file = DEFAULT_FILE) {
  if (!userId) return null;
  const store = loadIdentityStore(file);
  store.users[userId] = {
    adultAffirmed: false,
    affirmedAt: null,
    method: null,
    revokedAt: new Date().toISOString(),
  };
  saveIdentityStore(store, file);
  return store.users[userId];
}

/** 合并策略 requireAdult + 用户身份声明 */
export function resolveAdultGate(policy = {}, userId, file = DEFAULT_FILE) {
  if (!policy.requireAdultAffirmation) {
    return { required: false, affirmed: true, source: 'not_required' };
  }
  if (policy.adultAffirmed) {
    return { required: true, affirmed: true, source: 'global_policy' };
  }
  const id = getIdentity(userId, file);
  return {
    required: true,
    affirmed: Boolean(id.adultAffirmed),
    source: id.adultAffirmed ? 'user_identity' : 'missing',
    identity: id,
  };
}

export { DEFAULT_FILE as IDENTITY_FILE };
