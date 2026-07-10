// 本地控制台服务端 (npm run ui)。
//
// 作用: 不用再手改 .env —— 在浏览器里填 Supabase / LLM / Embedding / Telegram 凭证,
// 一键测试连通性, 并直接启停 Telegram bot、看它的实时日志。
//
// 安全边界:
// - 只绑定 127.0.0.1, 不对外网开放;
// - 密钥读取时全部脱敏 (只回末 4 位), 原文永远不出服务端;
// - 保存时前端只提交改动过的字段, 未动的密钥不会被空值覆盖。
//
// 零新依赖: 只用 node 内置 http/fs + 全局 fetch。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnvText, applyEnvUpdates, maskValue } from './envfile.js';
import { DEFAULT_PARAMS } from '../params.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const HTML_FILE = path.join(__dirname, 'index.html');
const HOST = '127.0.0.1';
const PORT = Number(process.env.UI_PORT || 8787);
const MAX_LOG_LINES = 500;
const PARAMS_FILE = path.join(ROOT, 'config', 'params.json');
const BOT_STATUS_FILE = path.join(ROOT, 'logs', 'ui-bot-status.json');

const PARAM_SCHEMA = [
  { path: 'baseDecay', label: '基础记忆保留率', min: 0.9, max: 1, step: 0.001, group: '记忆' },
  { path: 'emotionProtect', label: '强情绪记忆保护', min: 0, max: 1, step: 0.05, group: '记忆' },
  { path: 'topK', label: '每轮注入记忆数', min: 1, max: 20, step: 1, group: '记忆' },
  { path: 'minImportance', label: '最低记录重要性', min: 1, max: 10, step: 1, group: '记忆' },
  { path: 'engine.wMood', label: '心情门控权重', min: 0, max: 2, step: 0.05, group: '检索' },
  { path: 'engine.wSpread', label: '联想扩散权重', min: 0, max: 1, step: 0.05, group: '检索' },
  { path: 'engine.graphHops', label: '联想扩散跳数', min: 0, max: 4, step: 1, group: '检索' },
  { path: 'state.maxStepPerTurn', label: '单轮状态最大变化', min: 0.05, max: 0.8, step: 0.05, group: '情绪关系' },
  { path: 'reconsolidation.affectClamp', label: '单次重构漂移上限', min: 0.01, max: 0.5, step: 0.01, group: '重构' },
  { path: 'reconsolidation.maxDriftFromOrigin', label: '相对原始情感最大漂移', min: 0.05, max: 1, step: 0.05, group: '重构' },
  { path: 'relationship_memory.alwaysIncludeDyad', label: '固定带入共同记忆数', min: 0, max: 10, step: 1, group: '关系' },
  { path: 'prospective.cueThreshold', label: '语境提醒触发阈值', min: 0.4, max: 1, step: 0.01, group: '主动性' },
  { path: 'prospective.graceHours', label: '提醒过期宽限小时', min: 1, max: 168, step: 1, group: '主动性' },
  { path: 'appearance.minClosenessForSelfie', label: '主动自拍亲密度门槛', min: 0, max: 1, step: 0.05, group: '照片' },
  { path: 'appearance.selfie.minIntervalMinutes', label: '照片冷却分钟', min: 10, max: 10080, step: 10, group: '照片' },
  { path: 'appearance.selfie.maxPerDay', label: '每日最多照片数', min: 0, max: 12, step: 1, group: '照片' },
  { path: 'queue.maxAttempts', label: '任务最大重试次数', min: 1, max: 20, step: 1, group: '任务队列' },
  { path: 'queue.batchSize', label: '任务批处理数量', min: 1, max: 100, step: 1, group: '任务队列' },
  { path: 'training.knowledgePerDay', label: '每日知识滴灌条数', min: 0, max: 20, step: 1, group: '训练' },
  { path: 'knowledge.maxHops', label: '图谱多跳展开跳数', min: 1, max: 4, step: 1, group: '知识图谱' },
  { path: 'knowledge.maxFacts', label: '图谱注入事实上限', min: 1, max: 20, step: 1, group: '知识图谱' },
  { path: 'knowledge.entryMinSimilarity', label: '图谱入口相似度门槛', min: 0, max: 1, step: 0.05, group: '知识图谱' },
  { path: 'knowledge.minConfidence', label: '图谱注入置信度门槛', min: 0, max: 1, step: 0.05, group: '知识图谱' },
];

const BACKUP_TABLES = [
  'memories', 'affective_state', 'life_state', 'affective_state_history', 'prospective',
  'proactive_rate_limits', 'companions', 'appearance_assets', 'jobs', 'chat_history',
  'world_state', 'knowledge_entities', 'knowledge_relations',
];

