// 本地控制台服务端 (npm run ui)。
//
// 作用: 不用再手改 .env —— 在浏览器里填 Supabase / LLM / Embedding / Telegram 凭证,
// 一键测试连通性, 并直接启停消息渠道 bot、看实时日志。
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
import { normalizeCompanionProfile } from '../companion.js';
import { OpenAIImageProvider } from '../appearance/provider.js';
import { listReferenceImages, saveReferenceImage, deleteReferenceImage, referenceFilePath, readReferenceById, setReferenceAvatar } from '../appearance/references.js';
import {
  buildOutfitCatalog,
  lookToOutfitState,
} from '../state/outfitCards.js';
import {
  buildAlbumCatalog,
} from '../state/album.js';
import {
  listAssetsPath,
  oneAssetPath,
  rowsToAssetMapLite,
  rowsToAssetMap,
  attachAssetsToCards,
  validateImagePayload,
  decodeImageBase64,
  upsertAssetBody,
  listCustomAlbumPath,
  upsertCustomAlbumBody,
  normalizeCardKey,
} from '../state/cardAssetsDb.js';
import { uploadBase64ToR2, deleteFromR2, resolveR2Config } from '../media/r2.js';
import { normalizeWardrobe, clampOutfitState, writeOutfit, readOutfit } from '../state/outfit.js';
import {
  ensureDailyLookState,
  generateDailyLookPhoto,
  localDayKey,
  dailyAlbumCardId,
} from '../state/dailyLook.js';
import { insertAppearanceAsset } from '../appearance/selfie.js';
import {
  listMcpCatalog,
  installMcpToClient,
  uninstallMcpFromClient,
  buildClientSnippet,
  MCP_CATALOG,
  clientConfigPaths,
} from './mcpCatalog.js';
import {
  DEFAULT_SAFETY_POLICY,
  normalizeSafetyPolicy,
  checkMessageSafety,
  redactExportTables,
  DEFAULT_QUOTA,
  normalizeQuota,
  checkQuota,
  canWriteAction,
  buildTimeline,
  buildRelationshipView,
  gateIncomingMessage,
  loadProductPolicy,
  readAuditTail,
  appendAudit,
  buildBillingSummary,
  getTenantUsage,
  affirmAdult,
  revokeAdult,
  getIdentity,
  buildAlbumQuoteMessage,
} from '../product/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const DIST_DIR = path.join(__dirname, 'dist');
const HTML_FILE = path.join(DIST_DIR, 'index.html');
const HOST = '127.0.0.1';
const PORT = Number(process.env.UI_PORT || 8787);
const MAX_LOG_LINES = 500;
const PARAMS_FILE = path.join(ROOT, 'config', 'params.json');
const PRODUCT_POLICY_FILE = path.join(ROOT, 'config', 'product-policy.json');
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
  { path: 'orchestrator.monologueMaxTokens', label: '内心独白最大 token 数 (影响回复延迟)', min: 20, max: 400, step: 10, group: '情绪关系' },
  { path: 'reconsolidation.affectClamp', label: '单次重构漂移上限', min: 0.01, max: 0.5, step: 0.01, group: '重构' },
  { path: 'reconsolidation.maxDriftFromOrigin', label: '相对原始情感最大漂移', min: 0.05, max: 1, step: 0.05, group: '重构' },
  { path: 'relationship_memory.alwaysIncludeDyad', label: '固定带入共同记忆数', min: 0, max: 10, step: 1, group: '关系' },
  { path: 'prospective.cueThreshold', label: '语境提醒触发阈值', min: 0.4, max: 1, step: 0.01, group: '主动性' },
  { path: 'prospective.graceHours', label: '提醒过期宽限小时', min: 1, max: 168, step: 1, group: '主动性' },
  { path: 'desire.promptThreshold', label: '需求进入 Prompt 门槛', min: 0, max: 1, step: 0.05, group: '需求' },
  { path: 'desire.halfLifeHours.attention', label: '关注需求饱和时长', min: 1, max: 240, step: 1, group: '需求' },
  { path: 'desire.halfLifeHours.sharing', label: '分享需求饱和时长', min: 1, max: 240, step: 1, group: '需求' },
  { path: 'desire.halfLifeHours.comfort', label: '安慰需求饱和时长', min: 1, max: 240, step: 1, group: '需求' },
  { path: 'desire.halfLifeHours.security', label: '安全需求饱和时长', min: 1, max: 240, step: 1, group: '需求' },
  { path: 'desire.growthPerHour.attention', label: '关注需求每小时增速', min: 0, max: 0.1, step: 0.001, group: '需求' },
  { path: 'desire.growthPerHour.sharing', label: '分享需求每小时增速', min: 0, max: 0.1, step: 0.001, group: '需求' },
  { path: 'desire.growthPerHour.comfort', label: '安慰需求每小时增速', min: 0, max: 0.1, step: 0.001, group: '需求' },
  { path: 'desire.growthPerHour.security', label: '安全需求每小时增速', min: 0, max: 0.1, step: 0.001, group: '需求' },
  { path: 'intimacy.enabled', label: '亲密系统总开关', type: 'bool', group: '亲密' },
  { path: 'intimacy.promptThreshold.arousal', label: '亲密唤起进入 Prompt 门槛', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.promptThreshold.sexual_tension', label: '性张力进入 Prompt 门槛', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.promptThreshold.aftercare_need', label: '事后需求进入 Prompt 门槛', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.gates.minCloseness', label: '亲密推进最低亲密度', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.gates.minTrust', label: '亲密推进最低信任', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.gates.maxTensionForIntimate', label: '亲密推进最高关系紧张', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.gates.maxRepairDebtForIntimate', label: '亲密推进最高和好债', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.gates.minEnergy', label: '亲密推进最低精力', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.growthPerHour.sexual_tension', label: '性张力每小时增速', min: 0, max: 0.05, step: 0.001, group: '亲密' },
  { path: 'intimacy.proactive.highTensionThreshold', label: '亲密主动·张力门槛', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.proactive.lowSatisfactionThreshold', label: '亲密主动·低满足门槛', min: 0, max: 1, step: 0.05, group: '亲密' },
  { path: 'intimacy.preferenceRecallBoost', label: '亲密场景偏好召回加成', min: 0, max: 0.5, step: 0.05, group: '亲密' },
  { path: 'proactive.desire.triggerThreshold', label: '需求主动消息门槛', min: 0, max: 1, step: 0.05, group: '主动性' },
  { path: 'proactive.desire.highThreshold', label: '需求语气升级门槛', min: 0, max: 1, step: 0.05, group: '主动性' },
  { path: 'proactive.desire.minCooldownFactor', label: '高需求最短冷却比例', min: 0.1, max: 1, step: 0.05, group: '主动性' },
  { path: 'behavior.maxReplyDelayMs', label: '行为回复延迟硬上限(ms)', min: 0, max: 600000, step: 1000, group: '行为' },
  { path: 'behavior.stonewallPerDay', label: '每日最多已读不回次数', min: 0, max: 1, step: 1, group: '行为' },
  { path: 'behavior.stonewallTensionThreshold', label: '已读不回紧张门槛', min: 0, max: 1, step: 0.05, group: '行为' },
  { path: 'behavior.stonewallRepairDebtThreshold', label: '已读不回关系债门槛', min: 0, max: 1, step: 0.05, group: '行为' },
  { path: 'story.beatsPerDay', label: '每条故事线每日节拍数', min: 0, max: 4, step: 1, group: '叙事' },
  { path: 'story.maxActiveLines', label: '最大并行故事线', min: 1, max: 6, step: 1, group: '叙事' },
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
  'proactive_rate_limits', 'behavior_state', 'companions', 'appearance_assets', 'jobs', 'chat_history',
  'world_state', 'story_lines', 'knowledge_entities', 'knowledge_relations',
  'companion_card_assets', 'album_custom_entries',
];

