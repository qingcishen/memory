import dotenv from 'dotenv';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'undici';
import { Orchestrator, ProactiveScheduler, SupabaseRateLimitStore, LocalJsonHistoryStore, SupabaseHistoryStore } from '../../index.js';
import { loadPersonaConfig } from '../companion.js';
import { CompanionRuntime } from '../runtime/index.js';
import { metricsSnapshot } from '../metrics.js';
import { enqueue, queueStats, Worker } from '../queue/jobs.js';
import { makeScheduleActivityFn, parseSleepWindow } from '../state/activity.js';
import { WeatherProvider } from '../world/weather.js';
import { WorldDimension } from '../world/index.js';
import { SceneClassifier } from '../narration.js';
import { pickSpeakableText, shouldReplyWithVoice, synthesizeSpeech } from '../modal/speech.js';
import { TTS_CONFIGURED } from '../config.js';
import { BehaviorStateStore, normalizeBehaviorState } from '../state/behavior.js';
import { gateIncomingMessage } from '../product/gate.js';

dotenv.config();

const TELEGRAM_PROXY_URL = process.env.TELEGRAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const telegramHttpsAgent = TELEGRAM_PROXY_URL ? new HttpsProxyAgent(TELEGRAM_PROXY_URL) : undefined;
const telegramFetchDispatcher = TELEGRAM_PROXY_URL ? new ProxyAgent(TELEGRAM_PROXY_URL) : undefined;

const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_RETRY_MS = 3000;
const MAX_RETRY_MS = 60000;
const DEFAULT_IDLE_LOG_MS = 60000;
const DEFAULT_REPLY_TIMEOUT_MS = 90000;
const MAX_TELEGRAM_MESSAGE_LENGTH = 3900;
const DEFAULT_LOCK_FILE = '.telegram-bot.lock';

