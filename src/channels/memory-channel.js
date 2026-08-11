import {
  Orchestrator,
  LocalJsonHistoryStore,
  SupabaseHistoryStore,
  createPersistentCognitiveCore,
  createPersistentExistenceEngine,
  personalitySeedFromCompanionConfig,
  ProactiveScheduler,
  SupabaseRateLimitStore,
} from '../../index.js';
import { loadPersonaConfig } from '../companion.js';
import { makeScheduleActivityFn } from '../state/activity.js';
import { WeatherProvider } from '../world/weather.js';
import { WorldDimension } from '../world/index.js';
import { SceneClassifier } from '../narration.js';
import { BehaviorStateStore } from '../state/behavior.js';
import { enqueue, Worker } from '../queue/jobs.js';
import { dispatchMediaOutbox } from '../media/outbox.js';
import { CompanionRuntime } from '../runtime/index.js';

export function channelUserId(channel, id) {
  return `${channel}:${id}`;
}

export function chunkText(text, limit) {
  const source = String(text ?? '').trim() || '...';
  const chunks = [];
  for (let start = 0; start < source.length;) {
    let end = Math.min(source.length, start + limit);
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end -= 1;
    chunks.push(source.slice(start, end));
    start = end;
  }
  return chunks;
}

export function outgoingTexts(parts, limit = 1900) {
  return (parts ?? []).flatMap((part) => chunkText(part?.text, limit)).filter(Boolean);
}

export function mergedOutgoingTexts(parts, limit = 1900) {
  const text = (parts ?? []).map((part) => String(part?.text || '').trim()).filter(Boolean).join('\n\n');
  return chunkText(text, limit);
}

export class MemoryChannel {
  constructor({
    channel,
    companionId = 'default',
    companionName = '小忆',
    subjectName = '你',
    personaFile = `companions/${companionId}.json`,
    historyStore = process.env.CHANNEL_HISTORY_STORE === 'local'
      ? new LocalJsonHistoryStore({ file: process.env.CHANNEL_HISTORY_FILE || 'logs/channel-history.json', maxTurnsPerChat: 80 })
      : new SupabaseHistoryStore(),
    behaviorStore = new BehaviorStateStore(),
    replyTimeoutMs = 90000,
    onPhoto = null,
    onProactive = null,
  }) {
    this.channel = channel;
    this.companionId = companionId;
    this.companionName = companionName;
    this.subjectName = subjectName;
    this.persona = loadPersonaConfig(personaFile);
    this.historyStore = historyStore;
    this.behaviorStore = behaviorStore;
    this.replyTimeoutMs = replyTimeoutMs;
    this.onPhoto = onPhoto;
    this.onProactive = onProactive;
    this._proactivePolicy = {
      quietHours: { start: 23, end: 8 },
      minIntervalMinutes: 180,
      maxPerDay: 3,
      timezoneOffsetMinutes: 8 * 60,
    };
    this.weather = new WeatherProvider({
      place: process.env.WEATHER_PLACE || '武汉',
      ...(process.env.WEATHER_LAT ? { lat: Number(process.env.WEATHER_LAT) } : {}),
      ...(process.env.WEATHER_LON ? { lon: Number(process.env.WEATHER_LON) } : {}),
    });
    this.narration = new SceneClassifier();
    this.sessions = new Map();
    this.runtimes = new Map();
    this.queues = new Map();
    this.jobKind = `${channel}:after_reply`;
    this.mediaJobKind = `${channel}:media_delivery`;
    this.worker = new Worker({
      handlers: {
        [this.jobKind]: async ({ senderId, userMessage, reply, eventId, sceneType, emotionLabel, emotionEvent }) =>
          this.session(senderId).runAfterReply(userMessage, reply, {
            eventId,
            sceneType,
            emotionLabel,
            emotionEvent,
          }),
        [this.mediaJobKind]: async ({ senderId, asset }) =>
          this.onPhoto?.({ ...asset, senderId: String(senderId) }),
      },
    });
  }

  userId(senderId) {
    return channelUserId(this.channel, senderId);
  }

