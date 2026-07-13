// 编排器 · 默认 LLM 封装 (IO)。
//
// generateReply 用"好模型"(REPLY_MODEL), think 用便宜模型(LLM_MODEL) —— 见编排器设计方案 §7.3。
// 缺凭证时 import 不报错 (config.js 已有占位默认值), 真正调用才需要真实凭证。

import { llm, replyLlm, narrationLlm, LLM_MODEL, REPLY_MODEL, NARRATION_MODEL } from '../config.js';
import { recordLlmCall } from '../metrics.js';

const REPLY_PART_TYPES = ['dialogue', 'narration'];

const REPLY_JSON_INSTRUCTION = `【输出格式·JSON】必须只输出一个 JSON 对象，不要 markdown 代码块，不要 JSON 以外的任何文字。格式: {"parts": [{"type": "dialogue" 或 "narration", "text": "..."}]}。
parts 至少有一个 dialogue part。dialogue 是她说/发出去的话本身；narration 是第三人称动作/神态描写——两者内容不能混在同一个 part 里，动作描写绝不能写进 dialogue 的 text。
她的话默认只用一个 dialogue part；只有偶尔她像真人分几条发消息时（比如一句感叹接一句追问、或说到一半又补一句），才拆成 2-3 个连续的 dialogue part，每个 part 都短，不要为了拆而拆，大多数时候一个就够。
要不要加 narration part、narration 怎么写，按上面的场景旁白指令来；日常场景通常不需要 narration part。`;

function dialoguePart(text) {
  const clean = String(text ?? '').trim();
  return { type: 'dialogue', text: clean || '...' };
}

function normalizeParts(parts, fallbackText = '') {
  const normalized = (Array.isArray(parts) ? parts : [])
    .map((p) => ({
      type: REPLY_PART_TYPES.includes(p?.type) ? p.type : 'dialogue',
      text: String(p?.text ?? '').trim(),
    }))
    .filter((p) => p.text);
  return normalized.length > 0 ? normalized : [dialoguePart(fallbackText)];
}

/**
 * 把回复 LLM 的原始输出规整成合法 parts 数组; 任何解析/校验失败都静默降级成
 * 一个 dialogue part(把原文原样当台词), 绝不抛错、绝不返回空——这是主回复链路,
 * 降级也要保证消息发得出去 (同 src/world/index.js、src/narrative.js 的安全降级约定)。
 */
export function parseReplyParts(rawContent) {
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return [dialoguePart(rawContent)];
  }
  if (!Array.isArray(parsed?.parts)) return [dialoguePart(rawContent)];
  return normalizeParts(parsed.parts, rawContent);
}

/** parts -> 一段字符串(叙述+台词按顺序拼接), 供短期历史/afterReply 使用, 不感知 parts 结构。 */
export function joinReplyParts(parts = []) {
  return (parts ?? [])
    .map((p) => p?.text ?? '')
    .filter((s) => s && s.trim())
    .join('\n\n');
}

/**
 * 兼容两种 LLM 适配器返回:
 * - 旧 mock/旧实现: "一段字符串"
 * - 新实现: { parts } 或 { text, parts }
 * 主链路统一转成 { text, parts }, 避免调用方解构 undefined 后悄悄发不出消息。
 */
export function normalizeReplyResult(result) {
  if (typeof result === 'string') {
    const parts = parseReplyParts(result);
    return { text: joinReplyParts(parts), parts };
  }
  const parts = normalizeParts(result?.parts, result?.text ?? '');
  return { text: joinReplyParts(parts), parts };
}

/** 用独立模型只重写 narration part，dialogue 保持逐字不变。 */
export async function rewriteNarrationParts(parts, messages, { client = narrationLlm, model = NARRATION_MODEL, signal } = {}) {
  const source = normalizeParts(parts);
  const narrationIndexes = source.flatMap((part, index) => part.type === 'narration' ? [index] : []);
  if (!model || narrationIndexes.length === 0) return source;
  try {
    const res = await client.chat.completions.create({
      model,
      temperature: 0.75,
      response_format: { type: 'json_object' },
      messages: [
        ...(messages ?? []),
        { role: 'system', content: '你是专门的旁白作者。根据上下文和场景旁白指令，只润色草稿中 narration 的文字；不改台词、不新增剧情事实、不解释。只输出 JSON: {"narrations":["..."]}，数量必须与草稿中 narration 数量一致。' },
        { role: 'user', content: `请润色这份草稿的旁白：${JSON.stringify({ parts: source })}` },
      ],
    }, { signal });
    recordLlmCall('narration', res.usage);
    const parsed = JSON.parse(res.choices?.[0]?.message?.content || '{}');
    if (!Array.isArray(parsed.narrations) || parsed.narrations.length !== narrationIndexes.length) return source;
    const rewritten = source.map((part) => ({ ...part }));
    narrationIndexes.forEach((index, i) => {
      const text = String(parsed.narrations[i] ?? '').trim();
      if (text) rewritten[index].text = text;
    });
    return rewritten;
  } catch {
    return source;
  }
}

export class DefaultLLM {
  /** 生成给用户的回复 (好模型, 温度高一点更有人味)。返回结构化 { parts }, 旁白/台词分开发消息。 */
  async generateReply(messages, opts = {}) {
    const payload = {
      model: opts.model ?? REPLY_MODEL,
      temperature: opts.temperature ?? 0.8,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      messages: [...messages, { role: 'system', content: REPLY_JSON_INSTRUCTION }],
    };
    let res;
    try {
      res = await replyLlm.chat.completions.create({ ...payload, response_format: { type: 'json_object' } }, { signal: opts.signal });
    } catch (error) {
      if (!looksLikeUnsupportedResponseFormat(error)) throw error;
      res = await replyLlm.chat.completions.create(payload, { signal: opts.signal });
    }
    recordLlmCall('reply', res.usage);
    let content = res.choices[0].message.content;
    // DeepSeek 在 json_object 模式下偶发返回空 content (官方文档已知问题)。
    // 空回复绝不能变成 "..." 发给用户: 退回普通模式重试一次; 若返回的是散文,
    // parseReplyParts 会兜底把它整段当 dialogue part, 消息照样发得出去。
    if (!content || !String(content).trim()) {
      res = await replyLlm.chat.completions.create(payload, { signal: opts.signal });
      recordLlmCall('reply', res.usage);
      content = res.choices[0].message.content;
    }
    const parts = parseReplyParts(content);
    return { parts: await rewriteNarrationParts(parts, messages, { signal: opts.signal }) };
  }

  /** 生成不展示的内心独白 (便宜模型)。串行 await 在正式回复之前, 加 max_tokens 上限防止
   *  模型话痨拖长这一步的生成时间——独白本来就只要一两句话 (见 PARAMS.orchestrator.monologueMaxTokens)。 */
  async think(context, opts = {}) {
    const res = await llm.chat.completions.create({
      model: opts.model ?? LLM_MODEL,
      temperature: opts.temperature ?? 0.7,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      messages: [
        { role: 'system', content: '你在帮一个 AI 角色生成不会被用户看到的内心想法, 简短直接, 不要客套或解释。' },
        { role: 'user', content: context },
      ],
    }, { signal: opts.signal });
    recordLlmCall('think', res.usage);
    return res.choices[0].message.content;
  }
}

function looksLikeUnsupportedResponseFormat(error) {
  const text = [error?.message, error?.code, error?.type, error?.param, error?.cause?.message].filter(Boolean).join(' ');
  return /response_format|json_object|unsupported|not support|不支持/i.test(text);
}