// ---------------------------------------------------------------
// 配置项 schema: 前端表单完全由它驱动, 加字段只需要改这里。
// secret: true 的字段读取时脱敏、保存时忽略掩码占位。
// ---------------------------------------------------------------
export const CONFIG_SCHEMA = [
  {
    id: 'supabase',
    title: 'Supabase 数据库',
    hint: '记忆 / 状态 / 历史都存这里。建项目后在 Project Settings → API 里拿 URL 和 service_role key, 并在 SQL Editor 执行 sql/schema.sql。',
    testable: true,
    fields: [
      { key: 'SUPABASE_URL', label: 'Project URL', placeholder: 'https://xxxx.supabase.co', link: { label: '去控制台获取', url: 'https://supabase.com/dashboard/project/_/settings/api' } },
      { key: 'SUPABASE_KEY', label: 'Service Role Key', secret: true, placeholder: 'service_role key (不是 anon key)', link: { label: '去控制台获取', url: 'https://supabase.com/dashboard/project/_/settings/api-keys' } },
      { key: 'SUPABASE_ACCESS_TOKEN', label: 'Personal Access Token (可选, 仅供下方 SQL 工具箱建表用)', secret: true, placeholder: 'sbp_... (控制台 Account → Access Tokens 生成)', link: { label: '去生成令牌', url: 'https://supabase.com/dashboard/account/tokens' } },
    ],
  },
  {
    id: 'llm',
    title: '后台基础模型',
    hint: '负责记忆提取 / 反思 / 内心独白。建议使用稳定且成本较低的 OpenAI 兼容模型。',
    testable: true,
    fields: [
      { key: 'LLM_BASE_URL', label: 'Base URL', placeholder: 'https://api.deepseek.com' },
      { key: 'LLM_API_KEY', label: 'API Key', secret: true, placeholder: 'sk-...', link: { label: '去 DeepSeek 获取', url: 'https://platform.deepseek.com/api_keys' } },
      { key: 'LLM_MODEL', label: '基础模型 (提取/反思)', placeholder: 'deepseek-chat' },
    ],
  },
  {
    id: 'reply',
    title: '最终回复模型',
    hint: '直接生成角色对用户说的话。推荐使用火山方舟 Doubao Seed Pro；留空时回退后台基础模型。',
    testable: true,
    fields: [
      { key: 'REPLY_BASE_URL', label: 'Base URL', placeholder: 'https://ark.cn-beijing.volces.com/api/v3' },
      { key: 'REPLY_API_KEY', label: 'API Key', secret: true, placeholder: '火山方舟 API Key；留空复用基础模型密钥' },
      { key: 'REPLY_MODEL', label: '回复模型', placeholder: 'doubao-seed-2-1-pro-260628' },
    ],
  },
  {
    id: 'vision',
    title: '图片理解模型',
    hint: '负责看懂用户发来的图片并生成记忆描述。默认可以复用回复模型。',
    testable: true,
    fields: [
      { key: 'VISION_BASE_URL', label: 'Base URL', placeholder: '留空则复用回复模型地址' },
      { key: 'VISION_API_KEY', label: 'API Key', secret: true, placeholder: '留空则复用回复模型密钥' },
      { key: 'VISION_MODEL', label: '视觉模型', placeholder: 'doubao-seed-2-1-pro-260628' },
    ],
  },
  {
    id: 'embedding',
    title: 'Embedding 向量模型',
    hint: '文本转向量。维度必须与 sql/schema.sql 的 vector(1536) 一致, 换模型前先确认输出维度。',
    testable: true,
    links: [
      { label: 'OpenAI 密钥', url: 'https://platform.openai.com/api-keys' },
      { label: '智谱密钥 (国内可直连)', url: 'https://open.bigmodel.cn/usercenter/apikeys' },
      { label: '硅基流动密钥 (国内可直连)', url: 'https://cloud.siliconflow.cn/account/ak' },
    ],
    fields: [
      { key: 'EMBED_BASE_URL', label: 'Base URL', placeholder: 'https://api.openai.com/v1' },
      { key: 'EMBED_API_KEY', label: 'API Key', secret: true, placeholder: '留空则复用 LLM API Key' },
      { key: 'EMBED_MODEL', label: '模型', placeholder: 'text-embedding-3-small' },
    ],
  },
  {
    id: 'asr',
    title: '语音识别 ASR',
    hint: '把语音转成文字后写入记忆。默认复用 OpenAI 向量模型的地址与密钥。',
    testable: true,
    fields: [
      { key: 'ASR_BASE_URL', label: 'Base URL', placeholder: 'https://api.openai.com/v1' },
      { key: 'ASR_API_KEY', label: 'API Key', secret: true, placeholder: '留空则复用 EMBED_API_KEY' },
      { key: 'ASR_MODEL', label: '转写模型', placeholder: 'whisper-1' },
    ],
  },
  {
    id: 'tts',
    title: '语音合成 TTS',
    hint: '配置合成模型后, 对方发语音时她会用语音条回复 (台词合成语音, 旁白仍走文字); 留空 TTS_MODEL 则永远纯文字。默认复用 ASR 的 OpenAI 凭证。',
    testable: true,
    fields: [
      { key: 'TTS_BASE_URL', label: 'Base URL', placeholder: '留空则复用 ASR 的地址' },
      { key: 'TTS_API_KEY', label: 'API Key', secret: true, placeholder: '留空则复用 ASR/EMBED 的密钥' },
      { key: 'TTS_MODEL', label: '合成模型 (配置即开启语音回复)', placeholder: 'tts-1 或 gpt-4o-mini-tts' },
      { key: 'TTS_VOICE', label: '音色', placeholder: 'nova' },
    ],
  },
  {
    id: 'image',
    title: '图片生成',
    hint: '用于自拍和场景照片。支持火山方舟 Seedream 等 OpenAI 兼容图片接口。',
    testable: true,
    fields: [
      { key: 'IMAGE_BASE_URL', label: 'Base URL', placeholder: 'https://ark.cn-beijing.volces.com/api/v3' },
      { key: 'IMAGE_API_KEY', label: 'API Key', secret: true, placeholder: '火山方舟 API Key' },
      { key: 'IMAGE_MODEL', label: '图片模型', placeholder: 'doubao-seedream-5-0-pro-260628' },
    ],
  },
  {
    id: 'telegram',
    title: 'Telegram 机器人',
    hint: '在 Telegram 找 @BotFather 发 /newbot 拿 token。本地 long polling, 不需要公网地址。',
    testable: true,
    fields: [
      { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', secret: true, placeholder: '123456:ABC-DEF...', link: { label: '去 BotFather 创建', url: 'https://t.me/BotFather' } },
      { key: 'TELEGRAM_ALLOWED_CHAT_IDS', label: '允许的 Chat ID (可选, 逗号分隔, 留空放行所有人)', placeholder: '' },
      { key: 'TELEGRAM_COMPANION_NAME', label: '她的名字', placeholder: '小忆' },
      { key: 'TELEGRAM_SUBJECT_NAME', label: '你的称呼', placeholder: '你' },
      { key: 'TELEGRAM_COMPANION_ID', label: '角色 ID (对应 companions/<id>.json)', placeholder: 'default' },
      { key: 'TELEGRAM_HISTORY_STORE', label: '短期历史存储', options: ['supabase', 'local'], placeholder: 'supabase' },
    ],
    advanced: [
      { key: 'TELEGRAM_PERSONA_FILE', label: '人设文件路径 (默认 companions/<角色ID>.json)', placeholder: '' },
      { key: 'TELEGRAM_HISTORY_FILE', label: '本地历史文件 (history=local 时)', placeholder: 'logs/chat-history.json' },
      { key: 'TELEGRAM_HISTORY_MAX_TURNS', label: '本地历史每会话最大轮数', placeholder: '80' },
      { key: 'TELEGRAM_REPLY_TIMEOUT_MS', label: '单次回复超时 (ms)', placeholder: '90000' },
      { key: 'TELEGRAM_POLL_TIMEOUT_SECONDS', label: 'long polling 超时 (秒)', placeholder: '25' },
    ],
  },
  {
    id: 'weather',
    title: '天气感知 (可选)',
    hint: '让她知道你那边下没下雨。走 open-meteo 免费接口, 不需要 key; 不填经纬度就只按城市名。',
    testable: false,
    links: [{ label: '查经纬度', url: 'https://open-meteo.com/en/docs#location_search' }],
    fields: [
      { key: 'WEATHER_PLACE', label: '城市名', placeholder: '武汉' },
      { key: 'WEATHER_LAT', label: '纬度 (可选)', placeholder: '30.59' },
      { key: 'WEATHER_LON', label: '经度 (可选)', placeholder: '114.30' },
    ],
  },
];

const ALL_FIELDS = CONFIG_SCHEMA.flatMap((g) => [...g.fields, ...(g.advanced ?? [])]);
const SECRET_KEYS = new Set(ALL_FIELDS.filter((f) => f.secret).map((f) => f.key));

// ---------------------------------------------------------------
// .env 读写
// ---------------------------------------------------------------
function readEnvFileText() {
  if (fs.existsSync(ENV_FILE)) return fs.readFileSync(ENV_FILE, 'utf8');
  if (fs.existsSync(ENV_EXAMPLE)) return fs.readFileSync(ENV_EXAMPLE, 'utf8');
  return '';
}

function readEnvValues() {
  return parseEnvText(readEnvFileText());
}

function configPayload() {
  const values = readEnvValues();
  const out = {};
  for (const f of ALL_FIELDS) {
    const raw = values[f.key] ?? '';
    out[f.key] = f.secret ? { set: Boolean(raw), preview: maskValue(raw) } : { value: raw };
  }
  return { schema: CONFIG_SCHEMA, values: out, envFileExists: fs.existsSync(ENV_FILE), sqlFiles: listSqlFiles() };
}

function saveConfig(updates = {}) {
  const clean = {};
  for (const f of ALL_FIELDS) {
    if (!(f.key in updates)) continue;
    const v = updates[f.key];
    if (v === null || v === undefined) continue;
    clean[f.key] = String(v).trim();
  }
  const text = readEnvFileText(); // .env 不存在时以 .env.example 为底稿
  fs.writeFileSync(ENV_FILE, applyEnvUpdates(text, clean), { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600); // writeFileSync 的 mode 只对新建文件生效, 已有文件要显式收紧
  return Object.keys(clean);
}

// ---------------------------------------------------------------
// 连接测试: 全部即时读 .env, 保存后立刻可测, 不依赖进程环境变量。
// ---------------------------------------------------------------
async function timedFetch(url, options = {}, timeoutMs = 15000) {
  const started = Date.now();
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  return { res, ms: Date.now() - started };
}

async function testSupabase(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_KEY || '';
  if (!url || !key) return { ok: false, message: '先填 SUPABASE_URL 和 SUPABASE_KEY' };
  const { res, ms } = await timedFetch(`${url}/rest/v1/memories?select=id&limit=1`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (res.ok) return { ok: true, ms, message: '连接成功, memories 表就绪' };
  const body = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) return { ok: false, ms, message: 'Key 无效或权限不足 (要用 service_role key)' };
  if (res.status === 404 || /42P01|not find the table/i.test(body)) {
    return { ok: false, ms, message: '连接成功但缺表: 请在 Supabase SQL Editor 执行 sql/schema.sql' };
  }
  return { ok: false, ms, message: `HTTP ${res.status}: ${body.slice(0, 120)}` };
}

async function testLlm(env) {
  const base = (env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const key = env.LLM_API_KEY || '';
  const model = env.LLM_MODEL || 'deepseek-chat';
  if (!key) return { ok: false, message: '先填 LLM_API_KEY' };
  const { res, ms } = await timedFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.choices?.[0]) {
    return { ok: false, ms, message: body?.error?.message ? String(body.error.message).slice(0, 160) : `HTTP ${res.status}` };
  }
  return { ok: true, ms, message: `${model} 可用` };
}

async function testChatTarget(target, env) {
  const cfg = resolveModelTarget(target, env);
  if (!cfg?.key) return { ok: false, message: `先配置 ${cfg?.keyName || 'API Key'}` };
  if (!cfg?.model) return { ok: false, message: `先配置 ${cfg?.modelName || '模型名'}` };
  const reply = await timedFetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
  }, 45000).catch((e) => ({ res: null, ms: 0, error: e }));
  const replyBody = reply.res ? await reply.res.json().catch(() => null) : null;
  if (reply.res?.ok && replyBody?.choices?.[0]) {
    return { ok: true, ms: reply.ms, message: `${cfg.model} 可用` };
  }
  const reason = replyBody?.error?.message ? String(replyBody.error.message).slice(0, 100) : reply.res ? `HTTP ${reply.res.status}` : '连接失败';
  return { ok: false, ms: reply.ms, message: `${cfg.model} 不可用: ${reason}` };
}