  session(senderId) {
    const key = String(senderId);
    if (!this.sessions.has(key)) {
      const userId = this.userId(senderId);
      const cognitiveCore = createPersistentCognitiveCore({
        userId,
        companionId: this.companionId,
      });
      const existence = createPersistentExistenceEngine({
        userId,
        companionId: this.companionId,
        companionName: this.companionName,
        userName: this.subjectName,
        historyStore: this.historyStore,
        beliefs: cognitiveCore.beliefEngine,
        personalitySeed: personalitySeedFromCompanionConfig(
          this.persona?.config,
        ),
      });
      const orchestrator = new Orchestrator({
        userId,
        companionId: this.companionId,
        companionName: this.companionName,
        subjectName: this.subjectName,
        config: this.persona?.config ?? null,
        options: {
          ...(this.persona?.options ?? {}),
          useMonologue: process.env.CHANNEL_USE_MONOLOGUE === 'true',
        },
        activityFn: this.persona?.life ? makeScheduleActivityFn(this.persona.life) : null,
        lifeConfig: this.persona?.life ?? null,
        deps: {
          ...cognitiveCore,
          historyStore: this.historyStore,
          existence,
          weather: this.weather,
          world: new WorldDimension({ userId, companionId: this.companionId }),
          narration: this.narration,
          ...(this.onPhoto ? {
            onPhoto: (photo) => dispatchMediaOutbox({
              asset: photo,
              route: { senderId: key },
              eventId: photo.eventId,
              projection: photo.projection,
              enqueue: (payload, opts) =>
                enqueue(userId, this.companionId, this.mediaJobKind, payload, opts),
              deliverNow: (asset) => this.onPhoto({ ...asset, senderId: key }),
            }),
          } : {}),
          afterReplyEnqueue: ({ userMessage, reply, eventId, sceneType, emotionLabel, emotionEvent }) => enqueue(
            userId,
            this.companionId,
            this.jobKind,
            { senderId: key, userMessage, reply, eventId, sceneType, emotionLabel, emotionEvent },
            { idempotencyKey: eventId ? `${eventId}:after_reply` : null },
          ),
        },
      });
      existence.memory = orchestrator.memory;
      this.sessions.set(key, orchestrator);
      let proactiveScheduler = null;
      if (this.onProactive) {
        proactiveScheduler = new ProactiveScheduler({
          orchestrator,
          stateStore: new SupabaseRateLimitStore(),
          policy: this._proactivePolicy,
          deliver: async ({ message }) => {
            try {
              await this.onProactive({ senderId: key, message });
            } catch (err) {
              console.error(`[${this.channel}] proactive delivery failed for ${key}:`, err);
            }
          },
          getDueItems: () =>
            orchestrator.memory.checkProspective?.({}).catch(() => []) ?? [],
          markFired: (ids) =>
            orchestrator.memory.dismissProspective?.(ids).catch(() => {}),
        });
      }
      const runtime = new CompanionRuntime({
        orchestrator,
        proactiveScheduler,
        options: { timezoneOffsetMinutes: 8 * 60 },
      });
      runtime.start();
      this.runtimes.set(key, runtime);
    }
    return this.sessions.get(key);
  }

  startWorker() { this.worker.start(); }
  stopWorker() {
    this.worker.stop();
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
  }

  /**
   * 进程启动后预热历史活跃用户的心跳，避免沉默用户等到下一条消息才恢复心跳。
   * senderIds: 外部用户 ID 数组（不含 channel 前缀）；
   *            通常从 MemoryChannel.listActiveSenderIds() 获取。
   */
  async warmupSessions(senderIds = []) {
    for (const id of senderIds) {
      try {
        this.session(String(id));
      } catch (err) {
        console.error('[warmup] failed to init session for', id, err);
      }
    }
  }

  /**
   * 查询 Supabase 中最近活跃用户的 senderId 列表，供 warmupSessions() 使用。
   * supabaseClient: @supabase/supabase-js 实例
   * maxAgeHours: 只预热这个时间范围内有过状态更新的用户（默认 48h）
   */
  static async listActiveSenderIds(supabaseClient, channel, companionId, maxAgeHours = 48) {
    const since = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseClient
      .from('companion_continuous_state')
      .select('user_id')
      .eq('companion_id', companionId)
      .gte('updated_at', since);
    if (error) throw error;
    const prefix = `${channel}:`;
    return (data ?? [])
      .map((row) => row.user_id)
      .filter((uid) => uid.startsWith(prefix))
      .map((uid) => uid.slice(prefix.length));
  }

  enqueue(senderId, work) {
    const key = String(senderId);
    const next = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(key, next);
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  async reply(senderId, text, { eventId = null, stopIntimate = false, intimacyAllowed = true } = {}) {
    return this.enqueue(senderId, async () => {
      const bot = this.session(senderId);
      const scope = { userId: this.userId(senderId), companionId: this.companionId };
      const behaviorState = await this.behaviorStore.load(scope).catch(() => ({}));
      const result = await withTimeout((signal) => bot.reply(text, {
        // 渠道不执行“冷处理”：模型生成的回复必须完整送达。
        executeStonewall: false,
        behaviorState: { ...behaviorState, stonewallUsedToday: behaviorState.stonewallAt?.length ?? 0 },
        eventId,
        stopIntimate,
        intimacyAllowed,
        signal,
      }), this.replyTimeoutMs, `${this.channel} reply timed out`);
      if (behaviorState.mustGiveRepairStep) {
        await this.behaviorStore.save({ ...behaviorState, mustGiveRepairStep: false }, scope).catch(() => {});
      }
      // partsBudget 只作为提示模型控制长度，不能在发送层截断已生成的台词。
      return result;
    });
  }
}

function withTimeout(work, ms, message) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(new Error(message)); reject(new Error(message)); }, ms);
  });
  return Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]).finally(() => clearTimeout(timer));
}
