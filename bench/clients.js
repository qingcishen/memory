// E 线评测的 LLM IO 封装。judge 走独立凭证 (JUDGE_*), 未配置时退回主 LLM ——
// 但 E2 验收要求 judge 与被评回复模型不同源, 同源时结果里会带 judgeIndependent: false 警示。
// JUDGE_API_KEY 以 sk-ant- 开头时自动走 Anthropic SDK (与 OpenAI 端点完全隔离)。

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';

function isAnthropicKey(key = '') {
  return String(key).startsWith('sk-ant-');
}

function stripCodeBlock(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : text.trim();
}

function makeAnthropicAdapter(apiKey, env) {
  const proxyURL = env.HTTPS_PROXY || env.https_proxy;
  const anthropic = new Anthropic({
    apiKey,
    ...(proxyURL ? { httpAgent: new HttpsProxyAgent(proxyURL) } : {}),
  });
  return {
    chat: {
      completions: {
        create: async ({ model, messages, max_tokens = 1024 }) => {
          const systemMsg = messages.find((m) => m.role === 'system');
          const userMsgs = messages.filter((m) => m.role !== 'system');
          const res = await anthropic.messages.create({
            model,
            max_tokens,
            system: systemMsg?.content ?? '',
            messages: userMsgs.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
          });
          const text = res.content[0]?.text ?? '';
          return {
            choices: [{ message: { content: stripCodeBlock(text) } }],
            usage: { prompt_tokens: res.usage.input_tokens, completion_tokens: res.usage.output_tokens },
          };
        },
      },
    },
  };
}

export function benchClients(env = process.env) {
  const baseURL = env.LLM_BASE_URL || 'https://api.deepseek.com';
  const answer = new OpenAI({ apiKey: env.LLM_API_KEY, baseURL });
  const judgeBaseURL = env.JUDGE_BASE_URL || baseURL;
  const judgeKey = env.JUDGE_API_KEY || env.LLM_API_KEY;
  const judge = isAnthropicKey(judgeKey)
    ? makeAnthropicAdapter(judgeKey, env)
    : new OpenAI({ apiKey: judgeKey, baseURL: judgeBaseURL });
  const answerModel = env.LLM_MODEL || 'deepseek-chat';
  const judgeModel = env.JUDGE_MODEL || env.LLM_MODEL || 'deepseek-chat';
  const answerSource = safeHost(baseURL);
  const judgeSource = isAnthropicKey(judgeKey) ? 'api.anthropic.com' : safeHost(judgeBaseURL);
  return {
    answer,
    answerModel,
    judge,
    judgeModel,
    judgeIndependent: answerSource !== judgeSource || answerModel !== judgeModel,
  };
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return String(value || '');
  }
}

/** 一次 JSON 输出的 chat 调用; 记账进 meter。 */
export async function chatJson(client, model, system, user, { meter = null, maxTokens = 500 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    meter?.addUsage(model, res.usage ?? {});
    try {
      return JSON.parse(res.choices?.[0]?.message?.content || '{}');
    } catch {
      if (attempt === 1) return {};
    }
  }
}

/** 一次纯文本 chat 调用; 记账进 meter。 */
export async function chatText(client, model, system, user, { meter = null, maxTokens = 300 } = {}) {
  const res = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  meter?.addUsage(model, res.usage ?? {});
  return String(res.choices?.[0]?.message?.content ?? '').trim();
}
