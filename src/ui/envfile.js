// .env 文件的读写纯逻辑 (供本地控制台 src/ui/server.js 使用)。
//
// 与 dotenv 的解析保持兼容的子集: `KEY=value`、`#` 注释、空行。
// 写回时保留原文件的注释与顺序, 只替换目标 KEY 所在行; 新 KEY 追加到文件末尾。
// 全部为纯函数, 不碰磁盘 —— 磁盘 IO 在 server.js 里做, 这里可离线单测。

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** env 文本 -> { KEY: value }。带引号的值去引号; 未加引号的值把行内 ` #` 后视为注释截掉。 */
export function parseEnvText(text = '') {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    out[m[1]] = parseValue(m[2]);
  }
  return out;
}

function parseValue(raw = '') {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"') ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner;
  }
  // 未加引号: 行内注释从 " #" 开始 (与 dotenv 行为一致)
  const hash = trimmed.search(/\s#/);
  return (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim();
}

/** 值里带空格/#/引号时加引号转义, 否则原样写。 */
export function formatEnvValue(value = '') {
  const s = String(value ?? '');
  if (s === '' || /[\s#'"\\]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return s;
}

/**
 * 把 updates ({ KEY: value }) 应用到 env 原文上:
 * - 已存在的 KEY 原地替换 (保留它前后的注释与顺序), 同名多行只保留第一行、其余删除;
 * - 不存在的 KEY 追加到文件末尾;
 * - value 为 null/undefined 视为 "不改动" (跳过), 空字符串是合法值 (写成 KEY=)。
 */
export function applyEnvUpdates(text = '', updates = {}) {
  const pending = new Map(
    Object.entries(updates).filter(([, v]) => v !== null && v !== undefined),
  );
  if (pending.size === 0) return text;

  const seen = new Set();
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (const rawLine of lines) {
    const m = LINE_RE.exec(rawLine.trim());
    const key = m && !rawLine.trim().startsWith('#') ? m[1] : null;
    if (key && pending.has(key)) {
      if (seen.has(key)) continue; // 同名重复行: 只保留第一处
      seen.add(key);
      out.push(`${key}=${formatEnvValue(pending.get(key))}`);
      continue;
    }
    out.push(rawLine);
  }

  const missing = [...pending.keys()].filter((k) => !seen.has(k));
  if (missing.length > 0) {
    while (out.length > 0 && out.at(-1).trim() === '') out.pop();
    out.push('', '# ---- 由控制台补充 ----');
    for (const k of missing) out.push(`${k}=${formatEnvValue(pending.get(k))}`);
  }
  const result = out.join('\n');
  return result.endsWith('\n') ? result : `${result}\n`;
}

/** 密钥脱敏: 只暴露末 4 位, 太短则全遮。空值返回空串 (前端据此显示"未配置")。 */
export function maskValue(value = '') {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '••••••';
  return `••••••${s.slice(-4)}`;
}
