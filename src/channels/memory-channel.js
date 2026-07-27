import { Orchestrator, LocalJsonHistoryStore, SupabaseHistoryStore } from '../../index.js';
import { loadPersonaConfig } from '../companion.js';
import { makeScheduleActivityFn } from '../state/activity.js';
import { WeatherProvider } from '../world/weather.js';
import { WorldDimension } from '../world/index.js';
import { SceneClassifier } from '../narration.js';
import { BehaviorStateStore } from '../state/behavior.js';
import { enqueue, Worker } from '../queue/jobs.js';

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
    this.weather = new WeatherProvider({
      place: process.env.WEATHER_PLACE || '武汉',
      ...(process.env.WEATHER_LAT ? { lat: Number(process.env.WEATHER_LAT) } : {}),
      ...(process.env.WEATHER_LON ? { lon: Number(process.env.WEATHER_LON) } : {}),
    });
    this.narration = new SceneClassifier();
    this.sessions = new Map();
    this.queues = new Map();
    this.jobKind = `${channel}:after_reply`;
    this.worker = new Worker({
      handlers: {
        [this.jobKind]: async ({ senderId, userMessage, reply }) => this.session(senderId).runAfterReply(userMessage, reply),
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
      this.sessions.set(key, new Orchestrator({
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
          historyStore: this.historyStore,
          weather: this.weather,
          world: new WorldDimension({ userId, companionId: this.companionId }),
          narration: this.narration,
          ...(this.onPhoto ? { onPhoto: (photo) => this.onPhoto({ ...photo, senderId: key }) } : {}),
          afterReplyEnqueue: ({ userMessage, reply }) => enqueue(userId, this.companionId, this.jobKind, { senderId: key, userMessage, reply }),
        },
      }));
    }
    return this.sessions.get(key);
  }

  startWorker() { this.worker.start(); }
  stopWorker() { this.worker.stop(); }

  enqueue(senderId, work) {
    const key = String(senderId);
    const next = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(key, next);
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  async reply(senderId, text, { eventId = null } = {}) {
    return this.enqueue(senderId, async () => {
      const bot = this.session(senderId);
      const scope = { userId: this.userId(senderId), companionId: this.companionId };
      const behaviorState = await this.behaviorStore.load(scope).catch(() => ({}));
      const result = await withTimeout((signal) => bot.reply(text, {
        // 渠道不执行“冷处理”：模型生成的回复必须完整送达。
        executeStonewall: false,
        behaviorState: { ...behaviorState, stonewallUsedToday: behaviorState.stonewallAt?.length ?? 0 },
        eventId,
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
