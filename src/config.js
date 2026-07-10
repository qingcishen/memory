import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';
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

// ---- 回复模型独立供应商 (可选) ----
// 路线图约定"回复用好模型, 后台杂活用便宜模型"。REPLY_BASE_URL / REPLY_API_KEY
// 任配其一即启用独立客户端 (缺的一项回退主 LLM 的对应值); 都不配则复用主 LLM 客户端,
// 此时 REPLY_MODEL 只是同一供应商下换个模型名 —— 与旧行为完全一致。
export const replyLlm =
  process.env.REPLY_BASE_URL || process.env.REPLY_API_KEY
    ? new OpenAI({
        apiKey: process.env.REPLY_API_KEY || process.env.LLM_API_KEY || 'placeholder',
        baseURL: process.env.REPLY_BASE_URL || process.env.LLM_BASE_URL || 'https://api.deepseek.com',
      })
    : llm;

// ---- Embedding ----
// 可与 LLM 用不同 provider。OpenAI: text-embedding-3-small (1536 维)
export const embedder = new OpenAI({
  apiKey: process.env.EMBED_API_KEY || process.env.LLM_API_KEY || 'placeholder',
  baseURL: process.env.EMBED_BASE_URL || 'https://api.openai.com/v1',
});
export const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
