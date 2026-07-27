// E 线评测的 LLM IO 封装。judge 走独立凭证 (JUDGE_*), 未配置时退回主 LLM ——
// 但 E2 验收要求 judge 与被评回复模型不同源, 同源时结果里会带 judgeIndependent: false 警示。

import OpenAI from 'openai';

export function benchClients(env = process.env) {
  const baseURL = env.LLM_BASE_URL || 'https://api.deepseek.com';
  const answer = new OpenAI({ apiKey: env.LLM_API_KEY, baseURL });
  const judgeBaseURL = env.JUDGE_BASE_URL || baseURL;
  const judge = new OpenAI({ apiKey: env.JUDGE_API_KEY || env.LLM_API_KEY, baseURL: judgeBaseURL });
  const answerModel = env.LLM_MODEL || 'deepseek-chat';
  const judgeModel = env.JUDGE_MODEL || env.LLM_MODEL || 'deepseek-chat';
  const answerSource = safeHost(baseURL);
  const judgeSource = safeHost(judgeBaseURL);
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