async function testEmbedding(env) {
  const base = (env.EMBED_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = env.EMBED_API_KEY || env.LLM_API_KEY || '';
  const model = env.EMBED_MODEL || 'text-embedding-3-small';
  if (!key) return { ok: false, message: '先填 EMBED_API_KEY (或先配好 LLM API Key 复用)' };
  // 与 src/embeddings.js 的真实调用完全一致: dimensions 1536 + float
  const { res, ms } = await timedFetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: 'ping', dimensions: 1536, encoding_format: 'float' }),
  });
  const body = await res.json().catch(() => null);
  const vec = body?.data?.[0]?.embedding;
  if (res.ok && Array.isArray(vec)) {
    if (vec.length !== 1536) return { ok: false, ms, message: `模型可用但输出 ${vec.length} 维, 与 schema 的 vector(1536) 不一致` };
    return { ok: true, ms, message: `${model} 可用, 1536 维` };
  }
  return { ok: false, ms, message: body?.error?.message ? String(body.error.message).slice(0, 160) : `HTTP ${res.status}` };
}

async function testTelegram(env) {
  const token = env.TELEGRAM_BOT_TOKEN || '';
  if (!token) return { ok: false, message: '先填 TELEGRAM_BOT_TOKEN' };
  const { res, ms } = await timedFetch(`https://api.telegram.org/bot${token}/getMe`);
  const body = await res.json().catch(() => null);
  if (body?.ok) return { ok: true, ms, message: `@${body.result.username} 在线` };
  return { ok: false, ms, message: body?.description || `HTTP ${res.status}` };
}

async function testCatalogTarget(target, env) {
  const cfg = resolveModelTarget(target, env);
  const catalog = await listModels(target, env);
  if (!catalog.ok) return catalog;
  if (cfg.model && !catalog.models.includes(cfg.model)) {
    return { ok: false, ms: catalog.ms, message: `接口可访问，但目录里没有 ${cfg.model}` };
  }
  return { ok: true, ms: catalog.ms, message: `${cfg.model || '模型目录'} 可访问；实际任务将在使用时验证` };
}

/** TTS 测试: 真合成一句两个字的语音, 验证模型/音色/密钥整条链路 (开销极小)。 */
async function testTts(env) {
  const cfg = resolveModelTarget('tts', env);
  if (!cfg.model) return { ok: false, message: '先配置 TTS_MODEL (配置即开启"对方发语音时她用语音回")' };
  if (!cfg.key) return { ok: false, message: `先配置 ${cfg.keyName} (或先配好 ASR/Embedding 密钥复用)` };
  const { res, ms } = await timedFetch(`${cfg.base}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, voice: env.TTS_VOICE || 'nova', input: '你好', response_format: 'opus' }),
  }, 45000);
  if (res.ok) {
    const bytes = (await res.arrayBuffer()).byteLength;
    if (bytes > 0) return { ok: true, ms, message: `${cfg.model} 可用, 合成 ${bytes} 字节 opus (音色 ${env.TTS_VOICE || 'nova'})` };
    return { ok: false, ms, message: '服务返回了空音频' };
  }
  const body = await res.json().catch(() => null);
  return { ok: false, ms, message: body?.error?.message ? String(body.error.message).slice(0, 160) : `HTTP ${res.status}` };
}

const TESTS = {
  supabase: testSupabase,
  llm: testLlm,
  reply: (env) => testChatTarget('reply', env),
  vision: (env) => testChatTarget('vision', env),
  embedding: testEmbedding,
  asr: (env) => testCatalogTarget('asr', env),
  tts: testTts,
  image: (env) => testCatalogTarget('image', env),
  telegram: testTelegram,
};

// ---------------------------------------------------------------
// 模型目录: OpenAI 兼容服务通常都暴露 GET /models。
// 这里只返回模型 id，不把服务商返回的其他元数据带到前端，避免意外暴露信息。
// ---------------------------------------------------------------
export function normalizeModelIds(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return [...new Set(rows
    .map((item) => typeof item === 'string' ? item : item?.id ?? item?.name)
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim()))]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .slice(0, 500);
}

export function resolveModelTarget(target, env = {}) {
  const llm = { base: env.LLM_BASE_URL || 'https://api.deepseek.com', key: env.LLM_API_KEY || '', model: env.LLM_MODEL || 'deepseek-chat', keyName: 'LLM_API_KEY', modelName: 'LLM_MODEL' };
  const reply = { base: env.REPLY_BASE_URL || llm.base, key: env.REPLY_API_KEY || llm.key, model: env.REPLY_MODEL || llm.model, keyName: 'REPLY_API_KEY', modelName: 'REPLY_MODEL' };
  const embedding = { base: env.EMBED_BASE_URL || 'https://api.openai.com/v1', key: env.EMBED_API_KEY || llm.key, model: env.EMBED_MODEL || 'text-embedding-3-small', keyName: 'EMBED_API_KEY', modelName: 'EMBED_MODEL' };
  const asr = { base: env.ASR_BASE_URL || embedding.base, key: env.ASR_API_KEY || embedding.key, model: env.ASR_MODEL || 'whisper-1', keyName: 'ASR_API_KEY', modelName: 'ASR_MODEL' };
  const map = {
    llm,
    reply,
    vision: { base: env.VISION_BASE_URL || reply.base, key: env.VISION_API_KEY || reply.key, model: env.VISION_MODEL || reply.model, keyName: 'VISION_API_KEY', modelName: 'VISION_MODEL' },
    embedding,
    asr,
    tts: { base: env.TTS_BASE_URL || asr.base, key: env.TTS_API_KEY || asr.key, model: env.TTS_MODEL || '', keyName: 'TTS_API_KEY', modelName: 'TTS_MODEL' },
    image: { base: env.IMAGE_BASE_URL || reply.base, key: env.IMAGE_API_KEY || reply.key, model: env.IMAGE_MODEL || '', keyName: 'IMAGE_API_KEY', modelName: 'IMAGE_MODEL' },
  };
  const cfg = map[target];
  return cfg ? { ...cfg, base: String(cfg.base).replace(/\/+$/, '') } : null;
}

export async function listModels(target, env) {
  const cfg = resolveModelTarget(target, env);
  if (!cfg) return { ok: false, message: `未知模型类型 ${target}`, models: [] };
  if (!cfg.key) return { ok: false, message: `先配置 ${cfg.keyName}`, models: [] };

  const { res, ms } = await timedFetch(`${cfg.base}/models`, {
    headers: { authorization: `Bearer ${cfg.key}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error?.message || body?.message || `HTTP ${res.status}`;
    return { ok: false, ms, message: `模型目录读取失败: ${String(detail).slice(0, 180)}`, models: [] };
  }
  const models = normalizeModelIds(body);
  if (!models.length) return { ok: false, ms, message: '服务已响应，但没有返回可选择的模型', models: [] };
  return { ok: true, ms, message: `已读取 ${models.length} 个可访问模型`, models };
}

