import dotenv from 'dotenv';
import fs from 'node:fs';
import https from 'node:https';
import { Orchestrator, ProactiveScheduler, SupabaseRateLimitStore, LocalJsonHistoryStore, SupabaseHistoryStore } from '../../index.js';
import { loadPersonaConfig } from '../companion.js';
import { CompanionRuntime } from '../runtime/index.js';
import { metricsSnapshot } from '../metrics.js';
import { queueStats } from '../queue/jobs.js';
import { makeScheduleActivityFn, parseSleepWindow } from '../state/activity.js';
import { WeatherProvider } from '../world/weather.js';

dotenv.config();

const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_RETRY_MS = 3000;
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

export function chunkMessage(text, limit = MAX_TELEGRAM_MESSAGE_LENGTH) {
  const src = String(text ?? '').trim();
  if (!src) return [];
  const chunks = [];
  for (let i = 0; i < src.length; i += limit) chunks.push(src.slice(i, i + limit));
  return chunks;
}

class TelegramApi {
  constructor(token) {
    if (!token) throw new Error('缺少 TELEGRAM_BOT_TOKEN');
    this.baseUrl = `https://api.telegram.org/bot${token}`;
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
  } = {}) {
    this.api = api;
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
    this.pollTimeoutSeconds = pollTimeoutSeconds;
    this.idleLogMs = idleLogMs;
    this.replyTimeoutMs = replyTimeoutMs;
    this.lastIdleLogAt = 0;
    this.offset = 0;
    this.bots = new Map();
    this.runtimes = new Map();
    this.chatQueues = new Map();
    this.stopped = false;
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
        options: this.persona?.options ?? {},
        // 角色专属作息 (开会/健身...) 生成 activityFn; 没有则走通用作息模板
        activityFn: this.persona?.life ? makeScheduleActivityFn(this.persona.life) : null,
        // P2: 角色专属身体参数 (睡眠时段/发病概率), 喂给 LifeDimension
        lifeConfig: this.persona?.life ?? null,
        deps: { historyStore: this.historyStore, weather: this.weather }, // 短期历史落库 + 真实天气
      });
      this.bots.set(key, orchestrator);
      this.startRuntime(chatId, orchestrator);
    }
    return this.bots.get(key);
  }

  /** 给一个 chat 起后台"活着"循环: 维护(心情回落/作息/生病/夜间反思) + 主动消息(投递回这个 chat)。 */
  startRuntime(chatId, orchestrator) {
    const key = String(chatId);
    if (this.runtimes.has(key)) return;
    const proactiveScheduler = new ProactiveScheduler({
      orchestrator,
      stateStore: new SupabaseRateLimitStore(),
      policy: this.proactivePolicy,
      // 主动消息直接发回这个 chat
      deliver: async ({ message }) => {
        for (const chunk of chunkMessage(message)) await this.api.sendMessage(chatId, chunk).catch(() => {});
        console.log(`[telegram] proactive sent chat=${chatId} chars=${message.length}`);
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
    const me = await this.api.getMe();
    console.log(`[telegram] @${me.username} started`);
    console.log(
      this.allowedChatIds.size > 0
        ? `[telegram] allowed chats: ${Array.from(this.allowedChatIds).join(', ')}`
        : '[telegram] allowed chats: all',
    );
    console.log('[telegram] waiting for messages...');
    while (!this.stopped) {
      await this.pollOnce().catch(async (error) => {
        console.error('[telegram] poll error:', formatError(error));
        await sleep(DEFAULT_RETRY_MS);
      });
    }
  }

  stop() {
    this.stopped = true;
    for (const rt of this.runtimes.values()) rt.stop();
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

    // 文字优先; 图片带的 caption 也当文字用 (有上下文就能正常回应)。
    const text = message.text?.trim() || message.caption?.trim();
    if (!text) {
      // 纯图片/语音: 还没接视觉/ASR 模型, 暂时看不清/听不清, 但别冷冰冰地拒绝。
      if (Array.isArray(message.photo)) {
        await this.api.sendMessage(chatId, '(看了看你发的图) 我这会儿还看不太清图里的细节，你跟我说说这是什么？');
      } else if (message.voice || message.audio) {
        await this.api.sendMessage(chatId, '收到你的语音了，不过我现在还听不太清，打字跟我说好不好？');
      } else {
        await this.api.sendMessage(chatId, '我现在先接文字哦，图片/语音你先配句话给我。');
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

    await this.api.sendChatAction(chatId, 'typing').catch(() => {});
    const bot = this.botForChat(chatId);
    console.log(`[telegram] replying chat=${chatId} timeoutMs=${this.replyTimeoutMs}`);
    try {
      const raw = await withTimeout(bot.reply(text), this.replyTimeoutMs, `reply timed out after ${this.replyTimeoutMs}ms`);
      const reply = stripNarration(raw);
      for (const chunk of chunkMessage(reply)) {
        await this.api.sendMessage(chatId, chunk);
      }
      console.log(`[telegram] replied chat=${chatId} chars=${reply.length}`);
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

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

/** 清理 LLM 回复里的小说/旁白格式噪音。
 *  全角（）超过 8 个字 = 旁白描写, 删; 8 字以内 = 声音/情绪（嗯/好/轻笑），保留。
 *  半角() 一律删 (通常是英文注释风格, 不是正文)。
 *  "……"/"......" 做分隔符是文学写法, 也删掉, 避免发消息里出现省略号长串。 */
function stripNarration(text = '') {
  return text
    .replace(/（[^）]{8,}）/g, '')    // 长全角括号 = 旁白, 删
    .replace(/\([^)]*\)/g, '')        // 半角括号, 删
    .replace(/\*[^*]+\*/g, '')        // *markdown动作*, 删
    .replace(/[：:]\s*[.…]{2,}/g, '') // 冒号+省略号 (小说体"她说：……"), 删
    .replace(/[.…]{4,}/g, '')         // 连续4个以上省略号分隔符, 删
    .replace(/\n{2,}/g, '\n')         // 段落空行 → 单换行
    .replace(/^[.…·。\s]+/, '')       // 开头停顿符
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
