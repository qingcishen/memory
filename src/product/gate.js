/**
 * P2 · 统一写路径门控：安全 + 配额 + 身份 + 审计 + 账单计数
 * UI / Telegram / 飞书 共用，避免只挡试聊。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSafetyPolicy, checkMessageSafety, DEFAULT_SAFETY_POLICY } from './safety.js';
import { normalizeQuota, checkQuota, canWriteAction, DEFAULT_QUOTA } from './quota.js';
import { appendAudit } from './audit.js';
import { getTenantUsage, recordMessageUsage, recordBlocked } from './billing.js';
import { resolveAdultGate, getIdentity } from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const POLICY_FILE = path.join(ROOT, 'config', 'product-policy.json');

export function loadProductPolicy(file = POLICY_FILE) {
  let raw = {};
  try {
    if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = {};
  }
  return {
    safety: normalizeSafetyPolicy(raw.safety || DEFAULT_SAFETY_POLICY),
    quota: normalizeQuota(raw.quota || DEFAULT_QUOTA),
    updatedAt: raw.updatedAt || null,
  };
}

/**
 * 入站消息门控。
 * @returns {{
 *   allow: boolean,
 *   userMessage?: string,
 *   replyText?: string,
 *   safety: object,
 *   quota: object,
 *   stopIntimate: boolean,
 *   intimacyAllowed: boolean,
 *   reasons: string[],
 * }}
 */
export function gateIncomingMessage({
  text = '',
  userId,
  companionId = 'default',
  channel = 'unknown',
  action = 'message',
  policy,
  usage,
  recordUsage = true,
} = {}) {
  const pol = policy || loadProductPolicy();
  const safetyPolicy = { ...pol.safety };
  // 身份声明覆盖全局 adultAffirmed
  const adult = resolveAdultGate(safetyPolicy, userId);
  if (adult.required && adult.affirmed && adult.source === 'user_identity') {
    safetyPolicy.adultAffirmed = true;
  }

  const safety = checkMessageSafety(text, safetyPolicy);
  const usageSnap = usage || getTenantUsage(userId, companionId);
  const quota = checkQuota(usageSnap, pol.quota);
  const reasons = [...(safety.reasons || [])];

  if (safety.block) {
    if (recordUsage) recordBlocked(userId, companionId);
    appendAudit({
      action: 'message_blocked_safety',
      channel,
      userId,
      companionId,
      ok: false,
      reasons: safety.reasons,
      textPreview: text,
    });
    return {
      allow: false,
      replyText: '这条消息我这边接不了。换个说法，或者我们聊点别的。',
      safety,
      quota,
      stopIntimate: true,
      intimacyAllowed: false,
      reasons,
      adult,
    };
  }

  if (!canWriteAction(quota, action)) {
    if (recordUsage) recordBlocked(userId, companionId);
    appendAudit({
      action: 'message_blocked_quota',
      channel,
      userId,
      companionId,
      ok: false,
      reasons: quota.reasons,
      textPreview: text,
      detail: { remaining: quota.remaining },
    });
    return {
      allow: false,
      replyText: '今天聊得有点多了，我先歇会儿。明天再继续好不好？',
      safety,
      quota,
      stopIntimate: safety.stopIntimate,
      intimacyAllowed: safety.intimacyAllowed,
      reasons: [...reasons, ...(quota.reasons || [])],
      adult,
    };
  }

  if (recordUsage && action === 'message') {
    recordMessageUsage(userId, companionId);
  }

  appendAudit({
    action: 'message_allowed',
    channel,
    userId,
    companionId,
    ok: true,
    reasons: safety.stopIntimate ? ['stop_intimate'] : [],
    textPreview: text,
  });

  return {
    allow: true,
    userMessage: text,
    safety,
    quota,
    stopIntimate: safety.stopIntimate,
    intimacyAllowed: safety.intimacyAllowed,
    reasons,
    adult,
  };
}

/**
 * 相册引用进对话：生成用户侧消息文本（可注入试聊 composer / 直接当 user turn）
 */
export function buildAlbumQuoteMessage(card = {}) {
  const title = card.title || card.id || '这套';
  const prompt = (card.prompt || '').trim();
  const url = card.imageUrl || card.url || '';
  const context = card.context ? `（${card.context}）` : '';
  const lines = [
    `【相册引用】${title}${context}`,
    url ? `图：${url}` : '',
    prompt ? `提示词：${prompt.slice(0, 200)}` : '',
    '你今天可以穿成这样吗？ / 这套好看吗？',
  ].filter(Boolean);
  return lines.join('\n');
}

export { POLICY_FILE };