// ---------------------------------------------------------------
// SQL 工具箱: 经 Supabase Management API 执行 SQL (建表/迁移不用再开 SQL Editor)。
// service_role key 只能走 PostgREST 读写表, 执行不了 DDL; 所以这里需要用户
// 单独提供 Personal Access Token (sbp_...), 只在这条链路上使用。
// ---------------------------------------------------------------
const SQL_DIR = path.join(ROOT, 'sql');

/** https://<ref>.supabase.co -> <ref>; 非托管域名返回 null (自建实例走不了 Management API)。 */
export function extractProjectRef(supabaseUrl = '') {
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.(co|com|in)\b/i.exec(String(supabaseUrl).trim());
  return m ? m[1] : null;
}

/** sql/ 目录下可一键执行的脚本清单 (白名单: 只认这个目录里的 .sql 文件名)。 */
function listSqlFiles() {
  if (!fs.existsSync(SQL_DIR)) return [];
  return fs
    .readdirSync(SQL_DIR)
    .filter((f) => /^[\w.-]+\.sql$/.test(f))
    .sort((a, b) => (a === 'schema.sql' ? -1 : b === 'schema.sql' ? 1 : a.localeCompare(b))); // 主 schema 永远排第一个
}

async function runSql(env, query) {
  const token = env.SUPABASE_ACCESS_TOKEN || '';
  if (!token) return { ok: false, message: '先在 Supabase 配置里填好并保存 Personal Access Token (sbp_...)' };
  const ref = extractProjectRef(env.SUPABASE_URL);
  if (!ref) return { ok: false, message: 'SUPABASE_URL 不是 *.supabase.co 托管地址; 自建实例请直接用 psql 执行' };
  const sql = String(query ?? '').trim();
  if (!sql) return { ok: false, message: 'SQL 为空' };
  // 建表脚本可能包含扩展/索引, 放宽到 120s
  const { res, ms } = await timedFetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: sql }),
    },
    120000,
  );
  const body = await res.json().catch(() => null);
  if (res.ok) {
    const rows = Array.isArray(body) ? body : [];
    return { ok: true, ms, rows: rows.slice(0, 100), rowCount: rows.length, message: rows.length ? `执行成功, 返回 ${rows.length} 行` : '执行成功' };
  }
  if (res.status === 401) return { ok: false, ms, message: 'Access Token 无效或已过期 (注意: 这里要的是 sbp_ 开头的个人令牌, 不是 service_role key)' };
  if (res.status === 404) return { ok: false, ms, message: `找不到项目 ${ref}: 确认 token 所属账号有这个项目的权限` };
  const detail = body?.message || body?.error || `HTTP ${res.status}`;
  return { ok: false, ms, message: String(detail).slice(0, 300) };
}

async function runSqlFile(env, name) {
  const clean = path.basename(String(name ?? ''));
  if (!listSqlFiles().includes(clean)) return { ok: false, message: `未知脚本 ${clean}: 只能执行 sql/ 目录下的文件` };
  const sql = fs.readFileSync(path.join(SQL_DIR, clean), 'utf8');
  const result = await runSql(env, sql);
  if (result.ok) result.message = `sql/${clean} 执行成功 (脚本是幂等的, 重复执行不影响已有数据)`;
  return result;
}

/** 把 fetch 的底层失败翻译成能指导下一步的中文。国内直连 Google/OpenAI 不通是最常见情况。 */
function describeNetworkError(error) {
  const code = error?.cause?.code || error?.code || '';
  const timedOut = error?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT';
  if (timedOut) return '连接超时: 这个地址从当前网络直连不通 (国内直连 Google/OpenAI 通常如此)。开代理, 或换成可直连的服务商 (如智谱/硅基流动的 OpenAI 兼容端点)';
  if (code === 'ENOTFOUND') return '域名解析失败: 检查 Base URL 是否拼写正确';
  if (code === 'ECONNREFUSED') return '连接被拒绝: 服务地址或端口不对';
  if (code === 'CERT_HAS_EXPIRED' || /certificate/i.test(error?.cause?.message ?? '')) return 'HTTPS 证书异常: 可能被网络中间设备拦截';
  const detail = [code, error?.cause?.message || error?.message].filter(Boolean).join(' · ');
  return `网络请求失败${detail ? ` (${detail})` : ''}: 检查网络和 Base URL`;
}

// ---------------------------------------------------------------
// 数据浏览: 记忆 / 知识图谱 (只读, 走 Supabase PostgREST)
// ---------------------------------------------------------------
async function supabaseRequest(env, pathQuery, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_KEY || '';
  if (!url || !key) return { ok: false, message: '先在「配置」页填好并保存 Supabase URL 和 Key' };
  const opts = {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const { res, ms } = await timedFetch(`${url}/rest/v1/${pathQuery}`, opts, timeoutMs);
  const responseBody = await res.json().catch(() => null);
  if (res.ok) {
    const range = res.headers.get('content-range');
    const count = range?.includes('/') ? Number(range.split('/').at(-1)) : null;
    return { ok: true, ms, data: Array.isArray(responseBody) ? responseBody : responseBody ?? null, count: Number.isFinite(count) ? count : null };
  }
  const raw = JSON.stringify(responseBody ?? '');
  const missingTable = res.status === 404 || /42P01|does not exist|Could not find the table/i.test(raw);
  return { ok: false, ms, missingTable, message: responseBody?.message || `HTTP ${res.status}` };
}

async function supabaseRest(env, pathQuery) {
  return supabaseRequest(env, pathQuery);
}

async function supabaseCount(env, table, filters = {}) {
  const p = new URLSearchParams({ select: 'id', limit: '1' });
  for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) p.set(key, String(value));
  const r = await supabaseRequest(env, `${table}?${p}`, { headers: { prefer: 'count=exact', range: '0-0' } });
  return r.ok ? r.count ?? (Array.isArray(r.data) ? r.data.length : 0) : 0;
}

function scopeFilters({ userId = '', companionId = '' } = {}) {
  const p = new URLSearchParams();
  if (userId) p.set('user_id', `eq.${userId}`);
  if (companionId) p.set('companion_id', `eq.${companionId}`);
  return p;
}

function scopedPath(table, baseParams = {}, scope = {}) {
  const p = new URLSearchParams(baseParams);
  const filters = scopeFilters(scope);
  for (const [k, v] of filters) p.set(k, v);
  return `${table}?${p}`;
}

