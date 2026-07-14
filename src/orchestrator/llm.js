// 编排器 · 默认 LLM 封装 (IO)。
//
// generateReply 用"好模型"(REPLY_MODEL), think 用便宜模型(LLM_MODEL) —— 见编排器设计方案 §7.3。
// 缺凭证时 import 不报错 (config.js 已有占位默认值), 真正调用才需要真实凭证。

import { llm, replyLlm, narrationLlm, LLM_MODEL, REPLY_MODEL, REPLY_REASONING_EFFORT, NARRATION_MODEL } from '../config.js';
import { recordLlmCall } from '../metrics.js';
import { INTIMATE_REPLY_STYLE_LOCK, humanizeReplyParts } from './humanizeReply.js';

const REPLY_PART_TYPES = ['dialogue', 'narration'];

const REPLY_JSON_INSTRUCTION = `【输出格式·JSON】必须只输出一个 JSON 对象，不要 markdown 代码块，不要 JSON 以外的任何文字。格式: {"parts": [{"type": "dialogue" 或 "narration", "text": "..."}]}。
parts 至少有一个 dialogue part。dialogue = 她嘴里说的话；narration = 极短第三人称动作（只写她侧）。两者不能混 part。

【像微信连发·硬性】真人不会永远「你一句、我一整段」。多数轮次请输出 2～3 个短 dialogue part（每条一句人话，像连发两条消息）。
可有 0～1 个短 narration part（插在台词前或中间）。禁止把所有话塞进同一个 dialogue。
【长度】每条 dialogue 尽量 ≤ 25 字；narration ≤ 40 字。禁止旁白比所有台词加起来还长。
【禁止】全名开场、睡衣头发清单、全知代写对方、解剖学流水账、复读「你真的一直想我吗/搂紧别松」。

合格（连发）：
{"parts":[{"type":"narration","text":"腿先夹紧。"},{"type":"dialogue","text":"嗯……"},{"type":"dialogue","text":"慢点。再深一点。"}]}

合格（日常连发）：
{"parts":[{"type":"dialogue","text":"在呢。"},{"type":"dialogue","text":"刚忙完，怎么了？"}]}

不合格：只有一条超长 dialogue 把所有意思说完。`;

/** 日常 plain 模式：首 token 更快；用换行模拟连发，发送层会拆气泡。 */
const REPLY_PLAIN_INSTRUCTION = `【输出格式·纯台词】直接输出她要发出去的话，像微信聊天。
不要 JSON、不要 markdown、不要引号包整段、不要旁白/动作描写、不要「角色名：」前缀。

【像微信连发】多数时候用换行拆成 2～3 行短句（每行一条气泡），不要合成一大段。
例：
在呢。
刚忙完。
怎么了？

极短回应（嗯/好）可以只一行。`;

/**
 * 选择输出格式：亲密/车内/有旁白需求 → json；日常 → plain（更快首包）。
 * @param {{ sceneLocks?, intimacyPhase?, forceFormat?, needNarration? }} ctx
 */
export function pickReplyFormat(ctx = {}) {
  if (ctx.forceFormat === 'json' || ctx.forceFormat === 'plain') return ctx.forceFormat;
  const locks = ctx.sceneLocks || [];
  const phase = ctx.intimacyPhase;
  const intimate =
    locks.some((l) => l?.id === 'intimate' || l?.id === 'car') ||
    ['foreplay', 'peak', 'aftercare', 'flirting'].includes(phase);
  if (intimate || ctx.needNarration) return 'json';
  return 'plain';
}

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

/** 用独立模型压短 narration（不是润色成更文学）；dialogue 保持逐字不变。 */
export async function rewriteNarrationParts(parts, messages, { client = narrationLlm, model = NARRATION_MODEL, signal } = {}) {
  const source = normalizeParts(parts);
  const narrationIndexes = source.flatMap((part, index) => part.type === 'narration' ? [index] : []);
  if (narrationIndexes.length === 0) return source;
  if (!model) return humanizeReplyParts(source, { intimacyPhase: 'peak' });
  try {
    const res = await client.chat.completions.create({
      model,
      temperature: 0.55,
      max_tokens: 180,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '你是旁白压缩器，不是文学家。把每条 narration 压成 1～2 句、≤70 字的真人身体反应：只写她侧因果（被碰到→怎么变）。' +
            '禁止：姓名开场、散着头发/丝质睡衣/半敞/往怀里嵌/耳尖微热、全知写对方、解剖学流水账、加长原文。' +
            '若原文已短且合格可几乎原样。只输出 JSON: {"narrations":["..."]}，数量必须与草稿中 narration 数量一致。不改台词。',
        },
        { role: 'user', content: `压缩这些旁白：${JSON.stringify({ narrations: narrationIndexes.map((i) => source[i].text) })}` },
      ],
    }, { signal });
    recordLlmCall('narration', res.usage);
    const parsed = JSON.parse(res.choices?.[0]?.message?.content || '{}');
    if (!Array.isArray(parsed.narrations) || parsed.narrations.length !== narrationIndexes.length) {
      return humanizeReplyParts(source, { intimacyPhase: 'peak' });
    }
    const rewritten = source.map((part) => ({ ...part }));
    narrationIndexes.forEach((index, i) => {
      const text = String(parsed.narrations[i] ?? '').trim();
      if (text) rewritten[index].text = text;
    });
    return humanizeReplyParts(rewritten, { intimacyPhase: 'peak' });
  } catch {
    return humanizeReplyParts(source, { intimacyPhase: 'peak' });
  }
}

