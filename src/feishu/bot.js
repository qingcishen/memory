import dotenv from 'dotenv';
import * as lark from '@larksuiteoapi/node-sdk';
import { MemoryChannel, mergedOutgoingTexts } from '../channels/memory-channel.js';
import { ChannelEventStore } from '../channels/idempotency.js';
import { acquireProcessLock } from '../channels/process-lock.js';
import { gateIncomingMessage } from '../product/gate.js';
import { deliverHumanBubbles } from '../channels/humanSend.js';

dotenv.config();

export function parseFeishuText(content = '') {
  try { return String(JSON.parse(content)?.text || '').replace(/@_user_\d+/g, '').trim(); }
  catch { return ''; }
}

export function parseFeishuImageKey(content = '') {
  try { return String(JSON.parse(content)?.image_key || '').trim(); }
  catch { return ''; }
}

export function parseImageDataUrl(url = '') {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(url).trim());
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  return buffer.length ? { mime: match[1].toLowerCase(), buffer } : null;
}

export class FeishuMemoryBot {
  constructor({
    appId = process.env.FEISHU_APP_ID,
    appSecret = process.env.FEISHU_APP_SECRET,
    verificationToken = process.env.FEISHU_VERIFICATION_TOKEN,
    encryptKey = process.env.FEISHU_ENCRYPT_KEY,
    client,
    wsClient,
    eventStore = new ChannelEventStore(),
  } = {}) {
    if (!appId || !appSecret) throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
    const options = { appId, appSecret, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu };
    this.client = client || new lark.Client(options);
    this.wsClient = wsClient || new lark.WSClient(options);
    this.dispatcher = new lark.EventDispatcher({ verificationToken, encryptKey }).register({
      'im.message.receive_v1': (data) => this.handleMessage(data),
    });
    this.senderChats = new Map();
    this.eventStore = eventStore;
    this.keepAliveTimer = null;
    this.memory = new MemoryChannel({
      channel: 'feishu',
      companionId: process.env.FEISHU_COMPANION_ID || process.env.TELEGRAM_COMPANION_ID || 'default',
      companionName: process.env.FEISHU_COMPANION_NAME || process.env.TELEGRAM_COMPANION_NAME || '小忆',
      subjectName: process.env.FEISHU_SUBJECT_NAME || process.env.TELEGRAM_SUBJECT_NAME || '你',
      personaFile: process.env.FEISHU_PERSONA_FILE || `companions/${process.env.FEISHU_COMPANION_ID || process.env.TELEGRAM_COMPANION_ID || 'default'}.json`,
      replyTimeoutMs: Number(process.env.FEISHU_REPLY_TIMEOUT_MS || 90000),
      onPhoto: ({ senderId, url, kind }) => this.sendGeneratedPhoto(senderId, url, kind),
    });
  }

