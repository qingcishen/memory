/**
 * MCP 快捷连接目录：官方远程 MCP + 本应用相关服务。
 * 用于控制台「MCP 连接」页，一键生成/写入 Claude / Grok / Cursor 客户端配置。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** memory-system 仓库根目录（filesystem MCP 默认放行区） */
export const PROJECT_ROOT = path.resolve(__dirname, '../..');

const CLAUDE_MCP_PATH = path.join(os.homedir(), '.claude', 'mcp.json');
const GROK_CONFIG_PATH = path.join(os.homedir(), '.grok', 'config.toml');
const CURSOR_MCP_PATH = path.join(os.homedir(), '.cursor', 'mcp.json');

/**
 * 解析 Postgres 连接串：优先 DATABASE_URL / POSTGRES_URL；
 * 不在列表 API 里回传完整串，只用于写入客户端配置。
 */
export function resolveDatabaseUrl(env = {}) {
  return String(env.DATABASE_URL || env.POSTGRES_URL || env.SUPABASE_DB_URL || '').trim();
}

function resolveEntry(entry, env = {}) {
  const out = { ...entry };
  if (typeof entry.resolveArgs === 'function') {
    out.args = entry.resolveArgs(env);
  } else {
    out.args = Array.isArray(entry.args) ? [...entry.args] : [];
  }
  if (typeof entry.resolveEnv === 'function') {
    out.resolvedEnv = entry.resolveEnv(env);
  } else {
    out.resolvedEnv = {};
    for (const k of entry.envKeys || []) {
      if (String(env[k] || '').trim()) out.resolvedEnv[k] = String(env[k]).trim();
    }
  }
  // 动态就绪条件
  if (typeof entry.isReady === 'function') {
    out.ready = entry.isReady(env);
    out.readyHint = entry.readyHint || '';
  } else {
    out.ready = true;
    out.readyHint = '';
  }
  return out;
}