// ---------------------------------------------------------------
// 配置项 schema: 前端表单完全由它驱动, 加字段只需要改这里。
// secret: true 的字段读取时脱敏、保存时忽略掩码占位。
// ---------------------------------------------------------------
export const CONFIG_SCHEMA = [
  {
    id: 'admin',
    title: '管理控制台安全',
    hint: '控制台只绑定本机；如果通过代理或 Tunnel 访问，必须再配置一个高强度 Token。',
    fields: [
      { key: 'UI_ADMIN_TOKEN', label: 'Admin Token', secret: true, placeholder: '建议至少 32 位随机字符' },
    ],
  },
  {
    id: 'supabase',
    title: 'Supabase 数据库',
    hint: '记忆 / 状态 / 历史都存这里。建项目后在 Project Settings → API 里拿 URL 和 service_role key, 并在 SQL Editor 执行 sql/schema.sql。',
    testable: true,
    fields: [
      { key: 'SUPABASE_URL', label: 'Project URL', placeholder: 'https://xxxx.supabase.co', link: { label: '去控制台获取', url: 'https://supabase.com/dashboard/project/_/settings/api' } },
      { key: 'SUPABASE_KEY', label: 'Service Role Key', secret: true, placeholder: 'service_role key (不是 anon key)', link: { label: '去控制台获取', url: 'https://supabase.com/dashboard/project/_/settings/api-keys' } },
      { key: 'SUPABASE_ACCESS_TOKEN', label: 'Personal Access Token (可选, 仅供下方 SQL 工具箱建表用)', secret: true, placeholder: 'sbp_... (控制台 Account → Access Tokens 生成)', link: { label: '去生成令牌', url: 'https://supabase.com/dashboard/account/tokens' } },
      { key: 'DATABASE_URL', label: 'Postgres 连接串 (可选, MCP 只读查询用)', secret: true, placeholder: 'postgresql://postgres.xxx:密码@aws-...pooler.supabase.com:5432/postgres', link: { label: 'Database 设置', url: 'https://supabase.com/dashboard/project/_/settings/database' } },
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
    id: 'narration',
    title: '独立旁白模型',
    hint: '只润色动作、神态和氛围旁白，不改角色台词。留空模型名时不启用额外调用。',
    testable: true,
    fields: [
      { key: 'NARRATION_BASE_URL', label: 'Base URL', placeholder: '留空则复用回复模型地址' },
      { key: 'NARRATION_API_KEY', label: 'API Key', secret: true, placeholder: '留空则复用回复模型密钥' },
      { key: 'NARRATION_MODEL', label: '旁白模型', placeholder: '例如 doubao-seed-2-1-pro-260628' },
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
      { key: 'TTS_VOICE_ID', label: '克隆音色 ID / Voice ID', placeholder: 'voice_xxx；留空复用上面的音色' },
      { key: 'TTS_VOICE_CLONE_PROVIDER', label: '克隆服务商', placeholder: 'OpenAI / ElevenLabs / 自建 TTS' },
      { key: 'TTS_VOICE_CLONE_STATUS', label: '克隆状态', options: ['not_started', 'training', 'ready', 'paused'], placeholder: 'not_started' },
    ],
  },
  {
    id: 'image',
    title: '图片生成',
    hint: '用于自拍和场景照片。支持 OpenAI GPT Image 与火山方舟 Seedream 等兼容接口。',
    testable: true,
    fields: [
      { key: 'IMAGE_BASE_URL', label: 'Base URL', placeholder: 'https://api.openai.com/v1' },
      { key: 'IMAGE_API_KEY', label: 'API Key', secret: true, placeholder: '留空则复用 EMBED_API_KEY' },
      { key: 'IMAGE_MODEL', label: '图片模型', placeholder: 'gpt-image-2' },
      { key: 'IMAGE_SIZE', label: '尺寸', placeholder: '1024x1536' },
      { key: 'IMAGE_QUALITY', label: '画质', options: ['high', 'medium', 'low', 'auto'], placeholder: 'high' },
      { key: 'IMAGE_BACKGROUND', label: '背景', options: ['opaque', 'transparent', 'auto'], placeholder: 'opaque' },
      { key: 'IMAGE_OUTPUT_FORMAT', label: '输出格式', options: ['png', 'webp', 'jpeg'], placeholder: 'png' },
      { key: 'IMAGE_OUTPUT_COMPRESSION', label: '输出质量/压缩率 (0-100)', type: 'number', min: 0, max: 100, placeholder: '100' },
      { key: 'IMAGE_LORA_ID', label: '角色 LoRA ID', placeholder: 'lora_xxx / adapter name' },
      { key: 'IMAGE_LORA_TRIGGER', label: 'LoRA 触发词', placeholder: 'shiya_character_v2' },
      { key: 'IMAGE_LORA_STATUS', label: 'LoRA 状态', options: ['not_started', 'training', 'ready', 'paused'], placeholder: 'not_started' },
    ],
  },
  {
    id: 'r2',
    title: 'Cloudflare R2 图床',
    hint: '穿搭系统 / 穿搭相册的卡片成片存在 R2；提示词与图片 URL 写在 Supabase companion_card_assets。本机开发可不填 Token（自动用 wrangler login）；生产建议填长期 API Token。',
    testable: true,
    links: [
      { label: 'R2 控制台', url: 'https://dash.cloudflare.com/?to=/:account/r2' },
      { label: '创建 API Token', url: 'https://dash.cloudflare.com/profile/api-tokens' },
    ],
    fields: [
      { key: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID', placeholder: '2581ca9560b48b398983980c1668d0d2', link: { label: '在 R2 概览页复制', url: 'https://dash.cloudflare.com/?to=/:account/r2' } },
      { key: 'R2_BUCKET', label: 'Bucket 名', placeholder: 'qingci-companion-media' },
      { key: 'R2_PUBLIC_BASE', label: '公网访问前缀 (r2.dev 或自定义域)', placeholder: 'https://pub-xxxxx.r2.dev' },
      { key: 'CLOUDFLARE_API_TOKEN', label: 'API Token (可选)', secret: true, placeholder: '留空则本机用 wrangler login；需 Account · R2 写权限' },
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
      { key: 'TELEGRAM_PROXY_URL', label: 'HTTP/HTTPS 代理（可选）', placeholder: 'http://127.0.0.1:1082' },
    ],
  },
  {
    id: 'feishu',
    title: '飞书机器人',
    hint: '使用飞书自建应用的长连接接收消息，本机无需公网回调地址。应用需开启机器人能力和 im.message.receive_v1 事件。',
    testable: true,
    fields: [
      { key: 'FEISHU_APP_ID', label: 'App ID', placeholder: 'cli_xxx', link: { label: '飞书开放平台', url: 'https://open.feishu.cn/app' } },
      { key: 'FEISHU_APP_SECRET', label: 'App Secret', secret: true, placeholder: '应用凭证' },
      { key: 'FEISHU_VERIFICATION_TOKEN', label: 'Verification Token（可选）', secret: true, placeholder: '事件订阅验证令牌' },
      { key: 'FEISHU_ENCRYPT_KEY', label: 'Encrypt Key（可选）', secret: true, placeholder: '事件加密密钥' },
      { key: 'FEISHU_COMPANION_NAME', label: '她的名字', placeholder: '小忆' },
      { key: 'FEISHU_SUBJECT_NAME', label: '你的称呼', placeholder: '你' },
      { key: 'FEISHU_COMPANION_ID', label: '角色 ID', placeholder: 'default' },
    ],
    advanced: [
      { key: 'FEISHU_PERSONA_FILE', label: '人设文件路径', placeholder: 'companions/default.json' },
      { key: 'FEISHU_REPLY_TIMEOUT_MS', label: '单次回复超时 (ms)', placeholder: '90000' },
    ],
  },
  {
    id: 'discord',
    title: 'Discord 机器人',
    hint: '使用 Discord Gateway 长连接。私聊直接回复；服务器频道中仅在被 @ 时回复。请在 Bot 页面开启 Message Content Intent。',
    testable: true,
    fields: [
      { key: 'DISCORD_BOT_TOKEN', label: 'Bot Token', secret: true, placeholder: 'Discord Bot Token', link: { label: 'Discord Developer Portal', url: 'https://discord.com/developers/applications' } },
      { key: 'DISCORD_ALLOWED_GUILD_IDS', label: '允许的服务器 ID（可选，逗号分隔）', placeholder: '' },
      { key: 'DISCORD_COMPANION_NAME', label: '她的名字', placeholder: '小忆' },
      { key: 'DISCORD_SUBJECT_NAME', label: '你的称呼', placeholder: '你' },
      { key: 'DISCORD_COMPANION_ID', label: '角色 ID', placeholder: 'default' },
    ],
    advanced: [
      { key: 'DISCORD_PERSONA_FILE', label: '人设文件路径', placeholder: 'companions/default.json' },
      { key: 'DISCORD_REPLY_TIMEOUT_MS', label: '单次回复超时 (ms)', placeholder: '90000' },
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

async function testFeishu(env) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return { ok: false, message: '先填 FEISHU_APP_ID 和 FEISHU_APP_SECRET' };
  const { res, ms } = await timedFetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const body = await res.json().catch(() => null);
  return body?.code === 0
    ? { ok: true, ms, message: '应用凭证有效，可以建立长连接' }
    : { ok: false, ms, message: body?.msg || `HTTP ${res.status}` };
}

async function testDiscord(env) {
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, message: '先填 DISCORD_BOT_TOKEN' };
  const { res, ms } = await timedFetch('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  const body = await res.json().catch(() => null);
  return res.ok
    ? { ok: true, ms, message: `@${body.global_name || body.username} 凭证有效` }
    : { ok: false, ms, message: body?.message || `HTTP ${res.status}` };
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
    body: JSON.stringify({ model: cfg.model, voice: env.TTS_VOICE_ID || env.TTS_VOICE || 'nova', input: '你好', response_format: 'opus' }),
  }, 45000);
  if (res.ok) {
    const bytes = (await res.arrayBuffer()).byteLength;
    if (bytes > 0) return { ok: true, ms, message: `${cfg.model} 可用, 合成 ${bytes} 字节 opus (音色 ${env.TTS_VOICE_ID || env.TTS_VOICE || 'nova'})` };
    return { ok: false, ms, message: '服务返回了空音频' };
  }
  const body = await res.json().catch(() => null);
  return { ok: false, ms, message: body?.error?.message ? String(body.error.message).slice(0, 160) : `HTTP ${res.status}` };
}

async function testR2(env) {
  const started = Date.now();
  const { resolveR2Config, uploadToR2, deleteFromR2 } = await import('../media/r2.js');
  const cfg = resolveR2Config(env);
  if (!cfg.configured) {
    return { ok: false, message: '先填 CLOUDFLARE_ACCOUNT_ID、R2_BUCKET、R2_PUBLIC_BASE' };
  }
  if (!cfg.canUpload) {
    return {
      ok: false,
      message: '没有可用 Token：请填 CLOUDFLARE_API_TOKEN，或在本机执行 wrangler login',
      detail: { accountId: cfg.accountId, bucket: cfg.bucket, publicBase: cfg.publicBase },
    };
  }
  const key = `test/ui-ping-${Date.now()}.txt`;
  const payload = Buffer.from(`qingci-r2-ping ${new Date().toISOString()}`);
  const up = await uploadToR2(payload, { mime: 'text/plain', key, env });
  if (!up.ok) return { ok: false, ms: Date.now() - started, message: up.message };
  const get = await fetch(up.url, { signal: AbortSignal.timeout(15000) }).catch((e) => ({ ok: false, status: 0, error: e }));
  const bodyText = get.ok ? await get.text().catch(() => '') : '';
  // 测试文件顺手清掉，避免桶里堆垃圾
  await deleteFromR2(key, env).catch(() => null);
  if (!get.ok || !String(bodyText).includes('qingci-r2-ping')) {
    return {
      ok: false,
      ms: Date.now() - started,
      message: `上传成功但公网读取失败 (HTTP ${get.status || 0})，检查 R2_PUBLIC_BASE 与桶是否开启 r2.dev 公开访问`,
      detail: { url: up.url, bucket: cfg.bucket },
    };
  }
  return {
    ok: true,
    ms: Date.now() - started,
    message: `R2 可用 · ${cfg.bucket} · 公网 ${cfg.publicBase}`,
    detail: { accountId: cfg.accountId, bucket: cfg.bucket, publicBase: cfg.publicBase, sampleUrl: up.url },
  };
}

const TESTS = {
  supabase: testSupabase,
  llm: testLlm,
  reply: (env) => testChatTarget('reply', env),
  narration: (env) => testChatTarget('narration', env),
  vision: (env) => testChatTarget('vision', env),
  embedding: testEmbedding,
  asr: (env) => testCatalogTarget('asr', env),
  tts: testTts,
  image: (env) => testCatalogTarget('image', env),
  r2: testR2,
  cloudflare: testR2,
  telegram: testTelegram,
  feishu: testFeishu,
  discord: testDiscord,
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
  const narration = { base: env.NARRATION_BASE_URL || reply.base, key: env.NARRATION_API_KEY || reply.key, model: env.NARRATION_MODEL || '', keyName: 'NARRATION_API_KEY', modelName: 'NARRATION_MODEL' };
  const embedding = { base: env.EMBED_BASE_URL || 'https://api.openai.com/v1', key: env.EMBED_API_KEY || llm.key, model: env.EMBED_MODEL || 'text-embedding-3-small', keyName: 'EMBED_API_KEY', modelName: 'EMBED_MODEL' };
  const asr = { base: env.ASR_BASE_URL || embedding.base, key: env.ASR_API_KEY || embedding.key, model: env.ASR_MODEL || 'whisper-1', keyName: 'ASR_API_KEY', modelName: 'ASR_MODEL' };
  const map = {
    llm,
    reply,
    narration,
    vision: { base: env.VISION_BASE_URL || reply.base, key: env.VISION_API_KEY || reply.key, model: env.VISION_MODEL || reply.model, keyName: 'VISION_API_KEY', modelName: 'VISION_MODEL' },
    embedding,
    asr,
    tts: { base: env.TTS_BASE_URL || asr.base, key: env.TTS_API_KEY || asr.key, model: env.TTS_MODEL || '', keyName: 'TTS_API_KEY', modelName: 'TTS_MODEL' },
    image: { base: env.IMAGE_BASE_URL || embedding.base, key: env.IMAGE_API_KEY || embedding.key, model: env.IMAGE_MODEL || '', keyName: 'IMAGE_API_KEY', modelName: 'IMAGE_MODEL' },
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

/**
 * 之前 userId 为空时直接不设 user_id 过滤条件, 查询会退化成"查这张表里所有用户的数据"——
 * 谁调用时漏传/传空 userId (哪怕只是一次调试用的裸 curl), 读到的就是别的真实用户的私密数据。
 * 现在没有 userId 一律给一个必然查不到东西的过滤条件, 宁可返回空也不能返回错的人的数据 (fail closed)。
 */
function scopeFilters({ userId = '', companionId = '' } = {}) {
  const p = new URLSearchParams();
  p.set('user_id', userId ? `eq.${userId}` : 'eq.__no_scope_selected__');
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

const DEFAULT_INTIMACY = {
  arousal: 0,
  engagement: 0,
  aftercare_need: 0,
  sexual_tension: 0,
  sexual_openness: 0.35,
  satisfaction: 0.5,
  scene_phase: 'none',
  last_intimate_at: null,
  consent: { active: false, pace: 'normal', stop_signal: false },
  body_focus: null,
  repertoire: { last_positions: [], focus_position: null, focus_foreplay: null },
  updated_at: null,
};

function normalizeIntimacyRow(raw) {
  const base = { ...DEFAULT_INTIMACY, ...(raw && typeof raw === 'object' ? raw : {}) };
  const consent = { ...DEFAULT_INTIMACY.consent, ...(base.consent && typeof base.consent === 'object' ? base.consent : {}) };
  const phase = ['none', 'flirting', 'foreplay', 'peak', 'aftercare', 'cooldown'].includes(base.scene_phase)
    ? base.scene_phase
    : 'none';
  const clamp01 = (v, d = 0) => Math.min(1, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : d));
  return {
    arousal: clamp01(base.arousal, 0),
    engagement: clamp01(base.engagement, 0),
    aftercare_need: clamp01(base.aftercare_need, 0),
    sexual_tension: clamp01(base.sexual_tension, 0),
    sexual_openness: clamp01(base.sexual_openness, 0.35),
    satisfaction: clamp01(base.satisfaction, 0.5),
    scene_phase: phase,
    last_intimate_at: base.last_intimate_at || null,
    consent: {
      active: Boolean(consent.active),
      pace: ['slow', 'normal', 'eager'].includes(consent.pace) ? consent.pace : 'normal',
      stop_signal: Boolean(consent.stop_signal),
    },
    body_focus: base.body_focus ?? null,
    repertoire: {
      last_positions: Array.isArray(base.repertoire?.last_positions)
        ? base.repertoire.last_positions.map(String).slice(0, 6)
        : [],
      focus_position: base.repertoire?.focus_position ? String(base.repertoire.focus_position).slice(0, 40) : null,
      focus_foreplay: base.repertoire?.focus_foreplay ? String(base.repertoire.focus_foreplay).slice(0, 40) : null,
    },
    updated_at: base.updated_at ?? null,
  };
}

async function getStateBundle(env, scope) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  // 先带 intimacy 列；老库未迁移时回退无 intimacy 的查询，避免整页失败
  let affect = await supabaseRest(env, scopedPath('affective_state', { select: 'mood,relationship,desires,intimacy,updated_at', limit: '1' }, scope));
  if (!affect.ok) {
    affect = await supabaseRest(env, scopedPath('affective_state', { select: 'mood,relationship,desires,updated_at', limit: '1' }, scope));
  }
  let life = await supabaseRest(env, scopedPath('life_state', { select: 'energy,satiety,health,current_activity,last_slept_at,sick_until,late_night_streak,last_late_night_day,outfit,updated_at', limit: '1' }, scope));
  if (!life.ok) {
    life = await supabaseRest(env, scopedPath('life_state', { select: 'energy,satiety,health,current_activity,last_slept_at,sick_until,late_night_streak,last_late_night_day,updated_at', limit: '1' }, scope));
  }
  const history = await supabaseRest(env, scopedPath('affective_state_history', { select: 'mood,relationship,event,created_at', order: 'created_at.desc', limit: '80' }, scope));
  const defaultAffect = {
    mood: { valence: 0, arousal: 0.3 },
    relationship: { closeness: 0.5, tension: 0, repair_debt: 0, trust: 0.5 },
    desires: { attention: 0, sharing: 0, comfort: 0, security: 0 },
    intimacy: { ...DEFAULT_INTIMACY },
    updated_at: null,
  };
  const defaultLife = {
    energy: 0.6, satiety: 0.6, health: 1, current_activity: null, last_slept_at: null, sick_until: null,
    late_night_streak: 0, last_late_night_day: null,
    outfit: { current: null, context: 'home', changed_at: null, updated_at: null },
    updated_at: null,
  };
  const affectRow = affect.ok && affect.data?.[0] ? affect.data[0] : null;
  const affectOut = affectRow
    ? {
        ...defaultAffect,
        ...affectRow,
        desires: { ...defaultAffect.desires, ...(affectRow.desires || {}) },
        intimacy: normalizeIntimacyRow(affectRow.intimacy),
      }
    : defaultAffect;
  const lifeRow = life.ok && life.data?.[0] ? life.data[0] : null;
  const lifeOut = lifeRow
    ? {
        ...defaultLife,
        ...lifeRow,
        outfit: lifeRow.outfit && typeof lifeRow.outfit === 'object'
          ? lifeRow.outfit
          : defaultLife.outfit,
      }
    : defaultLife;
  return {
    ok: affect.ok || life.ok,
    affect: affectOut,
    life: lifeOut,
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

async function getCompanionUpgrade(env, scope) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  const companionId = scope.companionId || 'default';
  const [state, behavior, story, annuals, profile, world, gallery] = await Promise.all([
    getStateBundle(env, scope),
    supabaseRest(env, scopedPath('behavior_state', { select: 'state,updated_at', limit: '1' }, scope)).catch((error) => ({ ok: false, message: error?.message })),
    supabaseRest(env, scopedPath('story_lines', { select: 'storyline_key,title,stage,mood_link,last_beat,next_beat_hint,last_beat_at,beats_day,beats_today,beat_shared_at,last_beat_sharing,updated_at', order: 'updated_at.desc', limit: '12' }, scope)).catch((error) => ({ ok: false, message: error?.message })),
    supabaseRest(env, scopedPath('prospective', { select: 'id,content,trigger_kind,trigger_at,status,annual_key,last_fired_year,created_at', trigger_kind: 'eq.annual', order: 'trigger_at.asc', limit: '30' }, scope)).catch((error) => ({ ok: false, message: error?.message })),
    supabaseRest(env, scopedPath('memories', { select: 'id,content,fact_core,source,created_at', subject_kind: 'eq.self', superseded_by: 'is.null', order: 'created_at.desc', limit: '40' }, scope)).catch((error) => ({ ok: false, message: error?.message })),
    getWorld(env, scope).catch((error) => ({ ok: false, message: error?.message })),
    getGallery(env, scope).catch((error) => ({ ok: false, message: error?.message })),
  ]);
  const profileRow = profile.ok
    ? (profile.data ?? []).find((row) => row.source?.kind === 'user_profile') ?? null
    : null;
  return {
    ok: true,
    scope: { userId: scope.userId, companionId },
    affect: state.affect,
    life: state.life,
    behavior: behavior.ok ? behaviorSummary(behavior.data?.[0]) : null,
    story: story.ok ? story.data ?? [] : [],
    annuals: annuals.ok ? annuals.data ?? [] : [],
    userProfile: profileRow,
    world: world.ok ? world.world : null,
    gallery: gallery.ok ? gallery.assets ?? [] : [],
    capabilities: {
      voice: {
        configured: Boolean(env.TTS_MODEL),
        model: env.TTS_MODEL || '',
        voice: env.TTS_VOICE_ID || env.TTS_VOICE || 'nova',
        cloneProvider: env.TTS_VOICE_CLONE_PROVIDER || '',
        cloneStatus: env.TTS_VOICE_CLONE_STATUS || '',
      },
      image: {
        configured: Boolean((env.IMAGE_API_KEY || env.EMBED_API_KEY || env.LLM_API_KEY) && env.IMAGE_MODEL),
        model: env.IMAGE_MODEL || '',
        loraId: env.IMAGE_LORA_ID || '',
        loraTrigger: env.IMAGE_LORA_TRIGGER || '',
        loraStatus: env.IMAGE_LORA_STATUS || '',
      },
    },
    issues: [state, behavior, story, annuals, profile, world, gallery]
      .filter((r) => r && !r.ok)
      .map((r) => r.missingTable ? '缺少数据库表，请重新执行 sql/schema.sql' : r.message)
      .filter(Boolean),
  };
}

function behaviorSummary(row) {
  const stonewallAt = Array.isArray(row?.state?.stonewallAt) ? row.state.stonewallAt : [];
  const last = stonewallAt.at(-1) ?? null;
  return {
    stonewall_count: stonewallAt.length,
    last_stonewall_at: last,
    mustGiveRepairStep: Boolean(row?.state?.mustGiveRepairStep),
    updated_at: row?.updated_at ?? null,
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
      ...(input.affect.desires ? { desires: {
        attention: clamp(input.affect.desires.attention), sharing: clamp(input.affect.desires.sharing),
        comfort: clamp(input.affect.desires.comfort), security: clamp(input.affect.desires.security),
        updated_at: new Date().toISOString(),
      } } : {}),
      ...(input.affect.intimacy ? {
        intimacy: {
          ...normalizeIntimacyRow(input.affect.intimacy),
          updated_at: new Date().toISOString(),
        },
      } : {}),
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
    if (input.life.outfit && typeof input.life.outfit === 'object') {
      row.outfit = {
        ...input.life.outfit,
        updated_at: new Date().toISOString(),
      };
    }
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

async function deleteGalleryAsset(env, id, scope) {
  if (!id || !scope?.userId || !scope?.companionId) return { ok: false, message: '缺少照片或用户范围' };
  const result = await supabaseRequest(env, scopedPath('appearance_assets', {
    id: `eq.${id}`,
    select: 'id',
  }, scope), { method: 'DELETE', headers: { prefer: 'return=representation' } });
  if (!result.ok) return result;
  const deleted = Array.isArray(result.data) && result.data.length === 1;
  return { ok: deleted, message: deleted ? '生成照片已删除' : '照片不存在或不属于当前用户' };
}

function publicReference(item) {
  return {
    id: item.id, name: item.name, mime: item.mime, bytes: item.bytes, createdAt: item.createdAt,
    isAvatar: Boolean(item.isAvatar), url: `/api/image-references/${item.id}/file`,
  };
}

function imageProviderFromEnv(env) {
  return new OpenAIImageProvider({
    baseURL: env.IMAGE_BASE_URL || env.EMBED_BASE_URL || 'https://api.openai.com/v1',
    apiKey: env.IMAGE_API_KEY || env.EMBED_API_KEY || '', model: env.IMAGE_MODEL || 'gpt-image-2',
    defaults: {
      size: env.IMAGE_SIZE || '1024x1536', quality: env.IMAGE_QUALITY || 'high',
      background: env.IMAGE_BACKGROUND || 'opaque', output_format: env.IMAGE_OUTPUT_FORMAT || 'png',
      output_compression: Number.parseInt(env.IMAGE_OUTPUT_COMPRESSION || '100', 10), input_fidelity: 'high',
      loraId: env.IMAGE_LORA_ID || '', loraTrigger: env.IMAGE_LORA_TRIGGER || '', loraStatus: env.IMAGE_LORA_STATUS || '',
    },
  });
}

async function generateUiImage(env, scope, body) {
  const provider = imageProviderFromEnv(env);
  const refs = listReferenceImages(scope.userId, scope.companionId || 'default');
  const selectedAll = Array.isArray(body.referenceIds) && body.referenceIds.length
    ? refs.filter((x) => body.referenceIds.includes(x.id)) : refs;
  // 16 张原始高清图接近 40MB，multipart 上传很容易在代理或图片供应商处超时。
  // 头像优先，再取少量核心图即可保持身份一致性，同时让请求稳定落在合理体积。
  const selected = [...selectedAll]
    .sort((a, b) => Number(Boolean(b.isAvatar)) - Number(Boolean(a.isAvatar)))
    .slice(0, 4);
  const inputs = selected.map((x) => ({ path: referenceFilePath(x), mime: x.mime, name: x.name }));
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return { ok: false, message: '请输入生成提示词' };
  const opts = {
    size: body.size || env.IMAGE_SIZE || '1024x1536',
    quality: body.quality || env.IMAGE_QUALITY || 'high',
    input_fidelity: body.inputFidelity || 'high',
    loraId: env.IMAGE_LORA_ID || '',
    loraTrigger: env.IMAGE_LORA_TRIGGER || '',
    loraStatus: env.IMAGE_LORA_STATUS || '',
  };
  if (body.mask?.data) opts.mask = { buffer: Buffer.from(body.mask.data, 'base64'), name: body.mask.name || 'mask.png' };
  const result = inputs.length ? await provider.edit(prompt, inputs, opts) : await provider.generate(prompt, opts);
  return { ok: true, image: result.url, meta: result.meta, message: inputs.length ? `已使用 ${inputs.length} 张参考图生成` : '图片生成完成' };
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

/** 合并写入覆盖文件 (不是整份替换) —— 前端每次只传本次改动的字段, 之前保存过的其它覆盖不能被这次请求悄悄抹掉。 */
function saveParams(values = {}) {
  const overrides = readParamOverrides();
  let applied = 0;
  for (const field of PARAM_SCHEMA) {
    if (!(field.path in values)) continue;
    if (field.type === 'bool') {
      setPathValue(overrides, field.path, Boolean(values[field.path]));
      applied += 1;
      continue;
    }
    let value = Number(values[field.path]);
    if (!Number.isFinite(value)) continue;
    value = Math.min(field.max, Math.max(field.min, value));
    if (field.step >= 1) value = Math.round(value);
    setPathValue(overrides, field.path, value);
    applied += 1;
  }
  fs.mkdirSync(path.dirname(PARAMS_FILE), { recursive: true });
  fs.writeFileSync(PARAMS_FILE, `${JSON.stringify(overrides, null, 2)}\n`);
  return { ok: true, message: `已保存 ${applied} 项参数；重启 Bot 后生效`, values: overrides };
}

/** 清空全部参数覆盖, 整个系统回到 DEFAULT_PARAMS。是显式动作, 不是"传空 values"的副作用。 */
function resetParams() {
  fs.mkdirSync(path.dirname(PARAMS_FILE), { recursive: true });
  fs.writeFileSync(PARAMS_FILE, '{}\n');
  return { ok: true, message: '已重置为默认参数；重启 Bot 后生效' };
}

async function exportScope(env, scope) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  const policy = readProductPolicy().safety;
  if (policy.dataRights?.allowExport === false) {
    return { ok: false, message: '当前策略禁止导出' };
  }
  const tables = {};
  for (const table of BACKUP_TABLES) {
    const r = await supabaseRest(env, scopedPath(table, { select: '*', limit: '10000' }, scope));
    if (r.ok) tables[table] = r.data;
  }
  const redacted = redactExportTables(tables, policy);
  return { ok: true, version: 1, exportedAt: new Date().toISOString(), scope, tables: redacted, redacted: Boolean(policy.redactPII) };
}

// ---- P2 产品策略：安全 / 配额 ----
function readProductPolicy() {
  let raw = {};
  try {
    if (fs.existsSync(PRODUCT_POLICY_FILE)) raw = JSON.parse(fs.readFileSync(PRODUCT_POLICY_FILE, 'utf8'));
  } catch {
    raw = {};
  }
  return {
    safety: normalizeSafetyPolicy(raw.safety || {}),
    quota: normalizeQuota(raw.quota || {}),
    updatedAt: raw.updatedAt || null,
  };
}

function writeProductPolicy(patch = {}) {
  const cur = readProductPolicy();
  const next = {
    safety: normalizeSafetyPolicy(patch.safety !== undefined ? { ...cur.safety, ...patch.safety } : cur.safety),
    quota: normalizeQuota(patch.quota !== undefined ? { ...cur.quota, ...patch.quota } : cur.quota),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(PRODUCT_POLICY_FILE), { recursive: true });
  fs.writeFileSync(PRODUCT_POLICY_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function getProductLife(env, scope) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  const companionId = scope.companionId || 'default';
  const [state, history, episodes, story, gallery, annuals, behavior] = await Promise.all([
    getStateBundle(env, scope),
    supabaseRest(env, scopedPath('chat_history', { select: 'id,role,content,created_at', order: 'created_at.desc', limit: '40' }, scope)),
    supabaseRest(env, scopedPath('memories', {
      select: 'id,type,content,fact_core,narrative,created_at,subject_kind',
      type: 'eq.episode',
      superseded_by: 'is.null',
      order: 'created_at.desc',
      limit: '20',
    }, scope)),
    supabaseRest(env, scopedPath('story_lines', {
      select: 'storyline_key,title,stage,last_beat,next_beat_hint,last_beat_at,updated_at',
      order: 'updated_at.desc',
      limit: '8',
    }, scope)),
    getGallery(env, scope).catch(() => ({ ok: false, assets: [] })),
    supabaseRest(env, scopedPath('prospective', {
      select: 'id,content,trigger_kind,trigger_at,status,created_at',
      trigger_kind: 'eq.annual',
      order: 'trigger_at.asc',
      limit: '20',
    }, scope)),
    supabaseRest(env, scopedPath('behavior_state', { select: 'state,updated_at', limit: '1' }, scope)).catch(() => ({ ok: false })),
  ]);

  const hist = history.ok ? (history.data || []).reverse() : [];
  const eps = episodes.ok ? episodes.data || [] : [];
  const stories = story.ok ? story.data || [] : [];
  const photos = gallery.ok ? gallery.assets || [] : [];
  const anns = annuals.ok ? annuals.data || [] : [];
  const timeline = buildTimeline({
    history: hist,
    episodes: eps,
    story: stories,
    photos: photos.slice(0, 12),
    annuals: anns,
    life: state.life,
  });
  const relationship = buildRelationshipView({
    relationship: state.affect?.relationship || state.relationship || {},
    annuals: anns,
    episodes: eps,
    behavior: behavior.ok ? behaviorSummary(behavior.data?.[0]) : null,
    desires: state.affect?.desires || null,
  });

  return {
    ok: true,
    scope: { userId: scope.userId, companionId },
    day: timeline.summary,
    timeline: timeline.events,
    relationship,
    outfit: state.life?.outfit || null,
    photos: photos.slice(0, 24).map((p) => ({ id: p.id, url: p.url, tags: p.tags, created_at: p.created_at })),
    story: stories,
  };
}

async function getProductUsage(env, scope) {
  if (!scope.userId) return { messagesToday: 0, photosToday: 0, memories: 0, companions: 0 };
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const iso = dayStart.toISOString();
  const filters = { user_id: `eq.${scope.userId}`, companion_id: `eq.${scope.companionId || 'default'}` };
  const [messagesToday, photosToday, memories, companions] = await Promise.all([
    supabaseCount(env, 'chat_history', { ...filters, created_at: `gte.${iso}` }).catch(() => 0),
    supabaseCount(env, 'appearance_assets', { ...filters, created_at: `gte.${iso}` }).catch(() => 0),
    supabaseCount(env, 'memories', { ...filters, superseded_by: 'is.null' }).catch(() => 0),
    supabaseCount(env, 'companions', { user_id: `eq.${scope.userId}` }).catch(() => 1),
  ]);
  return { messagesToday, photosToday, memories, companions, tokensMonth: 0 };
}

async function getProductQuota(env, scope) {
  const policy = readProductPolicy();
  const usage = scope?.userId ? await getProductUsage(env, scope) : {
    messagesToday: 0, photosToday: 0, memories: 0, companions: 0, tokensMonth: 0,
  };
  const check = checkQuota(usage, policy.quota);
  return { ok: true, ...check, scope: scope?.userId ? scope : null };
}

async function deleteScopeData(env, scope, { confirm } = {}) {
  if (!scope.userId) return { ok: false, message: '请先选择用户和角色' };
  const policy = readProductPolicy().safety;
  if (policy.dataRights?.allowDelete === false) return { ok: false, message: '当前策略禁止删除' };
  if (confirm !== 'DELETE') return { ok: false, message: '请传 confirm: "DELETE" 二次确认' };
  const deleted = {};
  for (const table of BACKUP_TABLES) {
    // PostgREST: DELETE with filters
    const path = `${table}?user_id=eq.${encodeURIComponent(scope.userId)}&companion_id=eq.${encodeURIComponent(scope.companionId || 'default')}`;
    const r = await supabaseRequest(env, path, {
      method: 'DELETE',
      headers: { prefer: 'return=minimal' },
      timeoutMs: 120000,
    }).catch((e) => ({ ok: false, message: e?.message }));
    deleted[table] = r.ok ? 'ok' : (r.message || 'fail');
  }
  return { ok: true, deleted, message: `已删除 ${scope.userId} / ${scope.companionId || 'default'} 的作用域数据` };
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
    const conflict = table === 'chat_history' ? '' : table === 'affective_state' || table === 'life_state' || table === 'proactive_rate_limits' || table === 'behavior_state' || table === 'companions' || table === 'world_state' ? 'user_id,companion_id' : 'id';
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
  const required = ['memories', 'affective_state', 'life_state', 'prospective', 'chat_history', 'world_state', 'story_lines', 'jobs', 'behavior_state'];
  const optional = ['knowledge_entities', 'knowledge_relations', 'appearance_assets', 'companions', 'companion_card_assets', 'album_custom_entries'];
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
      image: Boolean((env.IMAGE_API_KEY || env.EMBED_API_KEY || env.LLM_API_KEY) && env.IMAGE_MODEL),
      r2: (() => {
        try {
          // 同步粗检：桶配置是否齐全（Token 可能来自 wrangler，不在 .env）
          const hasBucket = Boolean(env.R2_BUCKET && env.R2_PUBLIC_BASE && (env.CLOUDFLARE_ACCOUNT_ID || env.R2_ACCOUNT_ID));
          return hasBucket;
        } catch {
          return false;
        }
      })(),
      telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
      feishu: Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET),
      discord: Boolean(env.DISCORD_BOT_TOKEN),
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

/**
 * 人设文件白名单: companions/ 下的 xxx.json (单文件) 或 <角色ID>/xxx.json (目录式分片)。
 * 拒绝路径穿越/隐藏文件/更深层级。纯函数, 供单测。
 */
export function safePersonaName(name = '') {
  const segs = String(name ?? '').trim().replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs.length < 1 || segs.length > 2) return null;
  const file = segs.at(-1);
  if (!/^[\w.-]+\.json$/.test(file) || file.startsWith('.')) return null;
  if (segs.length === 2 && (!/^[\w-]+$/.test(segs[0]) || segs[0].startsWith('.'))) return null;
  return segs.join('/');
}

function listPersonas() {
  if (!fs.existsSync(COMPANIONS_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(COMPANIONS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && safePersonaName(entry.name)) out.push(entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      for (const f of fs.readdirSync(path.join(COMPANIONS_DIR, entry.name))) {
        const nested = `${entry.name}/${f}`;
        if (safePersonaName(nested)) out.push(nested);
      }
    }
  }
  return out.sort();
}

function savePersona(name, content) {
  const clean = safePersonaName(name);
  if (!clean) return { ok: false, message: '文件名只能是 companions/ 下的 xxx.json 或 <角色ID>/xxx.json' };
  try {
    JSON.parse(content); // 只校验合法性, 原样保存 (保留用户自己的排版)
  } catch (error) {
    return { ok: false, message: `JSON 不合法: ${error.message}` };
  }
  fs.mkdirSync(path.dirname(path.join(COMPANIONS_DIR, clean)), { recursive: true });
  fs.writeFileSync(path.join(COMPANIONS_DIR, clean), content.endsWith('\n') ? content : `${content}\n`);
  return { ok: true, message: `已保存 companions/${clean} (bot 重启后生效)` };
}

// ---------------------------------------------------------------
// 多角色管理: 列出/新建/克隆/删除 companions/ 下的角色。
// 角色 = 一个 companionId, 对应 companions/<id>.json (单文件) 或 companions/<id>/ (目录分片)。
// 只操作人设文件本身; 该角色已经产生的记忆/状态数据留在 Supabase, 按 companionId 隔离,
// 删角色文件不会动数据库 —— 这里的"删除"只是"不再用这份人设配置", 不是抹掉聊天记录。
// ---------------------------------------------------------------

/** 角色 ID 白名单: 字母/数字/下划线/短横线, 不允许隐藏名/穿越。纯函数, 供单测。 */
export function safeCompanionId(id = '') {
  const clean = String(id ?? '').trim();
  return /^[\w-]{1,64}$/.test(clean) && !clean.startsWith('.') ? clean : null;
}

function companionDirPath(id) {
  return path.join(COMPANIONS_DIR, id);
}
function companionFilePath(id) {
  return path.join(COMPANIONS_DIR, `${id}.json`);
}
function companionExists(id) {
  return fs.existsSync(companionDirPath(id)) || fs.existsSync(companionFilePath(id));
}

/** 读一个角色的 persona 分片(目录式)或整份 JSON(单文件), 取显示名; 读不出来就回退 ID 本身。 */
function companionDisplayName(id) {
  try {
    const dir = companionDirPath(id);
    const json = fs.existsSync(dir) && fs.statSync(dir).isDirectory()
      ? JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8'))
      : JSON.parse(fs.readFileSync(companionFilePath(id), 'utf8'));
    return json?.persona?.name || json?.meta?.display_name || id;
  } catch {
    return id;
  }
}

/** 列出全部角色 ID (目录式 + 单文件去重合并)。 */
export function listCompanionIds() {
  if (!fs.existsSync(COMPANIONS_DIR)) return [];
  const ids = new Set();
  for (const entry of fs.readdirSync(COMPANIONS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && safeCompanionId(entry.name)) ids.add(entry.name);
    if (entry.isFile() && /\.json$/.test(entry.name)) {
      const id = entry.name.slice(0, -5);
      if (safeCompanionId(id)) ids.add(id);
    }
  }
  return [...ids].sort();
}

function listCompanions() {
  return listCompanionIds().map((id) => {
    const dir = companionDirPath(id);
    const isDir = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    return {
      companionId: id,
      name: companionDisplayName(id),
      format: isDir ? 'dir' : 'file',
      shardCount: isDir ? fs.readdirSync(dir).filter((f) => safePersonaName(`${id}/${f}`)).length : 1,
    };
  });
}

// 目录式人设里 profile 之外的其余分片; 每个文件都是 { <section>: {...} } 或 (persona/relationship)
// 带 meta/emotion_baseline 等额外顶层键的形态 —— 通用接口直接读写整份文件内容, 不narrow到单个 key,
// 这样不用对 persona/relationship 的多顶层键做特殊处理。profile 有专门的结构化表单 (见下方
// readCompanionProfile/saveCompanionProfile), 不走这条通用路径。
const COMPANION_SECTIONS = ['persona', 'appearance', 'life', 'relationship', 'runtime', 'knowledge', 'story', 'narration', 'intimacy'];

function companionSectionFilePath(id, section) {
  return path.join(companionDirPath(id), `${section}.json`);
}

/** 读一个角色某个分片的原始 JSON (给控制台的通用编辑器用); 文件不存在返回空对象, 不算错误。 */
function readCompanionSection(companionId, section) {
  const id = safeCompanionId(companionId);
  if (!id) return { ok: false, message: '角色 ID 不合法' };
  if (!COMPANION_SECTIONS.includes(section)) return { ok: false, message: `未知分片: ${section}` };
  const file = companionSectionFilePath(id, section);
  try {
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    return { ok: true, data };
  } catch (error) {
    return { ok: false, message: `分片读取失败: ${error.message}` };
  }
}

/** 整份覆盖写一个角色某个分片的 JSON (给控制台的通用编辑器用); 角色目录不存在会自动建。 */
function saveCompanionSection(companionId, section, data) {
  const id = safeCompanionId(companionId);
  if (!id) return { ok: false, message: '角色 ID 不合法' };
  if (!COMPANION_SECTIONS.includes(section)) return { ok: false, message: `未知分片: ${section}` };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, message: '内容必须是 JSON 对象' };
  try {
    fs.mkdirSync(companionDirPath(id), { recursive: true });
    fs.writeFileSync(companionSectionFilePath(id, section), `${JSON.stringify(data, null, 2)}\n`);
    return { ok: true, message: '已保存；下次对话会读取新的设定' };
  } catch (error) {
    return { ok: false, message: `保存失败: ${error.message}` };
  }
}

// ---- 穿搭系统（衣橱目录 + 卡片图/提示词资产） ----

function readCompanionOutfitRaw(companionId) {
  const id = safeCompanionId(companionId) || 'default';
  const file = path.join(companionDirPath(id), 'outfit.json');
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw?.outfit && typeof raw.outfit === 'object' ? raw.outfit : raw;
  } catch {
    return null;
  }
}

function companionRootForAssets(companionId) {
  const id = safeCompanionId(companionId) || 'default';
  const dir = companionDirPath(id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadCardAssetMap(env, companionId, collection) {
  const r = await supabaseRest(env, listAssetsPath(companionId, collection));
  if (!r.ok) {
    if (r.missingTable) {
      return { ok: false, missingTable: true, map: {}, message: '缺少 companion_card_assets 表，请在 Supabase 执行 sql/card-assets.sql' };
    }
    return { ok: false, map: {}, message: r.message };
  }
  return { ok: true, map: rowsToAssetMapLite(r.data || []) };
}

function attachOutfitCatalogAssets(catalog, assetMap, companionId) {
  const keys = ['looks', 'pieces', 'bags', 'beauty', 'lingerie', 'shoes', 'jewelry', 'watches', 'accessories', 'outerwear', 'travel'];
  const out = { ...catalog, counts: { ...catalog.counts } };
  for (const key of keys) {
    if (!Array.isArray(catalog[key])) continue;
    out[key] = attachAssetsToCards(catalog[key], assetMap, { companionId, collection: 'outfit' });
  }
  return out;
}

async function getOutfitCatalog(env, scope = {}) {
  const companionId = safeCompanionId(scope.companionId) || 'default';
  const raw = readCompanionOutfitRaw(companionId);
  const catalog = buildOutfitCatalog(raw);
  const assets = await loadCardAssetMap(env, companionId, 'outfit');
  const enriched = attachOutfitCatalogAssets(catalog, assets.map || {}, companionId);
  let current = null;
  if (scope.userId) {
    const life = await supabaseRest(env, scopedPath('life_state', { select: 'outfit,updated_at', limit: '1' }, {
      userId: scope.userId,
      companionId,
    }));
    if (life.ok && life.data?.[0]?.outfit) current = life.data[0].outfit;
  }
  return {
    ok: true,
    companionId,
    current,
    storage: 'supabase',
    assetsOk: assets.ok,
    assetsMessage: assets.ok ? null : assets.message,
    ...enriched,
  };
}

async function wearOutfitLook(env, scope, lookId) {
  if (!scope?.userId) return { ok: false, message: '请先选择用户和角色' };
  const companionId = safeCompanionId(scope.companionId) || 'default';
  const raw = readCompanionOutfitRaw(companionId);
  const wardrobe = normalizeWardrobe(raw);
  const look = (wardrobe.wardrobe || []).find((x) => x.id === String(lookId || ''));
  if (!look) return { ok: false, message: `找不到造型：${lookId}` };
  const outfit = lookToOutfitState({
    lookId: look.id,
    context: look.context,
    summary: look.summary,
    style: look.style,
    pieces: look.pieces,
  });
  // 读出现有 life 行，避免只写 outfit 时把 energy 等冲成 0
  let life = await supabaseRest(env, scopedPath('life_state', {
    select: 'energy,satiety,health,current_activity,last_slept_at,sick_until,late_night_streak,last_late_night_day,outfit',
    limit: '1',
  }, { userId: scope.userId, companionId }));
  if (!life.ok) {
    life = await supabaseRest(env, scopedPath('life_state', {
      select: 'energy,satiety,health,current_activity,last_slept_at,sick_until,late_night_streak,last_late_night_day',
      limit: '1',
    }, { userId: scope.userId, companionId }));
  }
  const prev = life.ok && life.data?.[0] ? life.data[0] : {};
  const prevOutfit = prev.outfit && typeof prev.outfit === 'object' ? prev.outfit : {};
  const dayKey = localDayKey(Date.now(), DEFAULT_PARAMS.outfit?.dailyLook?.timezoneOffsetMinutes ?? 480);
  const outfitWithDaily = clampOutfitState({
    ...outfit,
    daily_key: dayKey,
    composed_from: { lookId: look.id, source: 'manual_wear' },
    daily_photo: prevOutfit.daily_key === dayKey ? prevOutfit.daily_photo : null,
  });
  const row = {
    user_id: scope.userId,
    companion_id: companionId,
    energy: Number.isFinite(Number(prev.energy)) ? Number(prev.energy) : 0.6,
    satiety: Number.isFinite(Number(prev.satiety)) ? Number(prev.satiety) : 0.6,
    health: Number.isFinite(Number(prev.health)) ? Number(prev.health) : 1,
    current_activity: prev.current_activity ?? null,
    last_slept_at: prev.last_slept_at ?? null,
    sick_until: prev.sick_until ?? null,
    late_night_streak: prev.late_night_streak ?? 0,
    last_late_night_day: prev.last_late_night_day ?? null,
    outfit: outfitWithDaily,
    updated_at: new Date().toISOString(),
  };
  const result = await supabaseRequest(env, 'life_state?on_conflict=user_id,companion_id', {
    method: 'POST',
    body: row,
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
  });
  if (!result.ok) return result;
  return { ok: true, outfit: outfitWithDaily, message: `已上身：${look.summary || look.id}` };
}

/** 保存日更成片到相册（data URL → R2；http/mock → 直接写 url） */
async function saveDailyAlbumImage(env, companionId, cardId, payload = {}) {
  const id = safeCompanionId(companionId) || 'default';
  const key = normalizeCardKey(cardId) || cardId;
  const url = String(payload.url || '');
  if (payload.prompt) {
    await upsertCardAsset(env, id, 'album', key, { prompt: payload.prompt }).catch(() => null);
  }
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/s);
    if (m) {
      return uploadCardImageToR2AndDb(env, id, 'album', key, {
        mime: m[1] || payload.mime || 'image/png',
        data: m[2],
        name: `${key}.png`,
      });
    }
  }
  if (url) {
    const r = await upsertCardAsset(env, id, 'album', key, {
      prompt: payload.prompt,
      url,
      mime: payload.mime || 'image/png',
      meta: {
        has_image: true,
        storage: url.startsWith('mock://') ? 'mock' : 'remote',
        lookSummary: payload.lookSummary || null,
        daily: true,
      },
    });
    if (!r.ok) return r;
    return { ok: true, imageUrl: url, url, entry: r.entry };
  }
  return { ok: false, message: '无图片 URL' };
}

async function getDailyOutfit(env, scope = {}) {
  if (!scope?.userId) return { ok: false, message: '请先选择用户和角色' };
  const companionId = safeCompanionId(scope.companionId) || 'default';
  const raw = readCompanionOutfitRaw(companionId);
  const wardrobe = normalizeWardrobe(raw);
  let stored = defaultOutfitSafe(await readOutfit(scope.userId, companionId).catch(() => null));
  // 若 life 走 REST 失败则用 supabase 客户端 readOutfit
  const life = await supabaseRest(env, scopedPath('life_state', { select: 'outfit,updated_at', limit: '1' }, {
    userId: scope.userId,
    companionId,
  }));
  if (life.ok && life.data?.[0]?.outfit) {
    stored = clampOutfitState(life.data[0].outfit);
  }
  const ensured = ensureDailyLookState(stored, {
    wardrobe,
    now: Date.now(),
    config: DEFAULT_PARAMS.outfit,
  });
  if (ensured.composed) {
    await writeOutfit(scope.userId, companionId, ensured.state).catch(() => null);
  }
  const o = ensured.state;
  return {
    ok: true,
    companionId,
    dailyKey: o.daily_key,
    outfit: o,
    summary: o.current?.summary || null,
    pieces: o.current?.pieces || {},
    composedFrom: o.composed_from,
    photo: o.daily_photo,
    albumCardId: o.daily_photo?.albumCardId || (o.daily_key ? dailyAlbumCardId(o.daily_key) : null),
    hasPhoto: Boolean(o.daily_photo?.url),
  };
}

function defaultOutfitSafe(v) {
  return clampOutfitState(v || {});
}

async function recomposeDailyOutfit(env, scope = {}) {
  if (!scope?.userId) return { ok: false, message: '请先选择用户和角色' };
  const companionId = safeCompanionId(scope.companionId) || 'default';
  const raw = readCompanionOutfitRaw(companionId);
  const wardrobe = normalizeWardrobe(raw);
  const life = await supabaseRest(env, scopedPath('life_state', { select: 'outfit', limit: '1' }, {
    userId: scope.userId,
    companionId,
  }));
  const stored = clampOutfitState(life.ok && life.data?.[0]?.outfit ? life.data[0].outfit : {});
  const ensured = ensureDailyLookState(stored, {
    wardrobe,
    now: Date.now(),
    config: DEFAULT_PARAMS.outfit,
    force: true,
  });
  await writeOutfit(scope.userId, companionId, ensured.state).catch((e) => {
    throw e;
  });
  return {
    ok: true,
    message: '已重新组合今日穿搭',
    outfit: ensured.state,
    dailyKey: ensured.state.daily_key,
    summary: ensured.state.current?.summary,
    composedFrom: ensured.state.composed_from,
  };
}

function loadCompanionAppearanceText(companionId) {
  const id = safeCompanionId(companionId) || 'default';
  // 1) appearance.json · anchor_prompt
  try {
    const aPath = path.join(companionDirPath(id), 'appearance.json');
    if (fs.existsSync(aPath)) {
      const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
      const anchor = a?.appearance?.anchor_prompt || a?.anchor_prompt || a?.appearance;
      if (typeof anchor === 'string' && anchor.trim()) return anchor.trim().slice(0, 800);
    }
  } catch { /* ignore */ }
  // 2) profile.json
  try {
    const pPath = path.join(companionDirPath(id), 'profile.json');
    if (fs.existsSync(pPath)) {
      const p = JSON.parse(fs.readFileSync(pPath, 'utf8'));
      const text = p.appearance || p.look || p?.profile?.appearance;
      if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 800);
    }
  } catch { /* ignore */ }
  return 'elegant mature East Asian adult woman, refined facial proportions, polished executive presence';
}

async function generateDailyOutfitPhoto(env, scope = {}, { force = false } = {}) {
  if (!scope?.userId) return { ok: false, message: '请先选择用户和角色' };
  const companionId = safeCompanionId(scope.companionId) || 'default';
  const daily = await getDailyOutfit(env, scope);
  if (!daily.ok) return daily;
  const provider = imageProviderFromEnv(env);
  const appearance = loadCompanionAppearanceText(companionId);
  const t0 = Date.now();
  try {
    const result = await generateDailyLookPhoto({
      outfit: daily.outfit,
      appearance,
      snapshot: { outfit: daily.outfit, life: {}, emotion: {} },
      force: Boolean(force),
      provider,
      getReferences: () => {
        const refs = listReferenceImages(scope.userId, companionId);
        // 只取头像 + 1 张脸图，降低 edits 体积与失败率
        return [...refs]
          .sort((a, b) => Number(Boolean(b.isAvatar)) - Number(Boolean(a.isAvatar)))
          .slice(0, 2)
          .map((x) => ({ path: referenceFilePath(x), mime: x.mime, name: x.name }));
      },
      saveAlbum: (cardId, payload) => saveDailyAlbumImage(env, companionId, cardId, payload),
      writeAppearance: (asset) => insertAppearanceAsset(scope.userId, companionId, asset),
      writeOutfit: (outfit) => writeOutfit(scope.userId, companionId, outfit),
      config: DEFAULT_PARAMS.outfit,
    });
    const ms = Date.now() - t0;
    if (!result.ok && !result.skipped) {
      return {
        ok: false,
        message: result.reason || '生成失败',
        reason: result.reason,
        ms,
      };
    }
    return {
      ok: true,
      skipped: Boolean(result.skipped),
      message: result.skipped
        ? (result.reason === 'already' ? '今日成片已存在' : result.reason)
        : `今日穿搭成片已生成（${Math.round(ms / 1000)}s）`,
      url: result.url,
      albumCardId: result.albumCardId,
      outfit: result.outfit,
      lookSummary: result.lookSummary || null,
      ms,
    };
  } catch (error) {
    console.error('[generateDailyOutfitPhoto]', error);
    const raw = error?.message || String(error);
    // 图模安全审核 / 业务错误直接透出，不要再包一层「网络请求失败」
    const message = /safety|sexual|生成失败|超时|参考图|质量|quality_gate/i.test(raw)
      ? raw
      : (describeNetworkError(error) || raw || '生成失败');
    return {
      ok: false,
      message,
      ms: Date.now() - t0,
    };
  }
}

async function upsertCardAsset(env, companionId, collection, cardId, patch) {
  const id = safeCompanionId(companionId) || 'default';
  const key = normalizeCardKey(cardId);
  if (!key) return { ok: false, message: '缺少卡片 ID' };
  const existing = await supabaseRest(env, oneAssetPath(id, collection, key, { withImage: false }));
  const prev = existing.ok && existing.data?.[0] ? existing.data[0] : null;
  const body = upsertAssetBody(id, collection, key, {
    prompt: patch.prompt !== undefined ? patch.prompt : prev?.prompt,
    mime: patch.clearImage ? null : (patch.mime !== undefined ? patch.mime : prev?.mime),
    url: patch.clearImage ? null : (patch.url !== undefined ? patch.url : prev?.url),
    r2_key: patch.clearImage ? null : (patch.r2_key !== undefined ? patch.r2_key : prev?.r2_key),
    meta: patch.meta || prev?.meta || {},
    clearImage: Boolean(patch.clearImage),
  });
  if (patch.url === undefined && !patch.clearImage) {
    delete body.url;
    delete body.r2_key;
  }
  if (patch.mime === undefined && !patch.clearImage && prev?.mime) body.mime = prev.mime;
  if (patch.clearImage) {
    body.mime = null;
    body.url = null;
    body.r2_key = null;
    body.image_base64 = null;
    body.meta = { ...(prev?.meta || {}), has_image: false };
  }
  if (patch.url) {
    body.meta = { ...(body.meta || {}), has_image: true, r2_key: patch.r2_key || body.r2_key };
    body.image_base64 = null;
  }

  const result = await supabaseRequest(env, 'companion_card_assets?on_conflict=companion_id,collection,card_id', {
    method: 'POST',
    body,
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    timeoutMs: 60000,
  });
  if (!result.ok) {
    if (result.missingTable) {
      return { ok: false, message: '缺少 companion_card_assets 表，请在 Supabase 执行 sql/card-assets.sql' };
    }
    // 列 url/r2_key 可能尚未 migrate
    if (/url|r2_key|column/i.test(String(result.message || ''))) {
      return { ok: false, message: `${result.message}（若缺 url/r2_key 列，请再执行 sql/card-assets.sql）` };
    }
    return result;
  }
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { ok: true, entry: row, cardId: key, prev };
}

async function updateOutfitCard(env, companionId, cardId, { prompt } = {}) {
  if (prompt == null) return { ok: false, message: '没有可更新的字段' };
  const r = await upsertCardAsset(env, companionId, 'outfit', cardId, { prompt });
  if (!r.ok) return r;
  return { ok: true, cardId: r.cardId, entry: r.entry, message: '提示词已保存到 Supabase' };
}

async function uploadCardImageToR2AndDb(env, companionId, collection, cardId, body = {}) {
  try {
    const id = safeCompanionId(companionId) || 'default';
    const key = normalizeCardKey(cardId);
    if (!key) return { ok: false, message: '缺少卡片 ID' };
    const { mime, base64 } = validateImagePayload(body);
    const r2cfg = resolveR2Config(env);
    if (!r2cfg.canUpload) {
      return {
        ok: false,
        message: 'Cloudflare R2 未就绪：请 wrangler login，或在 .env 配置 CLOUDFLARE_API_TOKEN / R2_BUCKET / R2_PUBLIC_BASE',
      };
    }
    // 上传新图前读出旧 key，成功后删旧对象
    const existing = await supabaseRest(env, oneAssetPath(id, collection, key, { withImage: false }));
    const prev = existing.ok && existing.data?.[0] ? existing.data[0] : null;
    const oldKey = prev?.r2_key || prev?.meta?.r2_key || null;

    const up = await uploadBase64ToR2(base64, {
      mime,
      companionId: id,
      collection,
      cardId: key,
      env,
    });
    if (!up.ok) return up;

    const r = await upsertCardAsset(env, id, collection, key, {
      mime,
      url: up.url,
      r2_key: up.key,
      meta: {
        name: String(body.name || cardId).slice(0, 160),
        has_image: true,
        r2_key: up.key,
        storage: 'r2',
      },
    });
    if (!r.ok) return r;

    if (oldKey && oldKey !== up.key) {
      await deleteFromR2(oldKey, env).catch(() => null);
    }

    return {
      ok: true,
      cardId: key,
      entry: r.entry,
      imageUrl: up.url,
      storage: 'r2',
      message: collection === 'album' ? '上身成片已上传到 Cloudflare R2' : '图片已上传到 Cloudflare R2',
    };
  } catch (error) {
    return { ok: false, message: error.message || '上传失败' };
  }
}

async function uploadOutfitCardImage(env, companionId, cardId, body = {}) {
  return uploadCardImageToR2AndDb(env, companionId, 'outfit', cardId, body);
}

async function deleteOutfitCardImage(env, companionId, cardId) {
  const id = safeCompanionId(companionId) || 'default';
  const key = normalizeCardKey(cardId);
  const existing = await supabaseRest(env, oneAssetPath(id, 'outfit', key, { withImage: false }));
  const prev = existing.ok && existing.data?.[0] ? existing.data[0] : null;
  const r2key = prev?.r2_key || prev?.meta?.r2_key;
  if (r2key) await deleteFromR2(r2key, env).catch(() => null);
  const r = await upsertCardAsset(env, companionId, 'outfit', cardId, { clearImage: true });
  if (!r.ok) return r;
  return { ok: true, message: '卡片图片已从 R2 / Supabase 清除' };
}

/** 兼容旧 base64 行；新图直接用 R2 公网 url，一般不走这里 */
async function serveCardMedia(env, companionId, collection, cardId, res) {
  const id = safeCompanionId(companionId) || 'default';
  const key = decodeURIComponent(String(cardId || ''));
  const r = await supabaseRest(env, oneAssetPath(id, collection, key, { withImage: true }));
  if (!r.ok) {
    json(res, r.missingTable ? 400 : 404, {
      ok: false,
      message: r.missingTable
        ? '缺少 companion_card_assets 表，请执行 sql/card-assets.sql'
        : (r.message || '没有这张图'),
    });
    return true;
  }
  const row = r.data?.[0];
  if (row?.url) {
    res.writeHead(302, { location: row.url, 'cache-control': 'private, max-age=60' });
    res.end();
    return true;
  }
  const decoded = decodeImageBase64({
    image_base64: row?.image_base64,
    mime: row?.mime,
  });
  if (!decoded) {
    json(res, 404, { ok: false, message: '没有这张图' });
    return true;
  }
  res.writeHead(200, {
    'content-type': decoded.mime,
    'content-length': decoded.buffer.length,
    'cache-control': 'private, max-age=3600',
  });
  res.end(decoded.buffer);
  return true;
}

// ---- 穿搭相册（上身效果 lookbook）· 资产在 Supabase ----

async function getAlbumCatalog(env, scope = {}) {
  const companionId = safeCompanionId(scope.companionId) || 'default';
  const raw = readCompanionOutfitRaw(companionId);
  const customRes = await supabaseRest(env, listCustomAlbumPath(companionId));
  const custom = customRes.ok ? (customRes.data || []) : [];
  if (!customRes.ok && customRes.missingTable) {
    // 表未建时仍返回造型卡，提示迁移
  }
  const catalog = buildAlbumCatalog(raw, custom);
  const assets = await loadCardAssetMap(env, companionId, 'album');
  let cards = attachAssetsToCards(catalog.cards, assets.map || {}, { companionId, collection: 'album' });

  // 今日日更成片置顶
  if (scope.userId) {
    const daily = await getDailyOutfit(env, { userId: scope.userId, companionId }).catch(() => null);
    if (daily?.ok && daily.dailyKey) {
      const cardId = daily.albumCardId || dailyAlbumCardId(daily.dailyKey);
      const asset = (assets.map || {})[cardId];
      const dailyCard = {
        id: cardId,
        kind: 'wearing',
        source: 'daily',
        lookId: daily.composedFrom?.lookId || daily.outfit?.current?.id || null,
        title: `今日穿搭 · ${daily.dailyKey}`,
        subtitle: 'daily lookbook',
        summary: daily.summary || '',
        context: daily.outfit?.context || 'home',
        season: null,
        style: '今日',
        pieces: daily.pieces || {},
        tags: ['今日', daily.outfit?.context, '日更'].filter(Boolean),
        defaultPrompt: '',
        prompt: asset?.prompt || '',
        promptMode: 'person_look',
        hasCustomPrompt: Boolean(asset?.prompt),
        imageUrl: daily.photo?.url || (asset?.file ? `/api/album/media/${encodeURIComponent(cardId)}/file?companionId=${encodeURIComponent(companionId)}` : null),
        hasImage: Boolean(daily.photo?.url || asset?.file || asset?.url),
        updatedAt: daily.photo?.at || asset?.updatedAt || null,
      };
      // 若 attach 已有同 id，替换并置顶
      cards = [dailyCard, ...cards.filter((c) => c.id !== cardId)];
    }
  }

  const withImage = cards.filter((c) => c.hasImage).length;
  return {
    ok: true,
    companionId,
    storage: 'supabase',
    assetsOk: assets.ok,
    assetsMessage: assets.ok ? null : assets.message,
    counts: {
      ...catalog.counts,
      withImage,
      pending: cards.length - withImage,
    },
    cards,
  };
}

async function updateAlbumCard(env, companionId, cardId, { prompt } = {}) {
  if (prompt == null) return { ok: false, message: '没有可更新的字段' };
  const r = await upsertCardAsset(env, companionId, 'album', cardId, { prompt });
  if (!r.ok) return r;
  return { ok: true, cardId: r.cardId, entry: r.entry, message: '提示词已保存到 Supabase' };
}

async function uploadAlbumCardImage(env, companionId, cardId, body = {}) {
  return uploadCardImageToR2AndDb(env, companionId, 'album', cardId, body);
}

async function deleteAlbumCardImage(env, companionId, cardId) {
  const id = safeCompanionId(companionId) || 'default';
  const key = normalizeCardKey(cardId);
  const existing = await supabaseRest(env, oneAssetPath(id, 'album', key, { withImage: false }));
  const prev = existing.ok && existing.data?.[0] ? existing.data[0] : null;
  const r2key = prev?.r2_key || prev?.meta?.r2_key;
  if (r2key) await deleteFromR2(r2key, env).catch(() => null);
  const r = await upsertCardAsset(env, companionId, 'album', cardId, { clearImage: true });
  if (!r.ok) return r;
  return { ok: true, message: '相册图片已从 R2 / Supabase 清除' };
}

async function createAlbumCustom(env, companionId, entry) {
  const id = safeCompanionId(companionId) || 'default';
  try {
    const body = upsertCustomAlbumBody(id, entry || {});
    const result = await supabaseRequest(env, 'album_custom_entries?on_conflict=companion_id,id', {
      method: 'POST',
      body,
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    });
    if (!result.ok) {
      if (result.missingTable) {
        return { ok: false, message: '缺少 album_custom_entries 表，请执行 sql/card-assets.sql' };
      }
      return result;
    }
    if (body.prompt) {
      await upsertCardAsset(env, id, 'album', `album:custom:${body.id}`, { prompt: body.prompt });
    }
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    return { ok: true, entry: row, message: '已加入相册（Supabase）' };
  } catch (error) {
    return { ok: false, message: error.message || '创建失败' };
  }
}

const EMPTY_COMPANION_PROFILE = normalizeCompanionProfile({});

function companionProfileFilePath(id) {
  return path.join(companionDirPath(id), 'profile.json');
}

function readCompanionProfile(companionId) {
  const id = safeCompanionId(companionId);
  if (!id) return { ok: false, message: '角色 ID 不合法' };
  const dirFile = companionProfileFilePath(id);
  const legacyFile = companionFilePath(id);
  try {
    let profile = {};
    if (fs.existsSync(dirFile)) {
      const raw = JSON.parse(fs.readFileSync(dirFile, 'utf8'));
      profile = raw?.profile ?? raw ?? {};
    } else if (fs.existsSync(legacyFile)) profile = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))?.profile ?? {};
    return { ok: true, profile: normalizeCompanionProfile(profile) };
  } catch (error) {
    return { ok: false, message: `角色档案读取失败: ${error.message}` };
  }
}

function maskProfileSecret(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  return raw.length <= 4 ? '••••' : `${'•'.repeat(Math.min(8, raw.length - 4))}${raw.slice(-4)}`;
}

function profileForClient(profile) {
  const normalized = normalizeCompanionProfile(profile);
  return {
    ...normalized,
    idCardNumber: '',
    passportNumber: '',
    idCardNumberMasked: maskProfileSecret(normalized.idCardNumber),
    passportNumberMasked: maskProfileSecret(normalized.passportNumber),
  };
}

function saveCompanionProfile(companionId, input = {}) {
  const id = safeCompanionId(companionId);
  if (!id) return { ok: false, message: '角色 ID 不合法' };
  const currentResult = readCompanionProfile(id);
  if (!currentResult.ok) return currentResult;
  try {
    const current = currentResult.profile;
    const next = normalizeCompanionProfile({
      ...current,
      ...input,
      idCardNumber: String(input.idCardNumber ?? '').trim() || current.idCardNumber,
      passportNumber: String(input.passportNumber ?? '').trim() || current.passportNumber,
    });
    const dir = companionDirPath(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(companionProfileFilePath(id), `${JSON.stringify({ profile: next }, null, 2)}\n`);
    return { ok: true, profile: profileForClient(next), message: '角色档案已保存；下次对话会读取新的背景设定' };
  } catch (error) {
    return { ok: false, message: `角色档案保存失败: ${error.message}` };
  }
}

/** 把显示名/ID 写回 persona 分片的 persona.name / meta.display_name / meta.id。 */
function patchPersonaIdentity(personaFilePath, name, id) {
  try {
    const json = JSON.parse(fs.readFileSync(personaFilePath, 'utf8'));
    json.persona = { ...(json.persona ?? {}), name };
    json.meta = { ...(json.meta ?? {}), id, display_name: name };
    fs.writeFileSync(personaFilePath, `${JSON.stringify(json, null, 2)}\n`);
  } catch {} // 分片格式不对就不硬改, 交给用户在编辑器里自己填名字
}

const NEW_COMPANION_TEMPLATE = (name) => ({
  meta: { id: '', display_name: name },
  persona: { name, personality: '', speech: [], likes: [], dislikes: [], background: '', values: '', address_user: '你', identity_constraints: [] },
});

/** 新建角色: 不传 cloneFrom 则只建一个空白 persona.json; 传了则克隆整份现有角色的人设文件。 */
function createCompanion({ companionId, name, cloneFrom } = {}) {
  const id = safeCompanionId(companionId);
  if (!id) return { ok: false, message: '角色 ID 只能是字母/数字/下划线/短横线' };
  if (companionExists(id)) return { ok: false, message: `角色 ${id} 已存在` };
  const displayName = String(name ?? '').trim() || id;

  if (cloneFrom) {
    const srcId = safeCompanionId(cloneFrom);
    if (!srcId || !companionExists(srcId)) return { ok: false, message: `找不到要克隆的角色 ${cloneFrom}` };
    const destDir = companionDirPath(id);
    const srcDir = companionDirPath(srcId);
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      fs.cpSync(srcDir, destDir, { recursive: true });
    } else {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(companionFilePath(srcId), path.join(destDir, 'persona.json'));
    }
    const personaFile = path.join(destDir, 'persona.json');
    if (fs.existsSync(personaFile)) patchPersonaIdentity(personaFile, displayName, id);
    return { ok: true, message: `已从 ${srcId} 克隆出角色 ${id} (${displayName}), 记得去人设页调整细节`, companionId: id };
  }

  const destDir = companionDirPath(id);
  fs.mkdirSync(destDir, { recursive: true });
  const template = NEW_COMPANION_TEMPLATE(displayName);
  template.meta.id = id;
  fs.writeFileSync(path.join(destDir, 'persona.json'), `${JSON.stringify(template, null, 2)}\n`);
  return { ok: true, message: `已创建角色 ${id} (${displayName})`, companionId: id };
}

/** 删除角色人设文件 (需要 confirm:true 二次确认)。只删文件, 数据库里的记忆/状态不受影响。 */
function deleteCompanion(companionId, { confirm } = {}) {
  const id = safeCompanionId(companionId);
  if (!id) return { ok: false, message: '角色 ID 不合法' };
  if (id === 'default') return { ok: false, message: 'default 是其它角色克隆的模板底稿, 不能删除' };
  if (!companionExists(id)) return { ok: false, message: `角色 ${id} 不存在` };
  if (!confirm) return { ok: false, message: '需要二次确认才会删除' };
  const dir = companionDirPath(id);
  const file = companionFilePath(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  return { ok: true, message: `已删除角色 ${id} 的人设文件 (该角色在数据库里的记忆/状态未受影响)` };
}

// ---------------------------------------------------------------
// 编排器试聊: 每条消息 spawn 一次 chat-runner (真实走完整管线, 会调 LLM + 写库)
// ---------------------------------------------------------------
function runChat({ message, userId, companionId, debug = false, stopIntimate = false, intimacyAllowed = true, stream = false, onEvent = null } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [path.join(__dirname, 'chat-runner.js'), JSON.stringify({
        message, userId, companionId, debug, stopIntimate, intimacyAllowed, stream: Boolean(stream),
      })],
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
    }, 180000);
    const handleLine = (line) => {
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        if (stream && typeof onEvent === 'function' && parsed?.event) {
          onEvent(parsed);
        }
        // 非流式：第一条带 ok 的就是结果；流式：event=done 且 ok 为结果
        if (parsed && typeof parsed.ok === 'boolean') {
          if (!stream || parsed.event === 'done' || !parsed.event) {
            clearTimeout(timer);
            finish(parsed);
          }
        }
      } catch { /* 杂散日志 */ }
    };
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        handleLine(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      err += chunk;
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      if (!settled && out.trim()) handleLine(out.trim());
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
// 消息渠道子进程管理
// ---------------------------------------------------------------
const bot = { procs: new Map(), startedAt: null, logs: [], lastExit: null };

function pushLog(line) {
  const clean = String(line).replace(/\s+$/, '');
  if (!clean) return;
  bot.logs.push({ ts: Date.now(), line: clean });
  if (bot.logs.length > MAX_LOG_LINES) bot.logs.splice(0, bot.logs.length - MAX_LOG_LINES);
}

function startBot() {
  const externalPid = externalTelegramPid();
  if (externalPid) return { ok: false, message: `Telegram 由 launchd 后台托管中 (pid ${externalPid})` };
  if (bot.procs.size) return { ok: false, message: '渠道机器人已在运行' };
  const env = readEnvValues();
  const channels = [
    env.TELEGRAM_BOT_TOKEN && ['telegram', 'src/telegram/bot.js'],
    env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && ['feishu', 'src/feishu/bot.js'],
    env.DISCORD_BOT_TOKEN && ['discord', 'src/discord/bot.js'],
  ].filter(Boolean);
  if (!channels.length) return { ok: false, message: '请先至少配置一个消息渠道' };
  try { fs.rmSync(BOT_STATUS_FILE, { force: true }); } catch {}
  bot.startedAt = Date.now();
  bot.lastExit = null;
  for (const [name, entry] of channels) {
    const proc = spawn(process.execPath, [path.join(ROOT, entry)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, ...(name === 'telegram' ? { CYBER_UI_STATUS_FILE: BOT_STATUS_FILE } : {}) },
    });
    bot.procs.set(name, proc);
    pushLog(`[控制台] 启动 ${name} (pid ${proc.pid})`);
    const onData = (chunk) => String(chunk).split('\n').forEach((line) => pushLog(`[${name}] ${line}`));
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code, signal) => {
      bot.lastExit = { channel: name, code, signal, at: Date.now() };
      pushLog(`[控制台] ${name} 退出 (code=${code ?? ''} signal=${signal ?? ''})`);
      bot.procs.delete(name);
      if (!bot.procs.size) bot.startedAt = null;
    });
  }
  return { ok: true, message: `已启动 ${channels.map(([name]) => name).join('、')}` };
}

