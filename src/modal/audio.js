// M6 · 语音记忆。发来的语音 → ASR 转写(进 content) + 语气(进 affect 情感层)。
// "她哭着说没事" 和 "她笑着说没事" 是两条情感色彩完全不同的记忆 —— 语气进 affect,
// 于是同一句话在心情门控/重构下表现不同。复用 M0~M3 本体/状态/重构/引擎。
//
// 缺 ASR 凭证时降级: 调用方给了 transcript 仍可入库; 否则跳过, 不抛、不崩。

import { llm } from '../config.js';
import { normalizeMemory } from '../ontology.js';
import { storeMemories } from '../store.js';

// ---- 纯逻辑 ----

/**
 * 把语气特征映射成情感层 {valence, intensity}。
 * prosody 可给 { valence, intensity } 直接用, 或给 { tone, energy } 让这里粗映射。
 */
export function prosodyToAffect(prosody = {}) {
  if (prosody.valence != null || prosody.intensity != null) {
    return { valence: clamp(prosody.valence ?? 0, -1, 1), intensity: clamp(prosody.intensity ?? 0.3, 0, 1) };
  }
  const toneMap = { happy: 0.6, excited: 0.5, calm: 0.1, sad: -0.6, angry: -0.7, anxious: -0.4, crying: -0.8 };
  const valence = toneMap[prosody.tone] ?? 0;
  const intensity = clamp(prosody.energy ?? (prosody.tone ? 0.6 : 0.3), 0, 1);
  return { valence: clamp(valence, -1, 1), intensity };
}

/**
 * 把转写文本 + 语气组装成 audio 模态记忆 (走标准两层本体)。
 * @param opts { transcript, prosody, mediaRef, subjectName, importance, subject_kind }
 */
export function buildAudioMemory(opts = {}) {
  const transcript = String(opts.transcript ?? '').trim();
  if (!transcript) return null;
  const affect = prosodyToAffect(opts.prosody ?? {});
  return normalizeMemory({
    type: 'episode',
    fact_core: transcript,
    // 语气写进 narrative, 让"怎么说的"也被记住
    narrative: opts.prosody?.tone ? `语气: ${opts.prosody.tone}` : opts.narrative ?? null,
    subject_kind: opts.subject_kind ?? 'user',
    modality: 'audio',
    media_ref: opts.mediaRef ?? null,
    affect,
    importance: opts.importance ?? 5,
  });
}

// ---- IO ----

/** ASR 转写。缺凭证/失败时抛, 由 ingestAudio 兜底降级。 */
export async function transcribeAudio(audioFile, opts = {}) {
  const res = await llm.audio.transcriptions.create({
    model: opts.model ?? 'whisper-1',
    file: audioFile,
  });
  return String(res.text ?? '').trim();
}

/**
 * 摄取一段语音为记忆。
 * @param opts { file?, transcript?, prosody?, mediaRef?, subjectName?, ... }
 * @returns 存入的记忆数组 (失败/无转写时返回 [], 不抛)
 */
export async function ingestAudio(userId, companionId = 'default', opts = {}) {
  let transcript = opts.transcript;
  if (!transcript && opts.file) transcript = await transcribeAudio(opts.file).catch(() => null);
  if (!transcript) return []; // 降级: 转不出文字就不记, 不崩

  const mem = buildAudioMemory({ ...opts, transcript });
  if (!mem) return [];
  return storeMemories(userId, companionId, [mem]);
}

function clamp(x, lo, hi) {
  const n = Number(x);
  return Math.min(hi, Math.max(lo, Number.isNaN(n) ? 0 : n));
}
