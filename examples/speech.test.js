// TTS 语音回复的纯逻辑单测 (src/modal/speech.js): 选材 + 开口判断。
// 不连网、不调 TTS。

import { pickSpeakableText, shouldReplyWithVoice } from '../src/modal/speech.js';

let passed = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exit(1);
  }
  console.log(`  ✓ ${name}`);
  passed++;
};

console.log('pickSpeakableText (从 parts 挑可念的台词)');
{
  const parts = [
    { type: 'narration', text: '她低头笑了一下。' },
    { type: 'dialogue', text: '嗯，我在。' },
    { type: 'dialogue', text: '茶给你留着。' },
  ];
  ok('只取台词、按序拼接', pickSpeakableText(parts) === '嗯，我在。 茶给你留着。');
  ok('旁白不被念出来', !pickSpeakableText(parts).includes('低头'));
  ok('空 parts 返回空串', pickSpeakableText([]) === '');
  ok('只有旁白返回空串', pickSpeakableText([{ type: 'narration', text: '她沉默着。' }]) === '');
  ok('超长台词不合成 (回退文字)', pickSpeakableText([{ type: 'dialogue', text: '长'.repeat(500) }]) === '');
  ok('maxChars 可覆盖', pickSpeakableText([{ type: 'dialogue', text: '12345' }], { maxChars: 4 }) === '');
  ok('空白台词被过滤', pickSpeakableText([{ type: 'dialogue', text: '   ' }]) === '');
}

console.log('shouldReplyWithVoice (语音进语音出的开口判断)');
{
  ok('语音进 + 已配置 + 有台词 -> 开口', shouldReplyWithVoice({ incomingVoice: true, configured: true, speakable: '嗯' }));
  ok('文字进永远不突然冒语音', !shouldReplyWithVoice({ incomingVoice: false, configured: true, speakable: '嗯' }));
  ok('没配 TTS 永远纯文字', !shouldReplyWithVoice({ incomingVoice: true, configured: false, speakable: '嗯' }));
  ok('没有可念台词不开口', !shouldReplyWithVoice({ incomingVoice: true, configured: true, speakable: '' }));
  ok('缺省参数安全 (全 false)', !shouldReplyWithVoice());
}

console.log(`\nTTS 语音回复 全部 ${passed} 条断言通过 ✅`);