function stopBot() {
  const procs = [...bot.procs.values()];
  if (!procs.length) return { ok: false, message: '渠道机器人未运行' };
  pushLog('[控制台] 发送停止信号...');
  for (const proc of procs) proc.kill('SIGTERM');
  setTimeout(() => {
    for (const proc of procs) if ([...bot.procs.values()].includes(proc)) proc.kill('SIGKILL');
  }, 5000).unref();
  return { ok: true, message: '已发送停止信号' };
}

function botStatus() {
  const externalPid = externalTelegramPid();
  let runtime = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(BOT_STATUS_FILE, 'utf8'));
    const ageMs = Date.now() - new Date(parsed.updatedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs < 60000) runtime = parsed;
  } catch {}
  return {
    running: bot.procs.size > 0 || Boolean(externalPid),
    pid: [...bot.procs.values()][0]?.pid ?? externalPid ?? null,
    managedBy: externalPid && !bot.procs.size ? 'launchd' : 'console',
    channels: {
      ...Object.fromEntries([...bot.procs].map(([name, proc]) => [name, { running: true, pid: proc.pid }])),
      ...(externalPid && !bot.procs.has('telegram') ? { telegram: { running: true, pid: externalPid, managedBy: 'launchd' } } : {}),
    },
    startedAt: bot.startedAt,
    lastExit: bot.lastExit,
    logs: bot.logs.slice(-200),
    runtime,
  };
}