/** 静态目录定义；resolve* 在 list/install 时求值 */
const MCP_CATALOG_DEFS = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    brand: 'CF',
    color: '#f6821f',
    description: 'Workers · R2 · DNS · 账号与基础设施。穿搭图床 R2 运维可走这里。',
    transport: 'http',
    url: 'https://mcp.cloudflare.com/mcp',
    auth: 'oauth',
    docs: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    dashboard: 'https://dash.cloudflare.com/',
    relatedEnv: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'R2_BUCKET', 'R2_PUBLIC_BASE'],
    tags: ['r2', 'workers', 'cdn'],
    clients: ['grok', 'claude', 'cursor'],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    brand: 'SB',
    color: '#3ecf8e',
    description: '项目、表结构、SQL、密钥。记忆库 / life_state / 卡片元数据都在这里。',
    transport: 'http',
    url: 'https://mcp.supabase.com/mcp',
    auth: 'oauth',
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
    dashboard: 'https://supabase.com/dashboard/project/_?showConnect=true&connectTab=mcp',
    relatedEnv: ['SUPABASE_URL', 'SUPABASE_KEY', 'SUPABASE_ACCESS_TOKEN'],
    tags: ['postgres', 'auth', 'storage'],
    clients: ['grok', 'claude', 'cursor'],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    brand: 'FS',
    color: '#6366f1',
    description: `读写本仓库文件（默认根目录 memory-system）。改 companions/*/outfit.json、读 logs 最方便。`,
    transport: 'stdio',
    command: 'npx',
    resolveArgs: () => ['-y', '@modelcontextprotocol/server-filesystem', PROJECT_ROOT],
    auth: 'local',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    dashboard: null,
    relatedEnv: [],
    tags: ['files', 'local', 'dev'],
    clients: ['grok', 'claude', 'cursor'],
    readyHint: `放行目录: ${PROJECT_ROOT}`,
  },
  {
    id: 'postgres',
    name: 'Postgres（建议只读）',
    brand: 'PG',
    color: '#336791',
    description: '直连 Postgres：查 memories / outfit / intimacy。请使用只读角色连接串，勿用超级用户。',
    transport: 'stdio',
    command: 'npx',
    // 官方参考实现：连接串作为最后一个参数
    resolveArgs: (env) => {
      const url = resolveDatabaseUrl(env);
      return url
        ? ['-y', '@modelcontextprotocol/server-postgres', url]
        : ['-y', '@modelcontextprotocol/server-postgres', '<DATABASE_URL>'];
    },
    envKeys: ['DATABASE_URL'],
    resolveEnv: (env) => {
      const url = resolveDatabaseUrl(env);
      return url ? { DATABASE_URL: url } : {};
    },
    isReady: (env) => Boolean(resolveDatabaseUrl(env)),
    readyHint: '在「设置与模型」配置 DATABASE_URL（Supabase → Database → Connection string）',
    auth: 'token',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    dashboard: 'https://supabase.com/dashboard/project/_/settings/database',
    relatedEnv: ['DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_DB_URL'],
    tags: ['sql', 'readonly', 'dev'],
    clients: ['grok', 'claude', 'cursor'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    brand: 'PW',
    color: '#2EAD33',
    description: '浏览器自动化：测本机 UI（穿搭/相册/设置）、截图回归。',
    transport: 'stdio',
    command: 'npx',
    resolveArgs: () => ['-y', '@playwright/mcp@latest'],
    auth: 'local',
    docs: 'https://github.com/microsoft/playwright-mcp',
    dashboard: 'http://127.0.0.1:8787/',
    relatedEnv: [],
    tags: ['browser', 'ui', 'e2e'],
    clients: ['grok', 'claude', 'cursor'],
    readyHint: '首次运行会自动拉 Playwright 浏览器，可能稍慢',
  },
  {
    id: 'github',
    name: 'GitHub',
    brand: 'GH',
    color: '#24292f',
    description: '仓库、Issue、PR。适合让 AI 直接提 PR / 查代码。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@github/mcp-server'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    auth: 'token',
    docs: 'https://github.com/github/github-mcp-server',
    dashboard: 'https://github.com/settings/tokens',
    relatedEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    tags: ['git', 'pr'],
    clients: ['grok', 'claude', 'cursor'],
    isReady: (env) => Boolean(String(env.GITHUB_PERSONAL_ACCESS_TOKEN || '').trim()),
    readyHint: '需要 GITHUB_PERSONAL_ACCESS_TOKEN（可写在客户端配置 env 里）',
  },
];

/** 对外兼容：静态列表（无动态 resolve） */
export const MCP_CATALOG = MCP_CATALOG_DEFS;

export function clientConfigPaths() {
  return {
    claude: CLAUDE_MCP_PATH,
    grok: GROK_CONFIG_PATH,
    cursor: CURSOR_MCP_PATH,
  };
}

