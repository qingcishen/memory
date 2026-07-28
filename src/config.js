import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import dotenv from 'dotenv';
import {
  createAnthropicChatAdapter,
  isAnthropicApiKey,
} from './providers/anthropicChatAdapter.js';
dotenv.config();

export { PARAMS } from './params.js';

// 占位默认值: 让模块在缺少 .env 时也能安全 import (真正调用才需要真实凭证)
const SB_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SB_KEY = process.env.SUPABASE_KEY || 'placeholder';

// ---- Supabase ----
export const supabase = createClient(SB_URL, SB_KEY);

// ---- LLM (提取 / reflection / 矛盾判断) ----
// DeepSeek 完全兼容 OpenAI SDK: baseURL 填 https://api.deepseek.com
export const llm = new OpenAI({
  apiKey: process.env.LLM_API_KEY || 'placeholder',
  baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
});
export const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
// 编排器回复模型 (好模型, 可与 LLM_MODEL 不同 provider); 未配置时退回 LLM_MODEL。
export const REPLY_MODEL = process.env.REPLY_MODEL || LLM_MODEL;
export const REPLY_PROXY_URL = process.env.REPLY_PROXY_URL || '';
// 部分回复模型 (如 grok-4.5) 默认带隐藏推理链, 哪怕一句"哈哈"也会烧几千 reasoning
// tokens、拖到 20~30s+ 才吐第一个字——闲聊场景用不上这么重的推理。默认调低,
// 需要更强推理时可在 .env 设 REPLY_REASONING_EFFORT=high/medium 覆盖；
// 设为空字符串则完全不传该字段 (给不支持这个参数、传了会报错的供应商用)。
export const REPLY_REASONING_EFFORT =
  process.env.REPLY_REASONING_EFFORT === '' ? '' : process.env.REPLY_REASONING_EFFORT || 'low';
const replyHttpAgent = REPLY_PROXY_URL ? new HttpsProxyAgent(REPLY_PROXY_URL) : undefined;
const replyApiKey = process.env.REPLY_API_KEY || process.env.LLM_API_KEY || 'placeholder';
const replyBaseURL = process.env.REPLY_BASE_URL || process.env.LLM_BASE_URL || 'https://api.deepseek.com';

// ---- 回复模型独立供应商 (可选) ----
// 路线图约定"回复用好模型, 后台杂活用便宜模型"。REPLY_BASE_URL / REPLY_API_KEY
// 任配其一即启用独立客户端 (缺的一项回退主 LLM 的对应值); 都不配则复用主 LLM 客户端,
// 此时 REPLY_MODEL 只是同一供应商下换个模型名 —— 与旧行为完全一致。
export const replyLlm =
  isAnthropicApiKey(replyApiKey)
    ? createAnthropicChatAdapter(new Anthropic({
        apiKey: replyApiKey,
        ...(process.env.REPLY_BASE_URL ? { baseURL: process.env.REPLY_BASE_URL } : {}),
        ...(replyHttpAgent ? { httpAgent: replyHttpAgent } : {}),
      }))
    : process.env.REPLY_BASE_URL || process.env.REPLY_API_KEY
    ? new OpenAI({
        apiKey: replyApiKey,
        baseURL: replyBaseURL,
        ...(replyHttpAgent ? { httpAgent: replyHttpAgent } : {}),
      })
    : replyHttpAgent
      ? new OpenAI({
          apiKey: process.env.LLM_API_KEY || 'placeholder',
          baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
          httpAgent: replyHttpAgent,
        })
      : llm;

// ---- 旁白模型独立供应商 (可选) ----
// 只有显式配置 NARRATION_MODEL 时才启用独立旁白润色；未配置时保持旧链路。
export const NARRATION_MODEL = process.env.NARRATION_MODEL || '';
export const narrationLlm =
  process.env.NARRATION_BASE_URL || process.env.NARRATION_API_KEY
    ? new OpenAI({
        apiKey: process.env.NARRATION_API_KEY || process.env.REPLY_API_KEY || process.env.LLM_API_KEY || 'placeholder',
        baseURL: process.env.NARRATION_BASE_URL || process.env.REPLY_BASE_URL || process.env.LLM_BASE_URL || 'https://api.deepseek.com',
        ...(replyHttpAgent ? { httpAgent: replyHttpAgent } : {}),
      })
    : replyLlm;

