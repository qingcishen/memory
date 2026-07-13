/**
 * P2 · 审计日志（本地 JSONL，失败安全）
 * 记录：安全拦截、配额拒绝、导出/删除、身份声明、账单事件。
 * 不记完整密钥；消息内容默认截断。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_AUDIT_FILE = path.join(ROOT, 'logs', 'product-audit.jsonl');

/**
 * @param {{
 *   action: string,
 *   channel?: string,
 *   userId?: string,
 *   companionId?: string,
 *   ok?: boolean,
 *   reasons?: string[],
 *   detail?: object,
 *   textPreview?: string,
 * }} entry
 */
export function appendAudit(entry = {}, { file = DEFAULT_AUDIT_FILE } = {}) {
  const row = {
    at: new Date().toISOString(),
    action: String(entry.action || 'unknown'),
    channel: entry.channel || 'system',
    userId: entry.userId || null,
    companionId: entry.companionId || 'default',
    ok: entry.ok !== false,
    reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
    textPreview: entry.textPreview != null ? String(entry.textPreview).slice(0, 80) : undefined,
    detail: entry.detail && typeof entry.detail === 'object' ? slimDetail(entry.detail) : undefined,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  } catch (err) {
    console.error('[audit] write failed', err?.message || err);
  }
  return row;
}

export function readAuditTail({ file = DEFAULT_AUDIT_FILE, limit = 50 } = {}) {
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, limit)).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

function slimDetail(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 120);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 8);
    else out[k] = String(v).slice(0, 80);
  }
  return out;
}

export { DEFAULT_AUDIT_FILE };
