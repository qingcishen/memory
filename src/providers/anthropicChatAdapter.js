/**
 * 把 Anthropic Messages API 收敛到项目现有的 OpenAI chat.completions 最小契约。
 * 仅覆盖当前调用方使用的 text、usage、AbortSignal 与 text streaming。
 */
export function isAnthropicApiKey(key = '') {
  return String(key).startsWith('sk-ant-');
}

export function createAnthropicChatAdapter(client, { defaultMaxTokens = 1024 } = {}) {
  if (!client?.messages?.create) {
    throw new Error('Anthropic adapter requires client.messages.create');
  }
  return {
    provider: 'anthropic',
    chat: {
      completions: {
        async create(payload = {}, requestOptions = {}) {
          const request = toAnthropicRequest(payload, defaultMaxTokens);
          const response = await client.messages.create(
            request,
            requestOptions?.signal ? { signal: requestOptions.signal } : undefined,
          );
          if (payload.stream) return adaptAnthropicStream(response);
          return adaptAnthropicResponse(response);
        },
      },
    },
  };
}

export function toAnthropicRequest(payload = {}, defaultMaxTokens = 1024) {
  const { system, messages } = splitAnthropicMessages(payload.messages);
  return {
    model: payload.model,
    max_tokens: positiveInteger(payload.max_tokens, defaultMaxTokens),
    ...(Number.isFinite(payload.temperature) ? { temperature: payload.temperature } : {}),
    ...(system ? { system } : {}),
    messages,
    ...(payload.stream ? { stream: true } : {}),
  };
}

function splitAnthropicMessages(messages = []) {
  const system = [];
  const conversational = [];
  for (const message of messages ?? []) {
    if (message?.role === 'system') {
      const text = contentText(message.content);
      if (text) system.push(text);
      continue;
    }
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const content = normalizeContent(message?.content);
    const previous = conversational.at(-1);
    if (previous?.role === role) {
      previous.content = mergeContent(previous.content, content);
    } else {
      conversational.push({ role, content });
    }
  }
  if (conversational.length === 0) {
    conversational.push({ role: 'user', content: '请按系统指令回复。' });
  }
  return { system: system.join('\n\n'), messages: conversational };
}

function adaptAnthropicResponse(response = {}) {
  return {
    choices: [{ message: { content: contentText(response.content) } }],
    usage: normalizeUsage(response.usage),
    model: response.model,
  };
}

async function* adaptAnthropicStream(stream) {
  let inputTokens = 0;
  let outputTokens = 0;
  for await (const event of stream) {
    if (event?.type === 'message_start') {
      inputTokens = Number(event.message?.usage?.input_tokens) || inputTokens;
      outputTokens = Number(event.message?.usage?.output_tokens) || outputTokens;
      continue;
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield { choices: [{ delta: { content: event.delta.text ?? '' } }] };
      continue;
    }
    if (event?.type === 'message_delta') {
      outputTokens = Number(event.usage?.output_tokens) || outputTokens;
    }
  }
  yield {
    choices: [],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
    },
  };
}

function normalizeUsage(usage = {}) {
  return {
    prompt_tokens: Number(usage.input_tokens) || 0,
    completion_tokens: Number(usage.output_tokens) || 0,
  };
}

function normalizeContent(content) {
  if (Array.isArray(content)) return content;
  return String(content ?? '');
}

function mergeContent(left, right) {
  if (typeof left === 'string' && typeof right === 'string') return `${left}\n\n${right}`;
  return [...asBlocks(left), ...asBlocks(right)];
}

function asBlocks(content) {
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: String(content ?? '') }];
}

function contentText(content) {
  if (typeof content === 'string') return content.trim();
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text' && block.text)
    .map((block) => block.text)
    .join('')
    .trim();
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