export class DefaultLLM {
  /** 生成给用户的回复 (好模型, 温度高一点更有人味)。返回结构化 { parts }, 旁白/台词分开发消息。 */
  async generateReply(messages, opts = {}) {
    const format = opts.format === 'plain' ? 'plain' : 'json';
    const payload = buildReplyPayload(messages, { ...opts, format });
    let res;
    if (format === 'json') {
      try {
        res = await replyLlm.chat.completions.create({ ...payload, response_format: { type: 'json_object' } }, { signal: opts.signal });
      } catch (error) {
        if (!looksLikeUnsupportedResponseFormat(error)) throw error;
        res = await replyLlm.chat.completions.create(payload, { signal: opts.signal });
      }
    } else {
      res = await replyLlm.chat.completions.create(payload, { signal: opts.signal });
    }
    recordLlmCall('reply', res.usage);
    let content = res.choices[0].message.content;
    // DeepSeek 在 json_object 模式下偶发返回空 content (官方文档已知问题)。
    if (!content || !String(content).trim()) {
      res = await replyLlm.chat.completions.create(payload, { signal: opts.signal });
      recordLlmCall('reply', res.usage);
      content = res.choices[0].message.content;
    }
    let parts = format === 'plain' ? [dialoguePart(content)] : parseReplyParts(content);
    if (format === 'json') {
      parts = await rewriteNarrationParts(parts, messages, { signal: opts.signal });
      // 再压一遍，防止旁白模型失败或未配置时仍放出网文腔
      parts = humanizeReplyParts(parts, {
        intimacyPhase: opts.intimateStyleLock ? 'peak' : null,
      });
    }
    return { parts, format };
  }

  /**
   * 流式回复：边生成边 yield。
   * format=plain（日常）首 token 更快；format=json（亲密）支持旁白。
   * 事件: delta | preview | done
   */
  async *generateReplyStream(messages, opts = {}) {
    const format = opts.format === 'plain' ? 'plain' : 'json';
    const payload = { ...buildReplyPayload(messages, { ...opts, format }), stream: true };
    let raw = '';
    try {
      let stream;
      if (format === 'json') {
        try {
          stream = await replyLlm.chat.completions.create(
            { ...payload, response_format: { type: 'json_object' } },
            { signal: opts.signal },
          );
        } catch (error) {
          if (!looksLikeUnsupportedResponseFormat(error)) throw error;
          stream = await replyLlm.chat.completions.create(payload, { signal: opts.signal });
        }
      } else {
        stream = await replyLlm.chat.completions.create(payload, { signal: opts.signal });
      }

      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.text ?? '';
        if (!delta) continue;
        raw += delta;
        yield { event: 'delta', text: delta, format };
        const preview =
          format === 'plain' ? raw.trim() : extractStreamingDialoguePreview(raw);
        if (preview) yield { event: 'preview', text: preview, format };
      }
      recordLlmCall('reply', undefined);
    } catch {
      const full = await this.generateReply(messages, { ...opts, stream: false, format });
      const text = joinReplyParts(full.parts);
      yield { event: 'preview', text, format };
      yield { event: 'done', parts: full.parts, text, raw: text, streamed: false, format };
      return;
    }

    if (!raw.trim()) {
      const full = await this.generateReply(messages, { ...opts, stream: false, format });
      const text = joinReplyParts(full.parts);
      yield { event: 'done', parts: full.parts, text, raw: text, streamed: false, format };
      return;
    }

    let parts = format === 'plain' ? [dialoguePart(raw)] : parseReplyParts(raw);
    if (format === 'json') {
      parts = await rewriteNarrationParts(parts, messages, { signal: opts.signal });
    }
    const text = joinReplyParts(parts);
    yield { event: 'done', parts, text, raw, streamed: true, format };
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

function buildReplyPayload(messages, opts = {}) {
  const format = opts.format === 'plain' ? 'plain' : 'json';
  const instruction = format === 'plain' ? REPLY_PLAIN_INSTRUCTION : REPLY_JSON_INSTRUCTION;
  const reasoningEffort = opts.reasoningEffort ?? REPLY_REASONING_EFFORT;
  const msgs = [...messages, { role: 'system', content: instruction }];
  // 亲密场景追加 few-shot 硬锁（最后一条 system 权重更高）
  if (format === 'json' && opts.intimateStyleLock !== false) {
    msgs.push({ role: 'system', content: INTIMATE_REPLY_STYLE_LOCK });
  }
  return {
    model: opts.model ?? REPLY_MODEL,
    temperature: opts.temperature ?? 0.78,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    messages: msgs,
  };
}

function looksLikeUnsupportedResponseFormat(error) {
  const text = [error?.message, error?.code, error?.type, error?.param, error?.cause?.message].filter(Boolean).join(' ');
  return /response_format|json_object|unsupported|not support|不支持/i.test(text);
}

/**
 * 从半截 JSON 流里抠 dialogue text 预览（启发式，失败返回 ''）。
 * 优先取最后一个 "type":"dialogue" 附近的 "text":"..."。
 */
export function extractStreamingDialoguePreview(buffer = '') {
  const s = String(buffer || '');
  if (!s.trim()) return '';
  // 完整可解析
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed?.parts)) {
      const dialogues = parsed.parts.filter((p) => p?.type === 'dialogue' && p.text);
      if (dialogues.length) return dialogues.map((p) => p.text).join('\n');
    }
  } catch {
    /* partial */
  }
  // 半截：抓 "text":"..." 片段（反斜杠转义粗处理）
  const texts = [];
  const re = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    try {
      texts.push(JSON.parse(`"${m[1]}"`));
    } catch {
      texts.push(m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    }
  }
  if (texts.length) return texts.join('\n');
  // 纯散文流
  if (!s.includes('{') && s.trim().length > 0) return s.trim();
  return '';
}