  async send(chatId, text) {
    return this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid: crypto.randomUUID() },
    });
  }

  async sendImage(chatId, imageKey) {
    return this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }), uuid: crypto.randomUUID() },
    });
  }

  async uploadImage(buffer) {
    const result = await this.client.im.image.create({ data: { image_type: 'message', image: buffer } });
    if (!result?.image_key) throw new Error('飞书上传图片没有返回 image_key');
    return result.image_key;
  }

  async sendGeneratedPhoto(senderId, url, kind = 'photo') {
    const chatId = this.senderChats.get(String(senderId));
    if (!chatId) throw new Error(`找不到 ${senderId} 最近的飞书会话`);
    let parsed = parseImageDataUrl(url);
    if (!parsed && /^https?:\/\//i.test(String(url))) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`下载生成图片失败: HTTP ${response.status}`);
      parsed = { mime: response.headers.get('content-type') || 'image/png', buffer: Buffer.from(await response.arrayBuffer()) };
    }
    if (!parsed?.buffer?.length) throw new Error(`生成的 ${kind} 不是可上传图片`);
    const imageKey = await this.uploadImage(parsed.buffer);
    await this.sendImage(chatId, imageKey);
    console.log(`[feishu] generated ${kind} sent chat=${chatId}`);
  }

  async downloadMessageImage(messageId, imageKey) {
    const resource = await this.client.im.messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: imageKey },
    });
    const buffer = await readableToBuffer(resource.getReadableStream());
    const contentType = String(resource.headers?.['content-type'] || resource.headers?.get?.('content-type') || 'image/jpeg').split(';')[0];
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  async handleMessage(data) {
    const message = data?.message;
    const senderId = data?.sender?.sender_id?.open_id;
    if (!message?.chat_id || !senderId || !['text', 'image'].includes(message.message_type)) return;
    if (!await this.eventStore.claim('feishu', message.message_id)) return;
    this.senderChats.set(String(senderId), message.chat_id);
    let text = parseFeishuText(message.content);
    if (message.message_type === 'image') {
      const imageKey = parseFeishuImageKey(message.content);
      if (!imageKey || !message.message_id) return;
      const bot = this.memory.session(senderId);
      const mediaText = await this.downloadMessageImage(message.message_id, imageKey)
        .then((dataUrl) => bot.memory.seeImage({
          url: dataUrl,
          mediaRef: `feishu-image:${message.message_id}:${imageKey}`,
          subject_kind: 'user',
        }))
        .then((memories) => memories?.[0]?.fact_core || memories?.[0]?.content || '')
        .catch((error) => {
          console.error('[feishu] image understanding failed:', error);
          return '';
        });
      text = mediaText ? `[用户发来一张图片，图片内容：${mediaText}]` : '';
      if (!text) {
        await this.send(message.chat_id, '(看了看你发的图) 我刚才没看清细节，你跟我说说这是什么？');
        return;
      }
    }
    if (!text) return;
    const companionId = process.env.FEISHU_COMPANION_ID || process.env.TELEGRAM_COMPANION_ID || 'default';
    const gate = gateIncomingMessage({
      text,
      userId: `feishu:${senderId}`,
      companionId,
      channel: 'feishu',
    });
    if (!gate.allow) {
      await this.send(message.chat_id, gate.replyText || '这条消息我这边接不了。');
      console.log(`[feishu] gated sender=${senderId} reasons=${(gate.reasons || []).join(',')}`);
      return;
    }
    try {
      const result = await this.memory.reply(senderId, text, {
        eventId: message.message_id,
        stopIntimate: gate.stopIntimate,
        intimacyAllowed: gate.intimacyAllowed,
      });
      // 像真人连发：旁白/多句台词分条 + 间隔（CHANNEL_MERGE_MESSAGES=1 可关）
      await deliverHumanBubbles(result.parts, (bubble) => this.send(message.chat_id, bubble), {
        chunkLimit: 3800,
      });
    } catch (error) {
      console.error('[feishu] reply failed:', error);
      await this.send(message.chat_id, '我这边刚才卡了一下，你再说一遍，我接着听。').catch(() => {});
    }
  }

  async start() {
    console.log('[feishu] long connection starting...');
    this.memory.startWorker();
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
    // SDK start() 在 WebSocket 就绪后会 resolve；部分 Node/SDK 组合不会留下 ref'ed handle，
    // 显式保持进程生命周期，避免出现“ws client ready 后立即退出”。
    if (!this.keepAliveTimer) this.keepAliveTimer = setInterval(() => {}, 60_000);
  }

  stop() {
    this.memory.stopWorker();
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.wsClient?.close?.();
  }
}

async function readableToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const releaseLock = acquireProcessLock(process.env.FEISHU_LOCK_FILE || '.feishu-bot.lock', '飞书 bot');
  const bot = new FeishuMemoryBot();
  const shutdown = () => { bot.stop(); releaseLock(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  bot.start().catch((error) => { releaseLock(); console.error('[feishu] fatal:', error); process.exitCode = 1; });
}