// ---- 图片理解模型 (可与回复模型共用火山方舟 VLM) ----
export const VISION_MODEL = process.env.VISION_MODEL || REPLY_MODEL;
export const visionLlm =
  process.env.VISION_BASE_URL || process.env.VISION_API_KEY
    ? new OpenAI({
        apiKey: process.env.VISION_API_KEY || process.env.REPLY_API_KEY || process.env.LLM_API_KEY || 'placeholder',
        baseURL: process.env.VISION_BASE_URL || process.env.REPLY_BASE_URL || process.env.LLM_BASE_URL || 'https://api.deepseek.com',
        ...(replyHttpAgent ? { httpAgent: replyHttpAgent } : {}),
      })
    : replyLlm;

// ---- Embedding ----
// 可与 LLM 用不同 provider。OpenAI: text-embedding-3-small (1536 维)
export const embedder = new OpenAI({
  apiKey: process.env.EMBED_API_KEY || process.env.LLM_API_KEY || 'placeholder',
  baseURL: process.env.EMBED_BASE_URL || 'https://api.openai.com/v1',
});
export const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

// ---- ASR 语音识别 (默认复用 OpenAI Embedding 的供应商与密钥) ----
export const ASR_MODEL = process.env.ASR_MODEL || 'whisper-1';
export const asrLlm = new OpenAI({
  apiKey: process.env.ASR_API_KEY || process.env.EMBED_API_KEY || process.env.LLM_API_KEY || 'placeholder',
  baseURL: process.env.ASR_BASE_URL || process.env.EMBED_BASE_URL || 'https://api.openai.com/v1',
});

// ---- TTS 语音合成 (她给你发语音; 见 src/modal/speech.js) ----
// 显式配置 TTS_MODEL (或独立地址/密钥) 才开启 —— opt-in, 不配则永远纯文字回复;
// 凭证缺省逐级回退 ASR -> Embedding 的 OpenAI 侧, 与 asrLlm 同族。
export const TTS_MODEL = process.env.TTS_MODEL || '';
export const TTS_VOICE = process.env.TTS_VOICE || 'nova';
export const TTS_VOICE_ID = process.env.TTS_VOICE_ID || process.env.TTS_VOICE || 'nova';
export const TTS_VOICE_CLONE_PROVIDER = process.env.TTS_VOICE_CLONE_PROVIDER || '';
export const TTS_VOICE_CLONE_STATUS = process.env.TTS_VOICE_CLONE_STATUS || '';
export const TTS_CONFIGURED = Boolean(process.env.TTS_MODEL);
export const ttsLlm = new OpenAI({
  apiKey: process.env.TTS_API_KEY || process.env.ASR_API_KEY || process.env.EMBED_API_KEY || process.env.LLM_API_KEY || 'placeholder',
  baseURL: process.env.TTS_BASE_URL || process.env.ASR_BASE_URL || process.env.EMBED_BASE_URL || 'https://api.openai.com/v1',
});

// ---- 图片生成 (由 appearance/provider.js 消费) ----
export const IMAGE_BASE_URL = process.env.IMAGE_BASE_URL || '';
// OpenAI 图片模型可直接复用已经配置好的 Embedding API Key，避免同一密钥保存两份。
export const IMAGE_API_KEY = process.env.IMAGE_API_KEY || process.env.EMBED_API_KEY || '';
export const IMAGE_MODEL = process.env.IMAGE_MODEL || '';
export const IMAGE_SIZE = process.env.IMAGE_SIZE || '1024x1536';
export const IMAGE_QUALITY = process.env.IMAGE_QUALITY || 'high';
export const IMAGE_BACKGROUND = process.env.IMAGE_BACKGROUND || 'opaque';
export const IMAGE_OUTPUT_FORMAT = process.env.IMAGE_OUTPUT_FORMAT || 'png';
export const IMAGE_OUTPUT_COMPRESSION = Number.parseInt(process.env.IMAGE_OUTPUT_COMPRESSION || '100', 10);
export const IMAGE_LORA_ID = process.env.IMAGE_LORA_ID || '';
export const IMAGE_LORA_TRIGGER = process.env.IMAGE_LORA_TRIGGER || '';
export const IMAGE_LORA_STATUS = process.env.IMAGE_LORA_STATUS || '';
