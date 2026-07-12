import { channelUserId, chunkText, outgoingTexts, mergedOutgoingTexts } from '../src/channels/memory-channel.js';
import { FeishuMemoryBot, parseFeishuText, parseFeishuImageKey, parseImageDataUrl } from '../src/feishu/bot.js';
import { ChannelEventStore } from '../src/channels/idempotency.js';
import { cleanDiscordText, shouldHandleDiscordMessage } from '../src/discord/bot.js';

let passed = 0;
function ok(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed += 1;
}

ok('不同渠道的用户记忆隔离', channelUserId('feishu', 'u1') !== channelUserId('discord', 'u1'));
ok('飞书文本消息解析', parseFeishuText('{"text":"你好"}') === '你好');
ok('飞书 @ 标记清理', parseFeishuText('{"text":"@_user_1 你好"}') === '你好');
ok('飞书图片 key 解析', parseFeishuImageKey('{"image_key":"img_v2_abc"}') === 'img_v2_abc');
ok('飞书坏图片内容安全降级', parseFeishuImageKey('not-json') === '');

const inserted = new Set();
const eventStore = new ChannelEventStore({
  client: { from: () => ({ insert: async ({ channel, event_id: eventId }) => {
    const key = `${channel}:${eventId}`;
    if (inserted.has(key)) return { error: { code: '23505' } };
    inserted.add(key);
    return { error: null };
  } }) },
});
ok('渠道事件首次可认领', await eventStore.claim('feishu', 'm1'));
ok('渠道事件同进程重复被拒绝', !await eventStore.claim('feishu', 'm1'));
const secondProcess = new ChannelEventStore({ client: eventStore.client });
ok('渠道事件跨进程重复被数据库拒绝', !await secondProcess.claim('feishu', 'm1'));
const imageData = parseImageDataUrl('data:image/png;base64,aGk=');
ok('生成图片 data URL 转 Buffer', imageData?.mime === 'image/png' && imageData.buffer.toString() === 'hi');
ok('非图片 data URL 被拒绝', parseImageDataUrl('data:text/plain;base64,aGk=') === null);
ok('Discord mention 清理', cleanDiscordText('<@123> 你好', '123') === '你好');
ok('Discord 私聊直接处理', shouldHandleDiscordMessage({ author: { bot: false }, guildId: null }, '123'));
ok('Discord 群聊仅处理 mention', !shouldHandleDiscordMessage({ author: { bot: false }, guildId: 'g', mentions: { users: { has: () => false } } }, '123'));
ok('Discord 忽略机器人消息', !shouldHandleDiscordMessage({ author: { bot: true } }, '123'));
ok('长消息正确切片', chunkText('abcdef', 2).join('|') === 'ab|cd|ef');
ok('parts 转消息', outgoingTexts([{ type: 'dialogue', text: '你好' }], 20)[0] === '你好');
ok('旁白和台词合并成一条渠道消息', mergedOutgoingTexts([
  { type: 'narration', text: '她笑了。' }, { type: 'dialogue', text: '你来啦。' },
], 100)[0] === '她笑了。\n\n你来啦。');

let uploaded = null;
let sent = null;
const fakeFeishu = {
  senderChats: new Map([['u1', 'chat1']]),
  uploadImage: async (buffer) => { uploaded = buffer; return 'img_uploaded'; },
  sendImage: async (chatId, imageKey) => { sent = { chatId, imageKey }; },
};
await FeishuMemoryBot.prototype.sendGeneratedPhoto.call(fakeFeishu, 'u1', 'data:image/png;base64,aGk=', 'selfie');
ok('飞书生成图片上传二进制', uploaded?.toString() === 'hi');
ok('飞书生成图片发送到最近会话', sent?.chatId === 'chat1' && sent?.imageKey === 'img_uploaded');

console.log(`channels 全部 ${passed} 条断言通过`);