function externalTelegramPid() {
  const lock = path.join(ROOT, '.telegram-bot.lock');
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
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
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const maxBytes = bodyLimitForPath(pathname);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error(`body too large (max ${maxBytes} bytes)`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function bodyLimitForPath(pathname = '') {
  return /\/api\/(image-references|images|import|outfit|album)/.test(String(pathname)) ? 20_000_000 : 1_000_000;
}

export function isAllowedHost(value = '') {
  const raw = String(value);
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

export function isAuthorized(headers = {}, token = '') {
  if (!token) return true;
  return String(headers.authorization || '').replace(/^Bearer\s+/i, '') === token;
}

// 供单测：产品策略读写与门控
export {
  readProductPolicy,
  writeProductPolicy,
  checkMessageSafety,
  checkQuota,
  canWriteAction,
  normalizeSafetyPolicy,
  normalizeQuota,
  DEFAULT_SAFETY_POLICY,
  DEFAULT_QUOTA,
};

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;
  if (!isAllowedHost(req.headers.host)) return json(res, 403, { ok: false, message: 'invalid host' });
  const adminToken = readEnvValues().UI_ADMIN_TOKEN || process.env.UI_ADMIN_TOKEN || '';
  if (url.pathname.startsWith('/api/') && !isAuthorized(req.headers, adminToken)) {
    return json(res, 401, { ok: false, message: '需要管理控制台 Token' });
  }

  if (route === 'GET /' || route === 'GET /index.html') {
    if (!fs.existsSync(HTML_FILE)) return json(res, 503, { ok: false, message: '管理界面尚未构建，请先运行 npm run ui:build' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(HTML_FILE));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const file = path.join(DIST_DIR, 'assets', path.basename(url.pathname));
    if (!fs.existsSync(file)) return json(res, 404, { ok: false, message: '资源不存在' });
    const ext = path.extname(file);
    const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (route === 'GET /api/config') return json(res, 200, configPayload());
  if (route === 'PUT /api/config') {
    const body = await readBody(req);
    const savedKeys = saveConfig(body?.values ?? {});
    return json(res, 200, { ok: true, savedKeys, message: savedKeys.length ? `已保存 ${savedKeys.length} 项到 .env` : '没有需要保存的改动' });
  }
  if (route === 'GET /api/mcp') {
    const env = readEnvValues();
    return json(res, 200, {
      ok: true,
      items: listMcpCatalog({ env }),
      paths: clientConfigPaths(),
      message: 'MCP 快捷连接目录',
    });
  }
  if (route === 'POST /api/mcp/install') {
    const body = await readBody(req);
    const env = readEnvValues();
    const result = installMcpToClient(body?.id, body?.client || 'grok', {
      confirm: Boolean(body?.confirm),
      env,
    });
    return json(res, result.ok ? 200 : 400, result);
  }
  if (route === 'POST /api/mcp/uninstall') {
    const body = await readBody(req);
    const result = uninstallMcpFromClient(body?.id, body?.client || 'grok', {
      confirm: Boolean(body?.confirm),
    });
    return json(res, result.ok ? 200 : 400, result);
  }
  if (route === 'POST /api/mcp/snippet') {
    const body = await readBody(req);
    const entry = MCP_CATALOG.find((x) => x.id === body?.id);
    if (!entry) return json(res, 400, { ok: false, message: '未知 MCP' });
    return json(res, 200, {
      ok: true,
      id: entry.id,
      client: body?.client || 'claude',
      snippet: buildClientSnippet(entry, body?.client || 'claude', { env: readEnvValues() }),
    });
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
  if (route === 'GET /api/companion-v2') {
    try { return json(res, 200, await getCompanionUpgrade(readEnvValues(), Object.fromEntries(url.searchParams))); }
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
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/gallery/')) {
    const result = await deleteGalleryAsset(readEnvValues(), url.pathname.slice('/api/gallery/'.length), Object.fromEntries(url.searchParams));
    return json(res, result.ok ? 200 : 404, result);
  }
  if (route === 'GET /api/image-references') {
    const scope = Object.fromEntries(url.searchParams);
    return json(res, 200, { ok: true, items: listReferenceImages(scope.userId, scope.companionId || 'default').map(publicReference) });
  }
  if (route === 'POST /api/image-references') {
    const body = await readBody(req);
    if (!body?.scope?.userId) return json(res, 400, { ok: false, message: '请先选择用户和角色' });
    const item = saveReferenceImage({ ...body, ...body.scope });
    return json(res, 200, { ok: true, item: publicReference(item), message: '参考图已保存' });
  }
  if (req.method === 'GET' && /^\/api\/image-references\/[^/]+\/file$/.test(url.pathname)) {
    const item = readReferenceById(url.pathname.split('/')[3]);
    if (!item) return json(res, 404, { ok: false, message: '图片不存在' });
    res.writeHead(200, { 'content-type': item.mime, 'content-length': item.bytes, 'cache-control': 'private, max-age=3600' });
    fs.createReadStream(referenceFilePath(item)).pipe(res);
    return;
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/image-references/')) {
    const scope = Object.fromEntries(url.searchParams);
    const ok = deleteReferenceImage(url.pathname.slice('/api/image-references/'.length), scope.userId, scope.companionId || 'default');
    return json(res, ok ? 200 : 404, { ok, message: ok ? '参考图已删除' : '参考图不存在' });
  }
  if (req.method === 'PATCH' && /^\/api\/image-references\/[^/]+\/avatar$/.test(url.pathname)) {
    const body = await readBody(req);
    const id = url.pathname.split('/')[3];
    const item = setReferenceAvatar(id, body?.scope?.userId, body?.scope?.companionId || 'default');
    return json(res, item ? 200 : 404, { ok: Boolean(item), item: item ? publicReference(item) : null, message: item ? '角色头像已更新' : '参考图不存在' });
  }
  if (route === 'POST /api/images/generate') {
    const body = await readBody(req);
    try { return json(res, 200, await generateUiImage(readEnvValues(), body.scope || {}, body)); }
    catch (error) { return json(res, 200, { ok: false, message: describeNetworkError(error) }); }
  }
  if (route === 'GET /api/params') return json(res, 200, paramPayload());
  if (route === 'PUT /api/params') return json(res, 200, saveParams((await readBody(req)).values ?? {}));
  if (route === 'DELETE /api/params') return json(res, 200, resetParams());
  if (route === 'POST /api/actions') {
    const body = await readBody(req);
    return json(res, 200, await runAction({ ...(body.scope ?? {}), ...body }));
  }
  if (route === 'GET /api/export') return json(res, 200, await exportScope(readEnvValues(), Object.fromEntries(url.searchParams)));
  if (route === 'POST /api/import') return json(res, 200, await importScope(readEnvValues(), await readBody(req)));
  // P2 产品：生活时间线 / 安全 / 配额 / 删除
  if (route === 'GET /api/product/life') {
    return json(res, 200, await getProductLife(readEnvValues(), Object.fromEntries(url.searchParams)));
  }
  if (route === 'GET /api/product/safety') {
    const p = readProductPolicy();
    return json(res, 200, { ok: true, safety: p.safety, updatedAt: p.updatedAt });
  }
  if (route === 'PUT /api/product/safety') {
    const body = await readBody(req);
    const next = writeProductPolicy({ safety: body?.safety ?? body });
    return json(res, 200, { ok: true, safety: next.safety, updatedAt: next.updatedAt, message: '安全策略已保存' });
  }
  if (route === 'GET /api/product/quota') {
    return json(res, 200, await getProductQuota(readEnvValues(), Object.fromEntries(url.searchParams)));
  }
  if (route === 'PUT /api/product/quota') {
    const body = await readBody(req);
    const next = writeProductPolicy({ quota: body?.quota ?? body });
    return json(res, 200, { ok: true, quota: next.quota, updatedAt: next.updatedAt, message: '配额已保存' });
  }
  if (route === 'POST /api/product/safety/check') {
    const body = await readBody(req);
    const safety = readProductPolicy().safety;
    return json(res, 200, { ok: true, ...checkMessageSafety(body?.text || '', safety) });
  }
  if (route === 'POST /api/product/delete') {
    const body = await readBody(req);
    return json(res, 200, await deleteScopeData(readEnvValues(), {
      userId: body?.userId || url.searchParams.get('userId'),
      companionId: body?.companionId || url.searchParams.get('companionId') || 'default',
    }, { confirm: body?.confirm }));
  }
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
  if (route === 'GET /api/companions') return json(res, 200, { ok: true, companions: listCompanions() });
  if (route === 'POST /api/companions') {
    const body = await readBody(req);
    return json(res, 200, createCompanion(body ?? {}));
  }
  if (route === 'DELETE /api/companions') {
    const body = await readBody(req);
    return json(res, 200, deleteCompanion(body?.companionId, { confirm: Boolean(body?.confirm) }));
  }
  if (route === 'GET /api/companion-profile') {
    const result = readCompanionProfile(url.searchParams.get('companionId') || 'default');
    return json(res, result.ok ? 200 : 400, result.ok ? { ok: true, profile: profileForClient(result.profile) } : result);
  }
  if (route === 'PUT /api/companion-profile') {
    const body = await readBody(req);
    return json(res, 200, saveCompanionProfile(body?.companionId || 'default', body?.profile ?? {}));
  }
  if (route === 'GET /api/companion-section') {
    const result = readCompanionSection(url.searchParams.get('companionId') || 'default', url.searchParams.get('section') || '');
    return json(res, result.ok ? 200 : 400, result);
  }
  if (route === 'PUT /api/companion-section') {
    const body = await readBody(req);
    const result = saveCompanionSection(body?.companionId || 'default', body?.section || '', body?.data ?? {});
    return json(res, result.ok ? 200 : 400, result);
  }
  if (route === 'GET /api/outfit') {
    return json(res, 200, await getOutfitCatalog(readEnvValues(), Object.fromEntries(url.searchParams)));
  }
  if (route === 'POST /api/outfit/wear') {
    const body = await readBody(req);
    const scope = body?.scope || { userId: body?.userId, companionId: body?.companionId || 'default' };
    return json(res, 200, await wearOutfitLook(readEnvValues(), scope, body?.lookId));
  }
  if (route === 'GET /api/outfit/daily') {
    const scope = {
      userId: url.searchParams.get('userId') || '',
      companionId: url.searchParams.get('companionId') || 'default',
    };
    return json(res, 200, await getDailyOutfit(readEnvValues(), scope));
  }
  if (route === 'POST /api/outfit/daily') {
    const body = await readBody(req);
    const scope = body?.scope || { userId: body?.userId, companionId: body?.companionId || 'default' };
    try {
      return json(res, 200, await recomposeDailyOutfit(readEnvValues(), scope));
    } catch (error) {
      return json(res, 200, { ok: false, message: error.message || '重组失败' });
    }
  }
  if (route === 'POST /api/outfit/daily/photo') {
    const body = await readBody(req);
    const scope = body?.scope || { userId: body?.userId, companionId: body?.companionId || 'default' };
    // 生图 1～3 分钟常见；错误已在 generateDailyOutfitPhoto 内消化
    return json(res, 200, await generateDailyOutfitPhoto(readEnvValues(), scope, { force: Boolean(body?.force) }));
  }
  if (route === 'PUT /api/outfit/card') {
    const body = await readBody(req);
    const companionId = body?.companionId || body?.scope?.companionId || 'default';
    return json(res, 200, await updateOutfitCard(readEnvValues(), companionId, body?.cardId, { prompt: body?.prompt }));
  }
  if (route === 'POST /api/outfit/card/image') {
    const body = await readBody(req);
    const companionId = body?.companionId || body?.scope?.companionId || 'default';
    return json(res, 200, await uploadOutfitCardImage(readEnvValues(), companionId, body?.cardId, body));
  }
  if (route === 'DELETE /api/outfit/card/image') {
    const body = await readBody(req);
    const companionId = body?.companionId || body?.scope?.companionId || url.searchParams.get('companionId') || 'default';
    const cardId = body?.cardId || url.searchParams.get('cardId');
    return json(res, 200, await deleteOutfitCardImage(readEnvValues(), companionId, cardId));
  }
  if (req.method === 'GET' && /^\/api\/outfit\/media\/.+\/file$/.test(url.pathname)) {
    const parts = url.pathname.split('/');
    const cardId = parts[4];
    const companionId = url.searchParams.get('companionId') || 'default';
    return serveCardMedia(readEnvValues(), companionId, 'outfit', cardId, res);
  }
  if (route === 'GET /api/album') {
    return json(res, 200, await getAlbumCatalog(readEnvValues(), Object.fromEntries(url.searchParams)));
  }
  if (route === 'PUT /api/album/card') {
    const body = await readBody(req);
    const companionId = body?.companionId || body?.scope?.companionId || 'default';
    return json(res, 200, await updateAlbumCard(readEnvValues(), companionId, body?.cardId, { prompt: body?.prompt }));
  }
  if (route === 'POST /api/album/card/image') {
    const body = await readBody(req);
    const companionId = body?.companionId || body?.scope?.companionId || 'default';
    return json(res, 200, await uploadAlbumCardImage(readEnvValues(), companionId, body?.cardId, body));
  }
  if (route === 'DELETE /api/album/card/image') {
    const body = await readBody(req);
    const companionId = body?.companionId || body?.scope?.companionId || url.searchParams.get('companionId') || 'default';
    const cardId = body?.cardId || url.searchParams.get('cardId');
    return json(res, 200, await deleteAlbumCardImage(readEnvValues(), companionId, cardId));
  }
  if (route === 'POST /api/album/custom') {
    const body = await readBody(req);
    const companionId = body?.companionId || body?.scope?.companionId || 'default';
    return json(res, 200, await createAlbumCustom(readEnvValues(), companionId, body));
  }
  if (req.method === 'GET' && /^\/api\/album\/media\/.+\/file$/.test(url.pathname)) {
    const parts = url.pathname.split('/');
    const cardId = parts[4];
    const companionId = url.searchParams.get('companionId') || 'default';
    return serveCardMedia(readEnvValues(), companionId, 'album', cardId, res);
  }
  if (route === 'POST /api/chat' || route === 'POST /api/chat/stream') {
    const body = await readBody(req);
    const message = String(body?.message ?? '').trim();
    if (!message) return json(res, 200, { ok: false, message: '消息为空' });
    const env = readEnvValues();
    const userId = String(body?.userId || 'ui:playground');
    const companionId = String(body?.companionId || env.TELEGRAM_COMPANION_ID || 'default');
    const wantStream = route === 'POST /api/chat/stream' || Boolean(body?.stream);
    // 与 Telegram/飞书同一套 gate（安全+配额+身份+审计+账单计数）
    const gate = gateIncomingMessage({
      text: message,
      userId,
      companionId,
      channel: 'ui',
    });
    if (!gate.allow) {
      if (wantStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ event: 'done', ok: false, message: gate.replyText || '消息未发送', blocked: true })}\n\n`);
        res.end();
        return;
      }
      return json(res, 200, {
        ok: false,
        blocked: !gate.safety?.ok,
        quotaExceeded: gate.reasons?.some((r) => String(r).includes('limit') || String(r).includes('cap')),
        message: gate.replyText || '消息未发送',
        safety: gate.safety,
        quota: gate.quota,
        reasons: gate.reasons,
      });
    }

    if (wantStream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let doneSent = false;
      const result = await runChat({
        message,
        userId,
        companionId,
        debug: Boolean(body?.debug),
        stopIntimate: gate.stopIntimate,
        intimacyAllowed: gate.intimacyAllowed,
        stream: true,
        onEvent: (ev) => {
          try {
            const payload =
              ev.event === 'done'
                ? {
                    ...ev,
                    safety: { stopIntimate: gate.stopIntimate, intimacyAllowed: gate.intimacyAllowed },
                  }
                : ev;
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            if (ev.event === 'done') doneSent = true;
          } catch { /* client gone */ }
        },
      });
      // runner 异常退出时补一条 done
      if (!doneSent && result) {
        try {
          res.write(`data: ${JSON.stringify({
            event: 'done',
            ...result,
            safety: { stopIntimate: gate.stopIntimate, intimacyAllowed: gate.intimacyAllowed },
          })}\n\n`);
        } catch { /* */ }
      }
      res.end();
      return;
    }

    const result = await runChat({
      message,
      userId,
      companionId,
      debug: Boolean(body?.debug),
      stopIntimate: gate.stopIntimate,
      intimacyAllowed: gate.intimacyAllowed,
    });
    return json(res, 200, {
      ...result,
      safety: { stopIntimate: gate.stopIntimate, intimacyAllowed: gate.intimacyAllowed },
    });
  }
  if (route === 'GET /api/product/audit') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    return json(res, 200, { ok: true, entries: readAuditTail({ limit }) });
  }
  if (route === 'GET /api/product/billing') {
    const scope = Object.fromEntries(url.searchParams);
    if (!scope.userId) return json(res, 200, { ok: false, message: '需要 userId' });
    const usage = getTenantUsage(scope.userId, scope.companionId || 'default');
    const summary = buildBillingSummary(scope.userId, scope.companionId || 'default');
    return json(res, 200, { ok: true, usage, summary, scope });
  }
  if (route === 'GET /api/product/identity') {
    const userId = url.searchParams.get('userId');
    return json(res, 200, { ok: true, identity: getIdentity(userId), userId });
  }
  if (route === 'POST /api/product/identity/affirm') {
    const body = await readBody(req);
    const userId = String(body?.userId || '');
    if (!userId) return json(res, 200, { ok: false, message: '需要 userId' });
    const identity = affirmAdult(userId, { method: body?.method || 'self_declare' });
    appendAudit({ action: 'identity_affirm', channel: 'ui', userId, ok: true, detail: { method: identity.method } });
    return json(res, 200, { ok: true, identity, message: '已记录成年声明' });
  }
  if (route === 'POST /api/product/identity/revoke') {
    const body = await readBody(req);
    const userId = String(body?.userId || '');
    if (!userId) return json(res, 200, { ok: false, message: '需要 userId' });
    const identity = revokeAdult(userId);
    appendAudit({ action: 'identity_revoke', channel: 'ui', userId, ok: true });
    return json(res, 200, { ok: true, identity });
  }
  if (route === 'POST /api/product/album-quote') {
    const body = await readBody(req);
    const text = buildAlbumQuoteMessage(body?.card || body || {});
    return json(res, 200, { ok: true, text, message: '已生成相册引用文案' });
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
      if (!res.headersSent) json(res, error?.statusCode || 500, { ok: false, message: error?.message || 'internal error' });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`[ui] Cyber Memory 控制台: http://${HOST}:${PORT}  (仅本机可访问)`);
  });
  const shutdown = () => {
    for (const proc of bot.procs.values()) proc.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
