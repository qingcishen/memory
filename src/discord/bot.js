import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { MemoryChannel, mergedOutgoingTexts } from '../channels/memory-channel.js';
import { ChannelEventStore } from '../channels/idempotency.js';
import { acquireProcessLock } from '../channels/process-lock.js';
import { gateIncomingMessage } from '../product/gate.js';

dotenv.config();

export function cleanDiscordText(text = '', botId = '') {
  return String(text).replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

export function shouldHandleDiscordMessage(message, botId, allowedGuildIds = new Set()) {
  if (!message || message.author?.bot) return false;
  if (allowedGuildIds.size && message.guildId && !allowedGuildIds.has(String(message.guildId))) return false;
  return !message.guildId || message.mentions?.users?.has(botId);
}

export class DiscordMemoryBot {
  constructor({ token = process.env.DISCORD_BOT_TOKEN, client, eventStore = new ChannelEventStore() } = {}) {
    if (!token) throw new Error('缺少 DISCORD_BOT_TOKEN');
    this.token = token;
    this.allowedGuildIds = new Set(String(process.env.DISCORD_ALLOWED_GUILD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
    this.client = client || new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    });
    this.eventStore = eventStore;
    this.memory = new MemoryChannel({
      channel: 'discord',
      companionId: process.env.DISCORD_COMPANION_ID || process.env.TELEGRAM_COMPANION_ID || 'default',
      companionName: process.env.DISCORD_COMPANION_NAME || process.env.TELEGRAM_COMPANION_NAME || '小忆',
      subjectName: process.env.DISCORD_SUBJECT_NAME || process.env.TELEGRAM_SUBJECT_NAME || '你',
      personaFile: process.env.DISCORD_PERSONA_FILE || `companions/${process.env.DISCORD_COMPANION_ID || process.env.TELEGRAM_COMPANION_ID || 'default'}.json`,
      replyTimeoutMs: Number(process.env.DISCORD_REPLY_TIMEOUT_MS || 90000),
    });
    this.client.on('ready', () => console.log(`[discord] @${this.client.user.tag} started`));
    this.client.on('messageCreate', (message) => this.handleMessage(message));
  }

  async handleMessage(message) {
    const botId = this.client.user?.id || '';
    if (!shouldHandleDiscordMessage(message, botId, this.allowedGuildIds)) return;
    if (!await this.eventStore.claim('discord', message.id)) return;
    const text = cleanDiscordText(message.content, botId);
    if (!text) return;
    const senderId = message.author.id;
    const companionId = process.env.DISCORD_COMPANION_ID || process.env.TELEGRAM_COMPANION_ID || 'default';
    const gate = gateIncomingMessage({
      text,
      userId: `discord:${senderId}`,
      companionId,
      channel: 'discord',
    });
    if (!gate.allow) {
      await message.reply({
        content: gate.replyText || '这条消息我这边接不了。',
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
      console.log(`[discord] gated user=${senderId} reasons=${(gate.reasons || []).join(',')}`);
      return;
    }
    try {
      await message.channel.sendTyping().catch(() => {});
      const result = await this.memory.reply(senderId, text, {
        eventId: message.id,
        stopIntimate: gate.stopIntimate,
        intimacyAllowed: gate.intimacyAllowed,
      });
      for (const part of mergedOutgoingTexts(result.parts, 1900)) {
        await message.reply({ content: part, allowedMentions: { repliedUser: false } });
      }
    } catch (error) {
      console.error('[discord] reply failed:', error);
      await message.reply({ content: '我这边刚才卡了一下，你再说一遍，我接着听。', allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  }

  start() { this.memory.startWorker(); return this.client.login(this.token); }
  stop() { this.memory.stopWorker(); this.client.destroy(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const releaseLock = acquireProcessLock(process.env.DISCORD_LOCK_FILE || '.discord-bot.lock', 'Discord bot');
  const bot = new DiscordMemoryBot();
  const shutdown = () => { bot.stop(); releaseLock(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  bot.start().catch((error) => { releaseLock(); console.error('[discord] fatal:', error); process.exitCode = 1; });
}
