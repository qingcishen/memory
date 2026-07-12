// TTS 语音合成 (M6 的"能说"半边): 她给你发语音条。
//
// 策略是"语音进语音出": 只有对方刚发了语音、且显式配置了 TTS_MODEL 时才开口 ——
// 纯文字聊天永远不突然冒语音 (打扰), 没配 TTS 的部署零行为变化。
// 台词 (dialogue parts) 合成一条语音; 旁白 (narration) 是第三人称描写, 念出来
// 会很怪, 仍走文字。纯逻辑 (选材/判断) 与 IO (合成) 分离, 前者可离线单测。

import { ttsLlm, TTS_MODEL, TTS_VOICE_ID, PARAMS } from '../config.js';
import { recordLlmCall } from '../metrics.js';

/**
 * 从 parts 里挑出适合"念出来"的文本 (纯函数):
 * 只取 dialogue, 按顺序拼接; 为空或总长超过 maxSpeakChars (长回复念出来很怪) 返回空串。
 */
export function pickSpeakableText(parts = [], { maxChars = PARAMS.tts.maxSpeakChars } = {}) {
  const text = (parts ?? [])
    .filter((p) => p && p.type !== 'narration')
    .map((p) => String(p.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!text || text.length > maxChars) return '';
  return text;
}

/** 这一轮要不要用语音回 (纯函数): 对方发的是语音 + 配置了 TTS + 有可念的台词。 */
export function shouldReplyWithVoice({ incomingVoice = false, configured = false, speakable = '' } = {}) {
  return Boolean(incomingVoice && configured && String(speakable).trim());
}

/**
 * IO: 文本 -> ogg/opus 音频 Buffer (Telegram sendVoice 要的格式)。
 * 失败向上抛, 由调用方回退纯文字 —— 语音是锦上添花, 不能让合成失败吞掉回复。
 */
export async function synthesizeSpeech(text, opts = {}) {
  const res = await ttsLlm.audio.speech.create({
    model: opts.model ?? TTS_MODEL,
    voice: opts.voice ?? TTS_VOICE_ID,
    input: String(text),
    response_format: 'opus',
  });
  recordLlmCall('tts');
  return Buffer.from(await res.arrayBuffer());
}