/** 生成客户端配置片段（token 用占位；postgres 连接串不出现在 snippet 明文时可显示占位） */
export function buildClientSnippet(entryDef, client = 'claude', opts = {}) {
  const entry = resolveEntry(entryDef, opts.env || {});
  if (!entry) return null;
  if (entry.transport === 'http') {
    if (client === 'grok') {
      return [
        `[mcp_servers.${entry.id}]`,
        `url = "${entry.url}"`,
        'enabled = true',
        '# 首次连接会走 OAuth 浏览器授权',
      ].join('\n');
    }
    return JSON.stringify({
      mcpServers: {
        [entry.id]: { type: 'http', url: entry.url },
      },
    }, null, 2);
  }

  // stdio — snippet 里对敏感 arg（含 postgresql://）打码
  const safeArgs = (entry.args || []).map((a) => {
    if (typeof a === 'string' && /^postgres(ql)?:\/\//i.test(a)) return '<DATABASE_URL>';
    return a;
  });
  const env = {};
  for (const k of entry.envKeys || []) {
    env[k] = opts.env?.[k] ? '<已配置，安装时写入>' : `<${k}>`;
  }
  // filesystem / playwright 无 env
  if (client === 'grok') {
    const envToml = Object.entries(env)
      .filter(([, v]) => v && !String(v).startsWith('<已配置'))
      .map(([k, v]) => `  ${k} = "${v}"`)
      .join('\n');
    return [
      `[mcp_servers.${entry.id}]`,
      `command = "${entry.command}"`,
      `args = ${JSON.stringify(safeArgs)}`,
      'enabled = true',
      entry.readyHint ? `# ${entry.readyHint}` : '',
      envToml ? `[mcp_servers.${entry.id}.env]\n${envToml}` : '',
    ].filter(Boolean).join('\n');
  }
  const body = {
    command: entry.command,
    args: safeArgs,
  };
  if (Object.keys(env).length) body.env = env;
  return JSON.stringify({ mcpServers: { [entry.id]: body } }, null, 2);
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTextSafe(file) {
  try {
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function detectInstalled(entry) {
  const claude = readJsonSafe(CLAUDE_MCP_PATH);
  const cursor = readJsonSafe(CURSOR_MCP_PATH);
  const grok = readTextSafe(GROK_CONFIG_PATH);
  const inClaude = Boolean(claude?.mcpServers?.[entry.id]);
  const inCursor = Boolean(cursor?.mcpServers?.[entry.id]);
  const inGrok = Boolean(entry.id && grok.includes(`[mcp_servers.${entry.id}]`))
    || (entry.url ? grok.includes(entry.url) : false);
  return {
    claude: { path: CLAUDE_MCP_PATH, installed: inClaude, exists: fs.existsSync(CLAUDE_MCP_PATH) },
    cursor: { path: CURSOR_MCP_PATH, installed: inCursor, exists: fs.existsSync(CURSOR_MCP_PATH) },
    grok: { path: GROK_CONFIG_PATH, installed: inGrok, exists: fs.existsSync(GROK_CONFIG_PATH) },
  };
}

export function listMcpCatalog({ env = {} } = {}) {
  return MCP_CATALOG_DEFS.map((def) => {
    const entry = resolveEntry(def, env);
    const installed = detectInstalled(entry);
    const envStatus = {};
    for (const k of entry.relatedEnv || []) {
      envStatus[k] = Boolean(String(env[k] || '').trim());
    }
    // 不把连接串/token 塞进 API 响应
    const publicEntry = { ...entry };
    delete publicEntry.resolveArgs;
    delete publicEntry.resolveEnv;
    delete publicEntry.isReady;
    delete publicEntry.resolvedEnv;
    // args 中若含连接串则打码
    publicEntry.args = (entry.args || []).map((a) => (
      typeof a === 'string' && /^postgres(ql)?:\/\//i.test(a) ? '<DATABASE_URL>' : a
    ));
    return {
      ...publicEntry,
      installed,
      envStatus,
      envReady: entry.ready !== false && (
        Object.keys(envStatus).length === 0
        || Object.values(envStatus).some(Boolean)
        || entry.auth === 'local'
        || entry.auth === 'oauth'
      ),
      ready: entry.ready !== false,
      readyHint: entry.readyHint || '',
      projectRoot: entry.id === 'filesystem' ? PROJECT_ROOT : undefined,
      snippets: {
        grok: buildClientSnippet(def, 'grok', { env }),
        claude: buildClientSnippet(def, 'claude', { env }),
        cursor: buildClientSnippet(def, 'cursor', { env }),
      },
    };
  });
}

export function installMcpToClient(entryId, client, { confirm = false, env = {} } = {}) {
  if (!confirm) return { ok: false, message: '需要 confirm: true 才会写入客户端配置' };
  const def = MCP_CATALOG_DEFS.find((x) => x.id === entryId);
  if (!def) return { ok: false, message: `未知 MCP: ${entryId}` };
  if (!['claude', 'cursor', 'grok'].includes(client)) return { ok: false, message: 'client 仅支持 claude / cursor / grok' };

  const entry = resolveEntry(def, env);
  if (entry.ready === false) {
    return { ok: false, message: entry.readyHint || `请先配置 ${entryId} 所需凭证` };
  }
  if (client === 'grok') return installGrok(entry, env);
  const file = client === 'claude' ? CLAUDE_MCP_PATH : CURSOR_MCP_PATH;
  return installJsonMcp(file, entry, env);
}

function installJsonMcp(file, entry, env) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readJsonSafe(file) || { mcpServers: {} };
  if (!current.mcpServers || typeof current.mcpServers !== 'object') current.mcpServers = {};
  if (entry.transport === 'http') {
    current.mcpServers[entry.id] = { type: 'http', url: entry.url };
  } else {
    const envObj = { ...(entry.resolvedEnv || {}) };
    for (const k of entry.envKeys || []) {
      const prev = current.mcpServers[entry.id]?.env?.[k];
      const fromEnv = String(env[k] || entry.resolvedEnv?.[k] || '').trim();
      if (fromEnv) envObj[k] = fromEnv;
      else if (prev) envObj[k] = prev;
    }
    current.mcpServers[entry.id] = {
      command: entry.command,
      args: entry.args || [],
      ...(Object.keys(envObj).length ? { env: envObj } : {}),
    };
  }
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  return { ok: true, message: `已写入 ${file}`, path: file, id: entry.id };
}

function installGrok(entry, env) {
  fs.mkdirSync(path.dirname(GROK_CONFIG_PATH), { recursive: true });
  let text = readTextSafe(GROK_CONFIG_PATH) || '# Grok config\n';
  // 删掉旧 section + .env 子表
  text = text.replace(new RegExp(`\\n*\\[mcp_servers\\.${entry.id}\\.env\\][\\s\\S]*?(?=\\n\\[|$)`), '\n');
  text = text.replace(new RegExp(`\\n*\\[mcp_servers\\.${entry.id}\\][\\s\\S]*?(?=\\n\\[|$)`), '\n');

  let block;
  if (entry.transport === 'http') {
    block = `[mcp_servers.${entry.id}]\nurl = "${entry.url}"\nenabled = true\n`;
  } else {
    const envObj = { ...(entry.resolvedEnv || {}) };
    for (const k of entry.envKeys || []) {
      const v = String(env[k] || envObj[k] || '').trim();
      if (v) envObj[k] = v;
    }
    const envLines = Object.entries(envObj)
      .map(([k, v]) => `  ${k} = "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join('\n');
    block = [
      `[mcp_servers.${entry.id}]`,
      `command = "${entry.command}"`,
      `args = ${JSON.stringify(entry.args || [])}`,
      'enabled = true',
      envLines ? `[mcp_servers.${entry.id}.env]\n${envLines}` : '',
      '',
    ].filter(Boolean).join('\n');
  }
  text = `${text.trimEnd()}\n\n${block.trim()}\n`;
  fs.writeFileSync(GROK_CONFIG_PATH, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
  try { fs.chmodSync(GROK_CONFIG_PATH, 0o600); } catch { /* ignore */ }
  return { ok: true, message: `已写入 ${GROK_CONFIG_PATH}`, path: GROK_CONFIG_PATH, id: entry.id };
}

export function uninstallMcpFromClient(entryId, client, { confirm = false } = {}) {
  if (!confirm) return { ok: false, message: '需要 confirm: true' };
  const def = MCP_CATALOG_DEFS.find((x) => x.id === entryId);
  if (!def) return { ok: false, message: `未知 MCP: ${entryId}` };
  if (client === 'grok') {
    let text = readTextSafe(GROK_CONFIG_PATH);
    if (!text) return { ok: true, message: 'Grok 配置不存在' };
    text = text.replace(new RegExp(`\\n*\\[mcp_servers\\.${entryId}\\.env\\][\\s\\S]*?(?=\\n\\[|$)`), '\n');
    text = text.replace(new RegExp(`\\n*\\[mcp_servers\\.${entryId}\\][\\s\\S]*?(?=\\n\\[|$)`), '\n');
    fs.writeFileSync(GROK_CONFIG_PATH, `${text.trim()}\n`);
    return { ok: true, message: `已从 Grok 配置移除 ${entryId}` };
  }
  const file = client === 'claude' ? CLAUDE_MCP_PATH : CURSOR_MCP_PATH;
  const current = readJsonSafe(file);
  if (!current?.mcpServers?.[entryId]) return { ok: true, message: '未安装' };
  delete current.mcpServers[entryId];
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  return { ok: true, message: `已从 ${path.basename(file)} 移除 ${entryId}` };
}