export function parseAllowedChatIds(value) {
  if (!value) return new Set();
  return new Set(
    String(value)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isAllowedChat(chatId, allowedChatIds) {
  return allowedChatIds.size === 0 || allowedChatIds.has(String(chatId));
}

export function telegramUserId(chatId) {
  return `telegram:${chatId}`;
}

/** 连续第 n 次轮询失败该等多久 (指数退避, 有上限)。n 从 1 起。纯函数, 代理/网络抖动时别把日志和连接刷爆。 */
export function pollRetryDelayMs(consecutiveErrors, { base = DEFAULT_RETRY_MS, cap = MAX_RETRY_MS } = {}) {
  const n = Math.max(1, consecutiveErrors);
  return Math.min(cap, base * Math.pow(2, n - 1));
}

export function chunkMessage(text, limit = MAX_TELEGRAM_MESSAGE_LENGTH) {
  const src = String(text ?? '').trim();
  if (!src) return ['...']; // 空回复也要发出点什么, 别悄无声息地什么都不发
  const chunks = [];
  let i = 0;
  while (i < src.length) {
    let end = Math.min(i + limit, src.length);
    // 切点落在代理对中间会劈出两个非法半字符 (emoji 变乱码, Telegram 可能整条拒收), 往前挪一位
    if (end < src.length && isHighSurrogate(src.charCodeAt(end - 1))) end -= 1;
    chunks.push(src.slice(i, end));
    i = end;
  }
  return chunks;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * parts (来自 Orchestrator.reply()/proactiveTick()) -> 实际要发的一组消息, 按顺序、每条独立发送。
 * dialogue part 过一遍 stripNarration 兜底(防止偶尔有旁白残留混进台词); narration part 是独立字段,
 * 原样发, 不再需要从文字里抠。超长的单条 part 仍按 chunkMessage 拆分。纯函数, 不发消息。
 */
export function buildOutgoingMessages(parts = []) {
  const out = [];
  for (const p of parts ?? []) {
    const type = p?.type === 'narration' ? 'narration' : 'dialogue';
    const cleaned = type === 'narration' ? String(p?.text ?? '').trim() : stripNarration(String(p?.text ?? ''));
    if (!cleaned) continue;
    for (const chunk of chunkMessage(cleaned)) out.push({ type, text: chunk });
  }
  return out;
}

export function ensureReplyParts(reply, parts) {
  if (Array.isArray(parts) && parts.length > 0) return parts;
  const text = String(reply ?? '').trim();
  return text ? [{ type: 'dialogue', text }] : [];
}

/** 按文字长度估一个"打字用了多久"的延迟, 让连续发消息不是瞬间刷屏。纯函数。 */
export function typingDelayMs(text = '') {
  return Math.min(1200, Math.max(600, String(text ?? '').length * 12));
}

/**
 * 把 parts 拆成「像真人连发」的多条气泡：旁白单独一条，长台词按句号拆 2～3 条。
 * TELEGRAM_MERGE_MESSAGES=1 时退回整段合并（旧行为）。
 */
export function buildHumanOutgoingMessages(parts = [], { maxDialogueBubbles = 3, minSplitLen = 28 } = {}) {
  if (process.env.TELEGRAM_MERGE_MESSAGES === '1' || process.env.TELEGRAM_MERGE_MESSAGES === 'true') {
    return buildMergedOutgoingMessages(parts);
  }
  const out = [];
  for (const p of parts || []) {
    const text = String(p?.text || '').trim();
    if (!text) continue;
    if (p.type === 'narration') {
      out.push({ type: 'narration', text });
      continue;
    }
    const bubbles = splitDialogueBubbles(text, maxDialogueBubbles, minSplitLen);
    for (const b of bubbles) out.push({ type: 'dialogue', text: b });
  }
  if (!out.length) return buildMergedOutgoingMessages(parts);
  // 超长仍按 Telegram 限制切块
  return out.flatMap((msg) =>
    chunkMessage(msg.text)
      .filter(Boolean)
      .map((text) => ({ type: msg.type, text })),
  );
}

/** 按中文/英文句号等拆成最多 max 条，短句不拆。 */
export function splitDialogueBubbles(text = '', max = 3, minSplitLen = 28) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (s.length < minSplitLen || max <= 1) return [s];
  // 先按换行，再按句末标点
  let pieces = s.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (pieces.length === 1) {
    pieces = s.split(/(?<=[。！？!?…])\s*/).map((x) => x.trim()).filter(Boolean);
  }
  if (pieces.length <= 1) return [s];
  if (pieces.length <= max) return pieces;
  // 合并到 max 条
  const out = [];
  const bucket = Math.ceil(pieces.length / max);
  for (let i = 0; i < pieces.length; i += bucket) {
    out.push(pieces.slice(i, i + bucket).join(''));
  }
  return out.slice(0, max);
}

export function pickPolicyDelay(policy = {}, rng = Math.random) {
  const [rawMin, rawMax] = Array.isArray(policy.replyDelayMs) ? policy.replyDelayMs : [0, 0];
  const min = Math.max(0, Number(rawMin) || 0);
  const max = Math.max(min, Number(rawMax) || 0);
  return Math.round(min + (max - min) * Math.min(1, Math.max(0, Number(rng()) || 0)));
}

/** partsBudget 只限制台词条数，旁白作为场景信息保留。 */
export function applyPartsBudget(parts = [], budget = Infinity) {
  const cap = Math.max(1, Math.floor(Number(budget) || 1));
  let dialogues = 0;
  return (parts ?? []).filter((part) => part?.type === 'narration' || ++dialogues <= cap);
}

export async function simulateBehaviorDelay(api, chatId, delayMs, sleepFn = sleep) {
  let remaining = Math.max(0, Number(delayMs) || 0);
  while (remaining > 0) {
    await api.sendChatAction(chatId, 'typing').catch(() => {});
    const typingFor = Math.min(2500, remaining);
    await sleepFn(typingFor);
    remaining -= typingFor;
    if (remaining > 0) {
      const pause = Math.min(1000, remaining);
      await sleepFn(pause); // typing 状态短暂停下，形成“打了又删”的感觉
      remaining -= pause;
    }
  }
}

/** 将所有旁白/台词合并成一条（超长时才按 Telegram 限制分块）。 */
export function buildMergedOutgoingMessages(parts = []) {
  const outgoing = buildOutgoingMessages(parts);
  return chunkMessage(outgoing.map((item) => item.text).join('\n\n'))
    .filter(Boolean)
    .map((text) => ({ type: 'merged', text }));
}

/** Telegram 的 typing 状态只保持几秒；模型生成期间定时续期，完成后由返回函数停止。 */
export function startTypingHeartbeat(
  api,
  chatId,
  { intervalMs = 4000, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {},
) {
  let stopped = false;
  const send = () => {
    if (!stopped) Promise.resolve(api.sendChatAction(chatId, 'typing')).catch(() => {});
  };
  send();
  const timer = setIntervalFn(send, intervalMs);
  timer?.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(timer);
  };
}

/** data URL -> { mime, buffer }; 不是合法 base64 data URL 返回 null。纯函数。
 *  GPT Image 系列只回 base64 (没有公网 URL), 走 multipart 上传 Telegram 时用。 */
export function parseDataUrl(url = '') {
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(url ?? '').trim());
  if (!m) return null;
  try {
    const buffer = Buffer.from(m[2], 'base64');
    return buffer.length > 0 ? { mime: m[1].toLowerCase(), buffer } : null;
  } catch {
    return null;
  }
}

class TelegramApi {
  constructor(token) {
    if (!token) throw new Error('缺少 TELEGRAM_BOT_TOKEN');
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  async call(method, body = {}) {
    const { statusCode, statusMessage, data } = await postJson(`${this.baseUrl}/${method}`, body);
    if (statusCode < 200 || statusCode >= 300 || !data?.ok) {
      const description = data?.description || `${statusCode} ${statusMessage}`;
      throw new Error(`Telegram ${method} failed: ${description}`);
    }
    return data.result;
  }

  getMe() {
    return this.call('getMe');
  }

  getUpdates(params) {
    return this.call('getUpdates', params);
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...extra,
    });
  }

  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  sendPhoto(chatId, photo, extra = {}) {
    return this.call('sendPhoto', { chat_id: chatId, photo, ...extra });
  }

  /** 图片二进制上传 (multipart)。GPT Image 只回 base64、没有公网 URL 时走这条。 */
  async sendPhotoUpload(chatId, buffer, { mime = 'image/png', ...extra } = {}) {
    const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([buffer], { type: mime }), `photo.${ext}`);
    for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
    const res = await telegramFetch(`${this.baseUrl}/sendPhoto`, { method: 'POST', body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(`Telegram sendPhoto upload failed: ${data?.description || `HTTP ${res.status}`}`);
    return data.result;
  }

  /** 语音条上传 (multipart, 与 postJson 的纯 JSON 通道分开)。buffer 需为 ogg/opus。 */
  async sendVoice(chatId, buffer, extra = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('voice', new Blob([buffer], { type: 'audio/ogg' }), 'voice.ogg');
    for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
    const res = await telegramFetch(`${this.baseUrl}/sendVoice`, { method: 'POST', body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(`Telegram sendVoice failed: ${data?.description || `HTTP ${res.status}`}`);
    return data.result;
  }

  getFile(fileId) {
    return this.call('getFile', { file_id: fileId });
  }

  async fileUrl(fileId) {
    const info = await this.getFile(fileId);
    if (!info?.file_path) throw new Error('Telegram getFile 没有返回 file_path');
    return `${this.fileBaseUrl}/${info.file_path}`;
  }

  async downloadAsFile(fileId, { name = 'voice.ogg', type = 'audio/ogg' } = {}) {
    const url = await this.fileUrl(fileId);
    const res = await telegramFetch(url);
    if (!res.ok) throw new Error(`Telegram 文件下载失败: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    return new File([bytes], name, { type });
  }

  async downloadDataUrl(fileId, type = 'image/jpeg') {
    const url = await this.fileUrl(fileId);
    const res = await telegramFetch(url);
    if (!res.ok) throw new Error(`Telegram 文件下载失败: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${bytes.toString('base64')}`;
  }
}

export class TelegramMemoryBot {
  constructor({
    token = process.env.TELEGRAM_BOT_TOKEN,
    allowedChatIds = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_ALLOWED_CHAT_ID),
    companionId = process.env.TELEGRAM_COMPANION_ID || 'default',
    companionName = process.env.TELEGRAM_COMPANION_NAME || '小忆',
    subjectName = process.env.TELEGRAM_SUBJECT_NAME || '你',
    pollTimeoutSeconds = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || DEFAULT_POLL_TIMEOUT_SECONDS),
    idleLogMs = Number(process.env.TELEGRAM_IDLE_LOG_MS || DEFAULT_IDLE_LOG_MS),
    replyTimeoutMs = Number(process.env.TELEGRAM_REPLY_TIMEOUT_MS || DEFAULT_REPLY_TIMEOUT_MS),
    // 富人设文件 (性格/说话风格/外貌/背景), 经 loadPersonaConfig 映射成 CompanionConfig 注入 Orchestrator。
    // 默认 companions/<companionId>.json; 缺失则只用名字 (退化为通用人设)。
    personaFile = process.env.TELEGRAM_PERSONA_FILE || `companions/${companionId}.json`,
    api = new TelegramApi(token),
    behaviorStore = new BehaviorStateStore(),
    sleepFn = sleep,
    rng = Math.random,
  } = {}) {
    this.api = api;
    this.behaviorStore = behaviorStore;
    this.sleepFn = sleepFn;
    this.rng = rng;
    this.allowedChatIds = allowedChatIds;
    this.companionId = companionId;
    this.companionName = companionName;
    this.subjectName = subjectName;
    this.persona = loadPersonaConfig(personaFile);
    if (this.persona) console.log(`[telegram] persona loaded: ${this.persona.config.name} (${personaFile})`);
    else console.log(`[telegram] no persona file at ${personaFile}, using plain name "${companionName}"`);
    // 短期对话历史持久化 (重启/多实例也能接上最近几轮); 所有 chat 共用一个 store, 按 userId 隔离。
    // 默认走 Supabase chat_history; TELEGRAM_HISTORY_STORE=local 可切回本地 JSON 兜底。
    this.historyStore = createHistoryStore();
    // 天气感知 (open-meteo, 无 key, 进程内缓存 30min); 所有 chat 共用 (同一地点)。WEATHER_* 可覆盖默认武汉。
    this.weather = new WeatherProvider({
      place: process.env.WEATHER_PLACE || '武汉',
      ...(process.env.WEATHER_LAT ? { lat: Number(process.env.WEATHER_LAT) } : {}),
      ...(process.env.WEATHER_LON ? { lon: Number(process.env.WEATHER_LON) } : {}),
    });
    // 旁白系统: 场景分类器无状态, 所有 chat 共用一个实例即可。
    this.narration = new SceneClassifier();
    this.pollTimeoutSeconds = pollTimeoutSeconds;
    this.idleLogMs = idleLogMs;
    this.replyTimeoutMs = replyTimeoutMs;
    this.lastIdleLogAt = 0;
    this.offset = 0;
    this.bots = new Map();
    this.runtimes = new Map();
    this.chatQueues = new Map();
    this.stopped = false;
    this.statusFile = process.env.CYBER_UI_STATUS_FILE || '';
    this.statusTimer = null;
    this.jobKind = 'telegram:after_reply';
    this.worker = new Worker({ handlers: {
      [this.jobKind]: ({ chatId, userMessage, reply }) => this.botForChat(chatId).runAfterReply(userMessage, reply),
    } });
    // 主动性策略: 安静时段 + 冷却 + 每日上限 (东八区)。
    this.proactivePolicy = {
      quietHours: { start: 23, end: 8 },
      minIntervalMinutes: 180,
      maxPerDay: 3,
      timezoneOffsetMinutes: 8 * 60,
    };
  }

  botForChat(chatId) {
    const key = String(chatId);
    if (!this.bots.has(key)) {
      const orchestrator = new Orchestrator({
        userId: telegramUserId(chatId),
        companionId: this.companionId,
        companionName: this.companionName,
        subjectName: this.subjectName,
        config: this.persona?.config ?? null, // 注入富人设 (性格/说话风格/外貌/背景)
        options: {
          ...(this.persona?.options ?? {}),
          useMonologue: process.env.TELEGRAM_USE_MONOLOGUE === 'true',
        },
        // 角色专属作息 (开会/健身...) 生成 activityFn; 没有则走通用作息模板
        activityFn: this.persona?.life ? makeScheduleActivityFn(this.persona.life) : null,
        // P2: 角色专属身体参数 (睡眠时段/发病概率), 喂给 LifeDimension
        lifeConfig: this.persona?.life ?? null,
        deps: {
          historyStore: this.historyStore,
          weather: this.weather,
          // 世界观系统: 按 (userId, companionId) 维护各自的背景剧情线, 因此每个 chat 一个实例。
          world: new WorldDimension({ userId: telegramUserId(chatId), companionId: this.companionId }),
          narration: this.narration,
          afterReplyEnqueue: ({ userMessage, reply }) => enqueue(
            telegramUserId(chatId), this.companionId, this.jobKind, { chatId: String(chatId), userMessage, reply },
          ),
          // Seedream 生成完成后直接投递到当前 Telegram 会话；data URL 无法走 JSON Bot API 时安全跳过。
          onPhoto: async ({ url, kind }) => {
            const raw = String(url ?? '');
            if (/^https?:\/\//i.test(raw)) {
              // Seedream 等返回公网 URL: 直接让 Telegram 拉取
              await this.api.sendPhoto(chatId, raw);
            } else {
              // GPT Image 系列只回 base64 data URL: 走 multipart 上传
              const parsed = parseDataUrl(raw);
              if (!parsed) {
                console.warn(`[telegram] generated ${kind || 'photo'} is neither public URL nor data URL, skipped delivery`);
                return;
              }
              await this.api.sendPhotoUpload(chatId, parsed.buffer, { mime: parsed.mime });
            }
            console.log(`[telegram] photo sent chat=${chatId} kind=${kind || 'photo'}`);
          },
        }, // 短期历史落库 + 真实天气 + 世界观 + 旁白
      });
      this.bots.set(key, orchestrator);
      this.startRuntime(chatId, orchestrator);
    }
    return this.bots.get(key);
  }

  /**
   * 把 Orchestrator.reply()/proactiveTick() 返回的 parts 依次发出去, 每条之间模拟一个打字延迟
   * (typingDelayMs), 让连续的旁白/多条台词读起来像真人在打字, 而不是瞬间刷屏。
   * 发送失败会抛出 (不在这里吞掉) —— 主动消息路径没人在等、可以整体 catch 掉忽略;
   * 用户主动发消息这条路径需要失败能冒泡到外层, 好触发"卡了一下"的兜底回复。
   */
  async sendParts(chatId, parts) {
    // 默认像真人连发：旁白 / 多句台词分多条 + typing 间隔；MERGE=1 可关
    const outgoing = buildHumanOutgoingMessages(parts);
    for (let i = 0; i < outgoing.length; i++) {
      const msg = outgoing[i];
      await this.api.sendChatAction(chatId, 'typing').catch(() => {});
      // 第二条起略加停顿，模拟「又打了一句」
      const delay = typingDelayMs(msg.text) + (i > 0 ? 280 + Math.floor(Math.random() * 420) : 0);
      await sleep(delay);
      await this.api.sendMessage(chatId, msg.text);
    }
    return outgoing;
  }

  /**
   * 语音进语音出: 对方刚发的是语音且配置了 TTS_MODEL 时, 台词合成一条语音条发回
   * (旁白仍走文字先行, 念第三人称描写很怪); 台词太长/合成失败都回退纯文字 sendParts。
   */
  async deliverReply(chatId, parts, { incomingVoice = false, policy = null, behaviorState = null, bot = null } = {}) {
    const userId = telegramUserId(chatId);
    const scope = { userId, companionId: this.companionId };
    const current = normalizeBehaviorState(behaviorState ?? await this.behaviorStore.load(scope).catch(() => ({})));
    const delay = Math.min(
      pickPolicyDelay(policy, this.rng),
      Math.max(0, Number(process.env.CHANNEL_MAX_REPLY_DELAY_MS || 3000) || 3000),
    );
    await simulateBehaviorDelay(this.api, chatId, delay, this.sleepFn);

    // stonewall 与 partsBudget 都只影响模型决策/提示，不影响已经生成的发送内容。
    const deliverableParts = parts ?? [];
    const speakable = pickSpeakableText(deliverableParts);
    if (shouldReplyWithVoice({ incomingVoice, configured: TTS_CONFIGURED, speakable })) {
      try {
        const audio = await synthesizeSpeech(speakable);
        const narrations = buildMergedOutgoingMessages((deliverableParts ?? []).filter((p) => p?.type === 'narration'));
        for (const msg of narrations) {
          await this.api.sendChatAction(chatId, 'typing').catch(() => {});
          await sleep(typingDelayMs(msg.text));
          await this.api.sendMessage(chatId, msg.text);
        }
        await this.api.sendChatAction(chatId, 'record_voice').catch(() => {});
        await sleep(typingDelayMs(speakable));
        await this.api.sendVoice(chatId, audio);
        console.log(`[telegram] voice reply chat=${chatId} chars=${speakable.length} bytes=${audio.length}`);
        const sent = [...narrations, { type: 'voice', text: speakable }];
        if (current.mustGiveRepairStep) await this.behaviorStore.save({ ...current, mustGiveRepairStep: false }, scope).catch(() => {});
        return sent;
      } catch (error) {
        console.error(`[telegram] tts failed chat=${chatId}, 回退文字:`, formatError(error));
      }
    }
    const sent = await this.sendParts(chatId, deliverableParts);
    if (current.mustGiveRepairStep) await this.behaviorStore.save({ ...current, mustGiveRepairStep: false }, scope).catch(() => {});
    return sent;
  }

  /** 给一个 chat 起后台"活着"循环: 维护(心情回落/作息/生病/夜间反思) + 主动消息(投递回这个 chat)。 */
  startRuntime(chatId, orchestrator) {
    const key = String(chatId);
    if (this.runtimes.has(key)) return;
    const proactiveScheduler = new ProactiveScheduler({
      orchestrator,
      stateStore: new SupabaseRateLimitStore(),
      policy: this.proactivePolicy,
      // 主动消息直接发回这个 chat; 没人在等这条消息, 发送失败就整体忽略, 不影响下次主动性 tick。
      deliver: async ({ message }) => {
        const sent = await this.sendParts(chatId, message.parts).catch(() => []);
        console.log(`[telegram] proactive sent chat=${chatId} chars=${message.text.length} parts=${sent.length}`);
      },
      // 到期的预期记忆 ("上次面试怎么样了") 作为主动由头
      getDueItems: () => orchestrator.memory.checkProspective?.({}).catch(() => []) ?? [],
      markFired: (ids) => orchestrator.memory.dismissProspective?.(ids).catch(() => {}),
      // P1 分级主动性: 角色专属睡眠时段(睡前道晚安) + 对方上次说话时间(沉默分级)
      sleepWindow: this.persona?.life?.sleep ? parseSleepWindow(this.persona.life.sleep) : null,
      getLastUserMessageAt: ({ userId, companionId }) => this.historyStore.lastUserMessageAt({ userId, companionId }),
    });
    const runtime = new CompanionRuntime({
      orchestrator,
      proactiveScheduler,
      options: { timezoneOffsetMinutes: 8 * 60 },
    });
    runtime.start();
    this.runtimes.set(key, runtime);
    console.log(`[telegram] runtime started chat=${chatId}`);
  }

  async start() {
    this.worker.start();
    const me = await this.api.getMe();
    console.log(`[telegram] @${me.username} started`);
    console.log(
      this.allowedChatIds.size > 0
        ? `[telegram] allowed chats: ${Array.from(this.allowedChatIds).join(', ')}`
        : '[telegram] allowed chats: all',
    );
    console.log('[telegram] waiting for messages...');
    this.startStatusReporter();
    let pollErrorStreak = 0;
    while (!this.stopped) {
      await this.pollOnce()
        .then(() => {
          pollErrorStreak = 0;
        })
        .catch(async (error) => {
          pollErrorStreak += 1;
          const delay = pollRetryDelayMs(pollErrorStreak);
          // 代理/网络抖动时连续报错很正常; 前几次照常打日志, 之后每 20 次才打一条, 避免日志文件被刷爆。
          if (pollErrorStreak <= 5 || pollErrorStreak % 20 === 0) {
            console.error(`[telegram] poll error (连续 ${pollErrorStreak} 次, ${delay}ms 后重试):`, formatError(error));
          }
          await sleep(delay);
        });
    }
  }

  stop() {
    this.stopped = true;
    this.worker.stop();
    for (const rt of this.runtimes.values()) rt.stop();
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.writeStatus().catch(() => {});
  }

  startStatusReporter() {
    if (!this.statusFile || this.statusTimer) return;
    this.writeStatus().catch(() => {});
    this.statusTimer = setInterval(() => this.writeStatus().catch(() => {}), 10000);
    this.statusTimer.unref?.();
  }

  async writeStatus() {
    if (!this.statusFile) return;
    const queue = await queueStats().catch(() => null);
    const payload = {
      updatedAt: new Date().toISOString(),
      stopped: this.stopped,
      activeChats: this.bots.size,
      runtimes: this.runtimes.size,
      queuedChats: this.chatQueues.size,
      metrics: metricsSnapshot(),
      queue,
    };
    fs.mkdirSync(path.dirname(this.statusFile), { recursive: true });
    fs.writeFileSync(this.statusFile, `${JSON.stringify(payload, null, 2)}\n`);
  }

  async pollOnce() {
    const updates = await this.api.getUpdates({
      offset: this.offset,
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ['message'],
    });
    if (updates.length === 0) {
      this.logIdle();
      return;
    }
    console.log(`[telegram] updates=${updates.length}`);
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      await this.enqueue(update);
    }
  }

  logIdle() {
    const now = Date.now();
    if (now - this.lastIdleLogAt < this.idleLogMs) return;
    this.lastIdleLogAt = now;
    console.log(`[telegram] idle ${new Date(now).toLocaleTimeString()} waiting for messages...`);
  }

  async enqueue(update) {
    const chatId = update.message?.chat?.id;
    if (!chatId) return;
    const key = String(chatId);
    const previous = this.chatQueues.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.handleUpdate(update))
      .catch((error) => console.error('[telegram] update error:', formatError(error)));
    this.chatQueues.set(key, next);
    await next;
  }

  async handleUpdate(update) {
    const message = update.message;
    const chatId = message?.chat?.id;
    if (!chatId) return;

    if (!isAllowedChat(chatId, this.allowedChatIds)) {
      await this.api.sendMessage(chatId, '这个 bot 还没有开放给这个聊天。');
      return;
    }

    // 文字优先；纯图片走 VISION，纯语音走 ASR，再把模型看到/听到的内容交给编排器回复。
    let text = message.text?.trim() || message.caption?.trim() || '';
    let mediaText = '';
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const photo = message.photo.at(-1);
      const bot = this.botForChat(chatId);
      mediaText = await this.api.downloadDataUrl(photo.file_id, 'image/jpeg')
        .then((dataUrl) => bot.memory.seeImage({
          url: dataUrl,
          mediaRef: `telegram-photo:${photo.file_unique_id || photo.file_id}`,
          subject_kind: 'user',
        }))
        .then((memories) => memories?.[0]?.fact_core || memories?.[0]?.content || '')
        .catch((error) => {
          console.error(`[telegram] image understanding failed chat=${chatId}:`, formatError(error));
          return '';
        });
      if (mediaText) mediaText = `[用户发来一张图片，图片内容：${mediaText}]`;
    } else if (message.voice || message.audio) {
      const audio = message.voice || message.audio;
      const bot = this.botForChat(chatId);
      const ext = path.extname(audio.file_name || '') || (message.voice ? '.ogg' : '.mp3');
      mediaText = await this.api.downloadAsFile(audio.file_id, {
        name: audio.file_name || `telegram-audio${ext}`,
        type: audio.mime_type || (message.voice ? 'audio/ogg' : 'audio/mpeg'),
      })
        .then((file) => bot.memory.hearVoice({
          file,
          mediaRef: `telegram-audio:${audio.file_unique_id || audio.file_id}`,
          subject_kind: 'user',
        }))
        .then((memories) => memories?.[0]?.fact_core || memories?.[0]?.content || '')
        .catch((error) => {
          console.error(`[telegram] audio transcription failed chat=${chatId}:`, formatError(error));
          return '';
        });
      if (mediaText) mediaText = `[用户发来一段语音，转写内容：${mediaText}]`;
    }
    text = [text, mediaText].filter(Boolean).join('\n');
    if (!text) {
      // 模型暂时失败时仍然友好降级，不让一条媒体消息把整个 bot 弄崩。
      if (Array.isArray(message.photo)) {
        await this.api.sendMessage(chatId, '(看了看你发的图) 我刚才没看清细节，你跟我说说这是什么？');
      } else if (message.voice || message.audio) {
        await this.api.sendMessage(chatId, '收到你的语音了，不过刚才转写失败了，打字跟我说一下好不好？');
      } else {
        await this.api.sendMessage(chatId, '我现在先接文字哦。');
      }
      return;
    }

    console.log(`[telegram] message chat=${chatId} text=${JSON.stringify(text.slice(0, 80))}`);

    if (text.startsWith('/start') || text.startsWith('/help')) {
      await this.api.sendMessage(chatId, `我在。直接发消息就可以聊天。`);
      console.log(`[telegram] replied chat=${chatId} command=start/help`);
      return;
    }

    if (text.startsWith('/status')) {
      const bot = this.botForChat(chatId);
      const snapshot = await bot.stateLayer.snapshot().catch(() => null);
      const activity = snapshot?.life?.current_activity ? `\n此刻: ${snapshot.life.current_activity}` : '';
      const m = metricsSnapshot();
      const llmLine = `\nLLM 调用: ${m['llm.calls'] ?? 0} (回复 ${m['llm.calls.reply'] ?? 0})`;
      const q = await queueStats({ userId: telegramUserId(chatId) }).catch(() => null);
      const qLine = q ? `\n队列: pending ${q.pending} / failed ${q.failed}` : '';
      await this.api.sendMessage(chatId, `在线。记忆/状态层/后台调度已接入。${activity}${llmLine}${qLine}`);
      console.log(`[telegram] replied chat=${chatId} command=status`);
      return;
    }

    const bot = this.botForChat(chatId);
    const userId = telegramUserId(chatId);
    // P2：安全 + 配额 + 审计（与 UI 试聊同一套门）
    const gate = gateIncomingMessage({
      text,
      userId,
      companionId: this.companionId,
      channel: 'telegram',
    });
    if (!gate.allow) {
      await this.api.sendMessage(chatId, gate.replyText || '这条消息我这边接不了。');
      console.log(`[telegram] gated chat=${chatId} reasons=${(gate.reasons || []).join(',')}`);
      return;
    }
    console.log(`[telegram] replying chat=${chatId} timeoutMs=${this.replyTimeoutMs}`);
    try {
      const behaviorState = await this.behaviorStore.load({ userId, companionId: this.companionId }).catch(() => ({}));
      const stopTyping = startTypingHeartbeat(this.api, chatId);
      let result;
      try {
        result = await withTimeout((signal) => bot.reply(text, {
          executeStonewall: false,
          behaviorState: { ...behaviorState, stonewallUsedToday: behaviorState.stonewallAt?.length ?? 0 },
          eventId: `telegram:${update.update_id}`,
          stopIntimate: gate.stopIntimate,
          intimacyAllowed: gate.intimacyAllowed,
          signal,
        }), this.replyTimeoutMs, `reply timed out after ${this.replyTimeoutMs}ms`);
      } finally {
        stopTyping();
      }
      const { text: reply, parts, behaviorPolicy: policy } = result;
      // 少数模型会返回可用 text，但结构化 parts 解析为空。发送层只消费 parts，若不兜底会整轮静默。
      const deliverableParts = ensureReplyParts(reply, parts);
      const sent = await this.deliverReply(chatId, deliverableParts, { incomingVoice: Boolean(message.voice || message.audio), policy, behaviorState, bot });
      console.log(`[telegram] replied chat=${chatId} chars=${reply.length} parts=${sent.length}`);
    } catch (error) {
      console.error(`[telegram] reply failed chat=${chatId}:`, formatError(error));
      await this.api
        .sendMessage(chatId, '我这边刚才卡了一下，等我缓一口气。你再说一遍，我接着听。')
        .catch((sendError) => console.error(`[telegram] fallback send failed chat=${chatId}:`, formatError(sendError)));
    }
  }
}

export function createHistoryStore(kind = process.env.TELEGRAM_HISTORY_STORE || 'supabase') {
  if (kind === 'local') {
    console.log('[telegram] history store: local json');
    return new LocalJsonHistoryStore({
      file: process.env.TELEGRAM_HISTORY_FILE || 'logs/chat-history.json',
      maxTurnsPerChat: Number(process.env.TELEGRAM_HISTORY_MAX_TURNS || 80),
    });
  }
  console.log('[telegram] history store: supabase chat_history');
  return new SupabaseHistoryStore();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(work, ms, message) {
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(new Error(message)); reject(new Error(message)); }, ms);
  });
  return Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]).finally(() => clearTimeout(timer));
}

function formatError(error) {
  const parts = [error?.name, error?.message].filter(Boolean);
  const cause = error?.cause;
  if (cause) {
    const causeParts = [cause.code, cause.name, cause.message].filter(Boolean);
    if (causeParts.length > 0) parts.push(`cause=${causeParts.join(' ')}`);
  }
  if (error?.stack) parts.push(error.stack.split('\n').slice(1, 4).join(' | '));
  return parts.join(' ');
}

function postJson(url, body, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        ...(telegramHttpsAgent ? { agent: telegramHttpsAgent } : {}),
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (error) {
            reject(new Error(`Telegram returned invalid JSON: ${error.message}`));
            return;
          }
          resolve({ statusCode: res.statusCode ?? 0, statusMessage: res.statusMessage ?? '', data });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Telegram request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function telegramFetch(url, options = {}) {
  return fetch(url, { ...options, ...(telegramFetchDispatcher ? { dispatcher: telegramFetchDispatcher } : {}) });
}

function acquireProcessLock(lockPath = process.env.TELEGRAM_LOCK_FILE || DEFAULT_LOCK_FILE) {
  if (fs.existsSync(lockPath)) {
    const existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (existingPid && isProcessAlive(existingPid)) {
      throw new Error(`Telegram bot 已经在运行 (pid ${existingPid})。先关掉那个窗口, 或运行 kill ${existingPid}`);
    }
    fs.rmSync(lockPath, { force: true });
  }

  const fd = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  console.log(`[telegram] lock acquired ${lockPath} pid=${process.pid}`);

  return () => {
    try {
      const current = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8').trim() : '';
      if (current === String(process.pid)) fs.rmSync(lockPath, { force: true });
    } catch {}
  };
}

/** 清理 LLM 回复里的格式噪音，但保留动作描写内容。
 *  亲密场景里"清词脱下了……慢慢爬上去……"这类第三人称动作描述是需要的，不删。
 *  只删格式层面的干扰：长括号旁白、半角括号、markdown斜体、开头省略号。 */
function stripNarration(text = '') {
  return text
    .replace(/（[^）]{8,}）/g, '')    // 长全角括号内的旁白描写, 删
    .replace(/\([^)]*\)/g, '')        // 半角括号, 删
    .replace(/\*[^*]+\*/g, '')        // *markdown动作*, 删
    .replace(/^[\s:：]+$/gm, '')           // 整行只剩冒号/空白(剧本式角色名标记残留), 删
    .replace(/\n{2,}/g, '\n')              // 段落空行 → 单换行
    .replace(/^[.…·。：:\s]+/, '')         // 开头停顿符 + 冒号残留（括号删后留下的 ：……）
    .trim();
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// PM2 replaces argv[1] with its own ProcessContainerFork.js, so also check PM2_HOME
if (import.meta.url === `file://${process.argv[1]}` || process.env.PM2_HOME) {
  let releaseLock = () => {};
  const bot = new TelegramMemoryBot();
  const shutdown = () => {
    bot.stop();
    releaseLock();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  (async () => {
    releaseLock = acquireProcessLock();
    try {
      await bot.start();
    } finally {
      releaseLock();
    }
  })().catch((error) => {
    console.error('[telegram] fatal:', error.message);
    releaseLock();
    process.exitCode = 1;
  });
}