/** 记忆列表的 PostgREST 查询串。纯函数, 供单测。 */
export function buildMemoriesQuery({ userId = '', companionId = '', q = '', type = '', subjectKind = '', modality = '', minImportance = '', includeSuperseded = false, limit = 60 } = {}) {
  const p = new URLSearchParams();
  p.set('select', 'id,user_id,companion_id,type,content,fact_core,importance,emotion,affect_valence,affect_intensity,narrative,fact_locked,reconsolidation_count,subject_kind,modality,access_count,created_at,last_accessed,superseded_by');
  p.set('order', 'created_at.desc');
  p.set('limit', String(Math.min(Math.max(1, Number(limit) || 60), 200)));
  if (userId) p.set('user_id', `eq.${userId}`);
  if (companionId) p.set('companion_id', `eq.${companionId}`);
  if (type) p.set('type', `eq.${type}`);
  if (subjectKind) p.set('subject_kind', `eq.${subjectKind}`);
  if (modality) p.set('modality', `eq.${modality}`);
  if (minImportance !== '' && Number.isFinite(Number(minImportance))) p.set('importance', `gte.${Math.min(10, Math.max(1, Number(minImportance)))}`);
  if (!includeSuperseded) p.set('superseded_by', 'is.null');
  const clean = String(q ?? '').replace(/[%_*,()."\\]/g, ' ').trim();
  if (clean) p.set('content', `ilike.*${clean}*`);
  return `memories?${p.toString()}`;
}

async function getMemories(env, params) {
  const result = await supabaseRest(env, buildMemoriesQuery(params));
  if (!result.ok && result.missingTable) result.message = '还没建 memories 表: 去「配置」页的 SQL 工具箱执行 sql/schema.sql';
  if (!result.ok) return result;
  // 顺手取最近出现过的 user/companion 组合, 给前端做筛选下拉
  const scopes = await supabaseRest(env, 'memories?select=user_id,companion_id&order=created_at.desc&limit=1000');
  const seen = new Set();
  const users = [];
  for (const r of scopes.ok ? scopes.data : []) {
    const k = `${r.user_id}::${r.companion_id}`;
    if (!seen.has(k)) {
      seen.add(k);
      users.push({ userId: r.user_id, companionId: r.companion_id });
    }
  }
  return { ...result, users };
}

async function getGraph(env, { userId = '', companionId = '' } = {}) {
  const scope = new URLSearchParams();
  if (userId) scope.set('user_id', `eq.${userId}`);
  if (companionId) scope.set('companion_id', `eq.${companionId}`);
  const scopeStr = scope.toString() ? `&${scope.toString()}` : '';
  const entities = await supabaseRest(env, `knowledge_entities?select=id,canonical_name,entity_type,user_id,companion_id,updated_at&order=updated_at.desc&limit=300${scopeStr}`);
  if (!entities.ok) {
    if (entities.missingTable) entities.message = '还没建知识图谱表: 去「配置」页的 SQL 工具箱执行 sql/knowledge-graph.sql';
    return entities;
  }
  const relations = await supabaseRest(
    env,
    `knowledge_relations?select=relation,confidence,evidence,status,created_at,source:knowledge_entities!source_entity_id(canonical_name),target:knowledge_entities!target_entity_id(canonical_name)&status=eq.active&order=created_at.desc&limit=400${scopeStr}`,
  );
  return { ok: true, entities: entities.data, relations: relations.ok ? relations.data : [], relationsError: relations.ok ? null : relations.message };
}

// ---------------------------------------------------------------
// 控制台 3.0 数据面: 全局作用域 / 总览 / 状态 / 提醒 / 运维。
// ---------------------------------------------------------------
async function getScopes(env) {
  const tables = ['memories', 'affective_state', 'life_state', 'chat_history', 'prospective', 'world_state'];
  const results = await Promise.all(tables.map((table) => supabaseRest(env, `${table}?select=user_id,companion_id&limit=1000`).catch(() => ({ ok: false }))));
  const seen = new Set();
  const scopes = [];
  for (const result of results) {
    for (const row of result.ok && Array.isArray(result.data) ? result.data : []) {
      if (!row.user_id) continue;
      const companionId = row.companion_id || 'default';
      const key = `${row.user_id}::${companionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scopes.push({ userId: row.user_id, companionId });
    }
  }
  scopes.sort((a, b) => `${a.userId}:${a.companionId}`.localeCompare(`${b.userId}:${b.companionId}`, 'zh-CN'));
  return { ok: true, scopes };
}

async function getStateBundle(env, scope) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  const [affect, life, history] = await Promise.all([
    supabaseRest(env, scopedPath('affective_state', { select: 'mood,relationship,updated_at', limit: '1' }, scope)),
    supabaseRest(env, scopedPath('life_state', { select: 'energy,satiety,health,current_activity,last_slept_at,sick_until,late_night_streak,last_late_night_day,updated_at', limit: '1' }, scope)),
    supabaseRest(env, scopedPath('affective_state_history', { select: 'mood,relationship,event,created_at', order: 'created_at.desc', limit: '80' }, scope)),
  ]);
  const defaultAffect = { mood: { valence: 0, arousal: 0.3 }, relationship: { closeness: 0.5, tension: 0, repair_debt: 0, trust: 0.5 }, updated_at: null };
  const defaultLife = { energy: 0.6, satiety: 0.6, health: 1, current_activity: null, last_slept_at: null, sick_until: null, late_night_streak: 0, last_late_night_day: null, updated_at: null };
  return {
    ok: affect.ok || life.ok,
    affect: affect.ok && affect.data?.[0] ? affect.data[0] : defaultAffect,
    life: life.ok && life.data?.[0] ? life.data[0] : defaultLife,
    history: history.ok ? history.data : [],
    errors: [affect, life, history].filter((r) => !r.ok && !r.missingTable).map((r) => r.message),
  };
}

async function getOverview(env, scope) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  const filters = { user_id: `eq.${scope.userId}`, companion_id: `eq.${scope.companionId || 'default'}` };
  const [state, memories, reflections, pending, failedJobs, photos, recentChat, world] = await Promise.all([
    getStateBundle(env, scope),
    supabaseCount(env, 'memories', { ...filters, superseded_by: 'is.null' }),
    supabaseCount(env, 'memories', { ...filters, type: 'eq.reflection', superseded_by: 'is.null' }),
    supabaseCount(env, 'prospective', { ...filters, status: 'eq.pending' }),
    supabaseCount(env, 'jobs', { ...filters, status: 'eq.failed' }),
    supabaseCount(env, 'appearance_assets', filters),
    supabaseRest(env, scopedPath('chat_history', { select: 'role,content,created_at', order: 'created_at.desc', limit: '6' }, scope)),
    supabaseRest(env, scopedPath('world_state', { select: 'arc,atmosphere,last_event,updated_at', limit: '1' }, scope)),
  ]);
  return {
    ok: true,
    scope,
    counts: { memories, reflections, pending, failedJobs, photos },
    state,
    recentChat: recentChat.ok ? recentChat.data.reverse() : [],
    world: world.ok ? world.data?.[0] ?? null : null,
    bot: botStatus(),
  };
}

async function getMemoryDetail(env, id) {
  if (!/^[0-9a-f-]{30,40}$/i.test(String(id ?? ''))) return { ok: false, message: '记忆 ID 不合法' };
  const fields = 'id,user_id,companion_id,type,content,fact_core,importance,emotion,subject_kind,modality,media_ref,affect_valence,affect_intensity,affect_origin_valence,affect_origin_intensity,narrative,fact_locked,reconsolidation_count,access_count,access_log,last_accessed,created_at,superseded_by,dedup_hash';
  const r = await supabaseRest(env, `memories?select=${fields}&id=eq.${encodeURIComponent(id)}&limit=1`);
  if (!r.ok) return r;
  const memory = r.data?.[0];
  if (!memory) return { ok: false, message: '没有找到这条记忆' };
  const trail = await supabaseRest(env, `memories?select=id,content,fact_core,created_at,superseded_by&or=(id.eq.${encodeURIComponent(id)},superseded_by.eq.${encodeURIComponent(id)})&order=created_at.asc&limit=30`);
  return { ok: true, memory, trail: trail.ok ? trail.data : [] };
}

async function saveStateBundle(env, scope, input = {}) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  const companionId = scope.companionId || 'default';
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
  const results = [];
  if (input.affect) {
    const row = {
      user_id: scope.userId,
      companion_id: companionId,
      mood: { valence: clamp(input.affect.mood?.valence, -1, 1), arousal: clamp(input.affect.mood?.arousal) },
      relationship: {
        closeness: clamp(input.affect.relationship?.closeness),
        tension: clamp(input.affect.relationship?.tension),
        repair_debt: clamp(input.affect.relationship?.repair_debt),
        trust: clamp(input.affect.relationship?.trust),
        tension_target: ['user', 'external'].includes(input.affect.relationship?.tension_target) ? input.affect.relationship.tension_target : 'user',
        tension_topic: String(input.affect.relationship?.tension_topic || '').slice(0, 80) || null,
      },
      updated_at: new Date().toISOString(),
    };
    results.push(await supabaseRequest(env, 'affective_state?on_conflict=user_id,companion_id', { method: 'POST', body: row, headers: { prefer: 'resolution=merge-duplicates,return=representation' } }));
  }
  if (input.life) {
    const row = {
      user_id: scope.userId,
      companion_id: companionId,
      energy: clamp(input.life.energy), satiety: clamp(input.life.satiety), health: clamp(input.life.health),
      current_activity: String(input.life.current_activity || '').slice(0, 160) || null,
      last_slept_at: input.life.last_slept_at || null,
      sick_until: input.life.sick_until || null,
      late_night_streak: Math.min(30, Math.max(0, Math.round(Number(input.life.late_night_streak) || 0))),
      last_late_night_day: input.life.last_late_night_day || null,
      updated_at: new Date().toISOString(),
    };
    results.push(await supabaseRequest(env, 'life_state?on_conflict=user_id,companion_id', { method: 'POST', body: row, headers: { prefer: 'resolution=merge-duplicates,return=representation' } }));
  }
  const failed = results.find((r) => !r.ok);
  return failed || { ok: true, message: '状态已保存；运行中的 Bot 会在下一轮读取新状态' };
}

async function getProspectives(env, scope) {
  const r = await supabaseRest(env, scopedPath('prospective', { select: 'id,content,trigger_kind,trigger_at,status,created_at', order: 'created_at.desc', limit: '300' }, scope));
  return r.ok ? { ok: true, items: r.data } : r;
}

async function updateProspective(env, id, patch = {}) {
  if (!/^[0-9a-f-]{30,40}$/i.test(String(id ?? ''))) return { ok: false, message: '提醒 ID 不合法' };
  const clean = {};
  if (patch.content != null) clean.content = String(patch.content).trim().slice(0, 500);
  if (patch.trigger_at !== undefined) clean.trigger_at = patch.trigger_at || null;
  if (['pending', 'fired', 'cancelled', 'expired'].includes(patch.status)) clean.status = patch.status;
  if (!Object.keys(clean).length) return { ok: false, message: '没有可更新的字段' };
  return supabaseRequest(env, `prospective?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: clean, headers: { prefer: 'return=representation' } });
}

async function getJobs(env, scope, status = '') {
  const base = { select: 'id,kind,status,attempts,run_after,last_error,result,created_at,updated_at', order: 'created_at.desc', limit: '300' };
  if (status) base.status = `eq.${status}`;
  const r = await supabaseRest(env, scopedPath('jobs', base, scope));
  if (!r.ok) return r;
  const counts = Object.fromEntries(['pending', 'running', 'done', 'failed'].map((s) => [s, r.data.filter((j) => j.status === s).length]));
  return { ok: true, jobs: r.data, counts };
}

async function updateJob(env, id, action) {
  if (!/^[0-9a-f-]{30,40}$/i.test(String(id ?? ''))) return { ok: false, message: '任务 ID 不合法' };
  const body = action === 'retry'
    ? { status: 'pending', attempts: 0, last_error: null, run_after: new Date().toISOString(), updated_at: new Date().toISOString() }
    : action === 'cancel' ? { status: 'failed', last_error: '由控制台取消', updated_at: new Date().toISOString() } : null;
  if (!body) return { ok: false, message: '未知任务操作' };
  return supabaseRequest(env, `jobs?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body, headers: { prefer: 'return=representation' } });
}

async function getHistory(env, scope) {
  const r = await supabaseRest(env, scopedPath('chat_history', { select: 'id,role,content,created_at', order: 'created_at.desc', limit: '500' }, scope));
  return r.ok ? { ok: true, messages: r.data.reverse() } : r;
}

async function clearHistory(env, scope) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  return supabaseRequest(env, scopedPath('chat_history', {}, scope), { method: 'DELETE', headers: { prefer: 'return=representation' } });
}

async function getWorld(env, scope) {
  const r = await supabaseRest(env, scopedPath('world_state', { select: 'arc,atmosphere,last_event,updated_at', limit: '1' }, scope));
  return r.ok ? { ok: true, world: r.data?.[0] ?? { arc: '', atmosphere: '', last_event: '', updated_at: null } } : r;
}

async function saveWorld(env, scope, value = {}) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  const row = {
    user_id: scope.userId, companion_id: scope.companionId || 'default',
    arc: String(value.arc || '').slice(0, 4000), atmosphere: String(value.atmosphere || '').slice(0, 1000),
    last_event: String(value.last_event || '').slice(0, 2000), updated_at: new Date().toISOString(),
  };
  return supabaseRequest(env, 'world_state?on_conflict=user_id,companion_id', { method: 'POST', body: row, headers: { prefer: 'resolution=merge-duplicates,return=representation' } });
}

async function getGallery(env, scope) {
  const r = await supabaseRest(env, scopedPath('appearance_assets', { select: 'id,url,tags,prompt,seed,meta,created_at', order: 'created_at.desc', limit: '300' }, scope));
  return r.ok ? { ok: true, assets: r.data } : r;
}

function getPathValue(obj, dotted) {
  return dotted.split('.').reduce((cur, key) => cur?.[key], obj);
}

function setPathValue(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) cur = cur[key] ??= {};
  cur[keys.at(-1)] = value;
}

function readParamOverrides() {
  try { return JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')); } catch { return {}; }
}

function paramPayload() {
  const overrides = readParamOverrides();
  return {
    ok: true,
    fields: PARAM_SCHEMA.map((f) => ({ ...f, defaultValue: getPathValue(DEFAULT_PARAMS, f.path), value: getPathValue(overrides, f.path) ?? getPathValue(DEFAULT_PARAMS, f.path) })),
    hasOverrides: Object.keys(overrides).length > 0,
  };
}

function saveParams(values = {}) {
  const out = {};
  for (const field of PARAM_SCHEMA) {
    if (!(field.path in values)) continue;
    let value = Number(values[field.path]);
    if (!Number.isFinite(value)) continue;
    value = Math.min(field.max, Math.max(field.min, value));
    if (field.step >= 1) value = Math.round(value);
    setPathValue(out, field.path, value);
  }
  fs.mkdirSync(path.dirname(PARAMS_FILE), { recursive: true });
  fs.writeFileSync(PARAMS_FILE, `${JSON.stringify(out, null, 2)}\n`);
  return { ok: true, message: `已保存 ${Object.keys(values).length} 项参数；重启 Bot 后生效`, values: out };
}

async function exportScope(env, scope) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  const tables = {};
  for (const table of BACKUP_TABLES) {
    const r = await supabaseRest(env, scopedPath(table, { select: '*', limit: '10000' }, scope));
    if (r.ok) tables[table] = r.data;
  }
  return { ok: true, version: 1, exportedAt: new Date().toISOString(), scope, tables };
}

async function importScope(env, payload = {}) {
  const tables = payload.tables ?? {};
  const scope = payload.scope ?? {};
  if (!scope.userId) return { ok: false, message: '备份缺少作用域信息' };
  const imported = {};
  for (const table of BACKUP_TABLES) {
    const rows = Array.isArray(tables[table]) ? tables[table] : [];
    if (!rows.length) continue;
    const cleanRows = rows.slice(0, 10000).map((row) => {
      const clean = { ...row, user_id: scope.userId, companion_id: scope.companionId || 'default' };
      if (table === 'chat_history') delete clean.id;
      return clean;
    });
    const conflict = table === 'chat_history' ? '' : table === 'affective_state' || table === 'life_state' || table === 'proactive_rate_limits' || table === 'companions' || table === 'world_state' ? 'user_id,companion_id' : 'id';
    const target = conflict ? `${table}?on_conflict=${conflict}` : table;
    const r = await supabaseRequest(env, target, {
      method: 'POST', body: cleanRows, headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, timeoutMs: 120000,
    });
    if (!r.ok) return { ...r, message: `导入 ${table} 失败: ${r.message}` };
    imported[table] = cleanRows.length;
  }
  return { ok: true, imported, message: `导入完成，共写入 ${Object.values(imported).reduce((a, b) => a + b, 0)} 行` };
}

async function getSystemHealth(env) {
  const required = ['memories', 'affective_state', 'life_state', 'prospective', 'chat_history', 'world_state', 'jobs'];
  const optional = ['knowledge_entities', 'knowledge_relations', 'appearance_assets', 'companions'];
  const results = await Promise.all([...required, ...optional].map(async (table) => {
    const r = await supabaseRequest(env, `${table}?select=*&limit=1`, { timeoutMs: 30000 })
      .catch((error) => ({ ok: false, message: error?.message }));
    return { table, required: required.includes(table), ok: r.ok, message: r.ok ? '就绪' : r.missingTable ? '缺表' : r.message };
  }));
  return {
    ok: true,
    config: {
      supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_KEY),
      llm: Boolean(env.LLM_API_KEY),
      reply: Boolean((env.REPLY_API_KEY || env.LLM_API_KEY) && (env.REPLY_MODEL || env.LLM_MODEL)),
      vision: Boolean((env.VISION_API_KEY || env.REPLY_API_KEY || env.LLM_API_KEY) && (env.VISION_MODEL || env.REPLY_MODEL || env.LLM_MODEL)),
      embedding: Boolean(env.EMBED_API_KEY || env.LLM_API_KEY),
      asr: Boolean((env.ASR_API_KEY || env.EMBED_API_KEY || env.LLM_API_KEY) && (env.ASR_MODEL || 'whisper-1')),
      image: Boolean((env.IMAGE_API_KEY || env.REPLY_API_KEY) && env.IMAGE_MODEL),
      telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
      envFile: fs.existsSync(ENV_FILE),
      paramOverrides: fs.existsSync(PARAMS_FILE),
    },
    tables: results,
    bot: botStatus(),
  };
}

// ---------------------------------------------------------------
// 人设文件 (companions/*.json) 读写
// ---------------------------------------------------------------
const COMPANIONS_DIR = path.join(ROOT, 'companions');

/** 人设文件名白名单: 只认 companions/ 下的一层 .json。纯函数, 供单测。 */
export function safePersonaName(name = '') {
  const base = path.basename(String(name ?? '').trim());
  return /^[\w.-]+\.json$/.test(base) && !base.startsWith('.') ? base : null;
}

function listPersonas() {
  if (!fs.existsSync(COMPANIONS_DIR)) return [];
  return fs.readdirSync(COMPANIONS_DIR).filter((f) => safePersonaName(f)).sort();
}

function savePersona(name, content) {
  const clean = safePersonaName(name);
  if (!clean) return { ok: false, message: '文件名只能是 companions/ 下的 xxx.json' };
  try {
    JSON.parse(content); // 只校验合法性, 原样保存 (保留用户自己的排版)
  } catch (error) {
    return { ok: false, message: `JSON 不合法: ${error.message}` };
  }
  fs.mkdirSync(COMPANIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(COMPANIONS_DIR, clean), content.endsWith('\n') ? content : `${content}\n`);
  return { ok: true, message: `已保存 companions/${clean} (bot 重启后生效)` };
}

// ---------------------------------------------------------------
// 编排器试聊: 每条消息 spawn 一次 chat-runner (真实走完整管线, 会调 LLM + 写库)
// ---------------------------------------------------------------
function runChat({ message, userId, companionId, debug = false }) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [path.join(__dirname, 'chat-runner.js'), JSON.stringify({ message, userId, companionId, debug })],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({ ok: false, message: '回复超时 (120s)' });
    }, 120000);
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      // 协议: runner 输出一行 JSON。防御性地跳过混进 stdout 的杂散日志行,
      // 只认第一条能解析出 ok 字段的行; 找到后不杀进程, 让 runner 把
      // afterReply (记忆提取/状态演变) 跑完再自行退出。
      let nl;
      while (!settled && (nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.ok === 'boolean') {
            clearTimeout(timer);
            finish(parsed);
          }
        } catch {} // 杂散日志行, 忽略
      }
    });
    proc.stderr.on('data', (chunk) => {
      err += chunk;
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      finish({ ok: false, message: `runner 退出且无输出${err ? `: ${err.slice(-300)}` : ''}` });
    });
  });
}

/** 高风险/业务型动作统一放到短命子进程，保证每次都读取刚保存的 .env 与 params 覆盖。 */
function runAction(payload, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'action-runner.js'), JSON.stringify(payload)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({ ok: false, message: `操作超时 (${Math.round(timeoutMs / 1000)}s)` });
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      let nl;
      while (!settled && (nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.ok === 'boolean') {
            clearTimeout(timer);
            finish(parsed);
          }
        } catch {}
      }
    });
    proc.stderr.on('data', (chunk) => { err += chunk; });
    proc.on('exit', () => {
      clearTimeout(timer);
      finish({ ok: false, message: `操作进程退出且无结果${err ? `: ${err.slice(-500)}` : ''}` });
    });
  });
}

// ---------------------------------------------------------------
// Telegram bot 子进程管理
// ---------------------------------------------------------------
const bot = { proc: null, startedAt: null, logs: [], lastExit: null };

function pushLog(line) {
  const clean = String(line).replace(/\s+$/, '');
  if (!clean) return;
  bot.logs.push({ ts: Date.now(), line: clean });
  if (bot.logs.length > MAX_LOG_LINES) bot.logs.splice(0, bot.logs.length - MAX_LOG_LINES);
}

function startBot() {
  if (bot.proc) return { ok: false, message: 'bot 已在运行' };
  const env = readEnvValues();
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, message: '先在下方填好并保存 TELEGRAM_BOT_TOKEN' };
  try { fs.rmSync(BOT_STATUS_FILE, { force: true }); } catch {}
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/telegram/bot.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, CYBER_UI_STATUS_FILE: BOT_STATUS_FILE },
  });
  bot.proc = proc;
  bot.startedAt = Date.now();
  bot.lastExit = null;
  pushLog(`[控制台] 启动 bot (pid ${proc.pid})`);
  const onData = (chunk) => String(chunk).split('\n').forEach(pushLog);
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code, signal) => {
    bot.lastExit = { code, signal, at: Date.now() };
    pushLog(`[控制台] bot 退出 (code=${code ?? ''} signal=${signal ?? ''})`);
    bot.proc = null;
    bot.startedAt = null;
  });
  return { ok: true, message: `已启动 (pid ${proc.pid})` };
}

function stopBot() {
  const proc = bot.proc;
  if (!proc) return { ok: false, message: 'bot 未在运行' };
  pushLog('[控制台] 发送停止信号...');
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (bot.proc === proc) proc.kill('SIGKILL');
  }, 5000).unref();
  return { ok: true, message: '已发送停止信号' };
}

function botStatus() {
  let runtime = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(BOT_STATUS_FILE, 'utf8'));
    const ageMs = Date.now() - new Date(parsed.updatedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs < 60000) runtime = parsed;
  } catch {}
  return {
    running: Boolean(bot.proc),
    pid: bot.proc?.pid ?? null,
    startedAt: bot.startedAt,
    lastExit: bot.lastExit,
    logs: bot.logs.slice(-200),
    runtime,
  };
}

// ---------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 25_000_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /' || route === 'GET /index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(HTML_FILE));
    return;
  }
  if (route === 'GET /api/config') return json(res, 200, configPayload());
  if (route === 'PUT /api/config') {
    const body = await readBody(req);
    const savedKeys = saveConfig(body?.values ?? {});
    return json(res, 200, { ok: true, savedKeys, message: savedKeys.length ? `已保存 ${savedKeys.length} 项到 .env` : '没有需要保存的改动' });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/test/')) {
    const target = url.pathname.slice('/api/test/'.length);
    const fn = TESTS[target];
    if (!fn) return json(res, 404, { ok: false, message: `未知测试目标 ${target}` });
    try {
      return json(res, 200, await fn(readEnvValues()));
    } catch (error) {
      return json(res, 200, { ok: false, message: describeNetworkError(error) });
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/models/')) {
    const target = url.pathname.slice('/api/models/'.length);
    try {
      return json(res, 200, await listModels(target, readEnvValues()));
    } catch (error) {
      return json(res, 200, { ok: false, models: [], message: describeNetworkError(error) });
    }
  }
  if (route === 'POST /api/sql') {
    const body = await readBody(req);
    try {
      const result = body?.file ? await runSqlFile(readEnvValues(), body.file) : await runSql(readEnvValues(), body?.query);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 200, { ok: false, message: describeNetworkError(error) });
    }
  }
  if (route === 'GET /api/scopes') {
    try { return json(res, 200, await getScopes(readEnvValues())); }
    catch (error) { return json(res, 200, { ok: false, message: describeNetworkError(error) }); }
  }
  if (route === 'GET /api/overview') {
    try { return json(res, 200, await getOverview(readEnvValues(), Object.fromEntries(url.searchParams))); }
    catch (error) { return json(res, 200, { ok: false, message: describeNetworkError(error) }); }
  }
  if (route === 'GET /api/state') {
    try { return json(res, 200, await getStateBundle(readEnvValues(), Object.fromEntries(url.searchParams))); }
    catch (error) { return json(res, 200, { ok: false, message: describeNetworkError(error) }); }
  }
  if (route === 'PUT /api/state') {
    const body = await readBody(req);
    return json(res, 200, await saveStateBundle(readEnvValues(), body.scope ?? {}, body));
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/memory/')) {
    return json(res, 200, await getMemoryDetail(readEnvValues(), url.pathname.slice('/api/memory/'.length)));
  }
  if ((req.method === 'PATCH' || req.method === 'DELETE') && url.pathname.startsWith('/api/memory/')) {
    const id = url.pathname.slice('/api/memory/'.length);
    if (!/^[0-9a-f-]{30,40}$/i.test(id)) return json(res, 400, { ok: false, message: '记忆 ID 不合法' });
    if (req.method === 'DELETE') {
      const result = await supabaseRequest(readEnvValues(), `memories?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { prefer: 'return=representation' } });
      return json(res, 200, result.ok ? { ok: true, message: '记忆已删除', data: result.data } : result);
    }
    const body = await readBody(req);
    const patch = {};
    if (typeof body.fact_locked === 'boolean') patch.fact_locked = body.fact_locked;
    if (typeof body.importance === 'number') patch.importance = Math.min(10, Math.max(1, body.importance));
    const result = await supabaseRequest(readEnvValues(), `memories?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, headers: { prefer: 'return=representation' } });
    return json(res, 200, result.ok ? { ok: true, message: '记忆属性已更新', data: result.data } : result);
  }
  if (route === 'GET /api/prospectives') return json(res, 200, await getProspectives(readEnvValues(), Object.fromEntries(url.searchParams)));
  if (route === 'POST /api/prospectives') {
    const body = await readBody(req);
    return json(res, 200, await runAction({ action: 'schedule-prospective', ...(body.scope ?? {}), ...body }));
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/prospectives/')) {
    return json(res, 200, await updateProspective(readEnvValues(), url.pathname.slice('/api/prospectives/'.length), await readBody(req)));
  }
  if (route === 'GET /api/jobs') return json(res, 200, await getJobs(readEnvValues(), Object.fromEntries(url.searchParams), url.searchParams.get('status') || ''));
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/jobs/')) {
    const body = await readBody(req);
    return json(res, 200, await updateJob(readEnvValues(), url.pathname.slice('/api/jobs/'.length), body.action));
  }
  if (route === 'GET /api/history') return json(res, 200, await getHistory(readEnvValues(), Object.fromEntries(url.searchParams)));
  if (route === 'DELETE /api/history') return json(res, 200, await clearHistory(readEnvValues(), Object.fromEntries(url.searchParams)));
  if (route === 'GET /api/world') return json(res, 200, await getWorld(readEnvValues(), Object.fromEntries(url.searchParams)));
  if (route === 'PUT /api/world') {
    const body = await readBody(req);
    return json(res, 200, await saveWorld(readEnvValues(), body.scope ?? {}, body.world ?? {}));
  }
  if (route === 'GET /api/gallery') return json(res, 200, await getGallery(readEnvValues(), Object.fromEntries(url.searchParams)));
  if (route === 'GET /api/params') return json(res, 200, paramPayload());
  if (route === 'PUT /api/params') return json(res, 200, saveParams((await readBody(req)).values ?? {}));
  if (route === 'POST /api/actions') {
    const body = await readBody(req);
    return json(res, 200, await runAction({ ...(body.scope ?? {}), ...body }));
  }
  if (route === 'GET /api/export') return json(res, 200, await exportScope(readEnvValues(), Object.fromEntries(url.searchParams)));
  if (route === 'POST /api/import') return json(res, 200, await importScope(readEnvValues(), await readBody(req)));
  if (route === 'GET /api/health') return json(res, 200, await getSystemHealth(readEnvValues()));
  if (route === 'GET /api/memories') {
    try {
      return json(res, 200, await getMemories(readEnvValues(), Object.fromEntries(url.searchParams)));
    } catch (error) {
      return json(res, 200, { ok: false, message: describeNetworkError(error) });
    }
  }
  if (route === 'GET /api/graph') {
    try {
      return json(res, 200, await getGraph(readEnvValues(), Object.fromEntries(url.searchParams)));
    } catch (error) {
      return json(res, 200, { ok: false, message: describeNetworkError(error) });
    }
  }
  if (route === 'GET /api/personas') {
    const files = listPersonas();
    const personas = files.map((f) => ({ file: f, content: fs.readFileSync(path.join(COMPANIONS_DIR, f), 'utf8') }));
    return json(res, 200, { ok: true, personas });
  }
  if (route === 'PUT /api/personas') {
    const body = await readBody(req);
    return json(res, 200, savePersona(body?.file, String(body?.content ?? '')));
  }
  if (route === 'POST /api/chat') {
    const body = await readBody(req);
    const message = String(body?.message ?? '').trim();
    if (!message) return json(res, 200, { ok: false, message: '消息为空' });
    const env = readEnvValues();
    const result = await runChat({
      message,
      userId: String(body?.userId || 'ui:playground'),
      companionId: String(body?.companionId || env.TELEGRAM_COMPANION_ID || 'default'),
      debug: Boolean(body?.debug),
    });
    return json(res, 200, result);
  }
  if (route === 'GET /api/bot') return json(res, 200, botStatus());
  if (route === 'POST /api/bot/start') return json(res, 200, startBot());
  if (route === 'POST /api/bot/stop') return json(res, 200, stopBot());
  json(res, 404, { ok: false, message: 'not found' });
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('[ui]', error);
      if (!res.headersSent) json(res, 500, { ok: false, message: error?.message || 'internal error' });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`[ui] Cyber Memory 控制台: http://${HOST}:${PORT}  (仅本机可访问)`);
  });
  const shutdown = () => {
    if (bot.proc) bot.proc.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
