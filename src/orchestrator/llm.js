// 编排器 · 默认 LLM 封装 (IO)。
//
// generateReply 用"好模型"(REPLY_MODEL), think 用便宜模型(LLM_MODEL) —— 见编排器设计方案 §7.3。
// 缺凭证时 import 不报错 (config.js 已有占位默认值), 真正调用才需要真实凭证。

import { llm, LLM_MODEL, REPLY_MODEL } from '../config.js';

export class DefaultLLM {
  /** 生成给用户的回复 (好模型, 温度高一点更有人味)。 */
  async generateReply(messages, opts = {}) {
    const res = await llm.chat.completions.create({
      model: opts.model ?? REPLY_MODEL,
      temperature: opts.temperature ?? 0.8,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      messages,
    });
    return res.choices[0].message.content;
  }

  /** 生成不展示的内心独白 (便宜模型)。 */
  async think(context, opts = {}) {
    const res = await llm.chat.completions.create({
      model: opts.model ?? LLM_MODEL,
      temperature: opts.temperature ?? 0.7,
      messages: [
        { role: 'system', content: '你在帮一个 AI 角色生成不会被用户看到的内心想法, 简短直接, 不要客套或解释。' },
        { role: 'user', content: context },
      ],
    });
    return res.choices[0].message.content;
  }
}
