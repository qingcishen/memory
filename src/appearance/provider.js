// A1 · 外貌/自拍 · 出图 provider (可插拔)。
//
// 本仓库【不内置真实出图模型】。出图是仓库外基础设施 (Stable Diffusion / ComfyUI / 某图像 API),
// 这里只定义统一接口 + 一个不出真图的 Mock, 让上层(图库/策略/编排)能先跑通闭环。
// 支持 OpenAI 兼容的 /images/generations 端点; A2 (角色 LoRA 锁脸) 在仓库外训练。
//
// 接口约定: generate(prompt, opts) -> Promise<{ url, seed, meta }>

import {
  IMAGE_BASE_URL, IMAGE_API_KEY, IMAGE_MODEL, IMAGE_SIZE, IMAGE_QUALITY,
  IMAGE_BACKGROUND, IMAGE_OUTPUT_FORMAT, IMAGE_OUTPUT_COMPRESSION,
  IMAGE_LORA_ID, IMAGE_LORA_TRIGGER, IMAGE_LORA_STATUS,
} from '../config.js';

/** 字符串 → 稳定十六进制短哈希 (给 mock url / seed 用, 可重现)。 */
function hashHex(str = '') {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 不出真图: 返回占位 url, 但结构与真 provider 一致 (seed 可重现, 便于测试与图库去重)。 */
export class MockImageProvider {
  async generate(prompt, opts = {}) {
    const seed = opts.seed != null ? String(opts.seed) : hashHex(prompt);
    return {
      url: `mock://selfie/${hashHex(prompt)}.png`,
      seed,
      meta: { provider: 'mock', prompt },
    };
  }
}

/**
 * 真出图 provider 的形状 (占位实现)。接 ComfyUI / 某图像 API 时填 generate 的真实逻辑:
 * POST 到 endpoint(带 apiKey) → 拿到图 url。未配置 endpoint 时降级回 mock, 保证不崩。
 */
export class HttpImageProvider {
  constructor({ endpoint = null, apiKey = null, fetchImpl = globalThis.fetch } = {}) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this._fallback = new MockImageProvider();
  }

  async generate(prompt, opts = {}) {
    if (!this.endpoint || typeof this.fetchImpl !== 'function') {
      // 未接真实出图后端: 降级到 mock, 不阻断闭环 (接 SD/ComfyUI 时实现下面的真实请求)。
      return this._fallback.generate(prompt, opts);
    }
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ prompt, ...opts }),
    });
    if (!res.ok) throw new Error(`HttpImageProvider 出图失败: ${res.status}`);
    const data = await res.json();
    return { url: data.url, seed: data.seed ?? null, meta: { provider: 'http', prompt } };
  }
}

/** 火山方舟 Seedream 等 OpenAI 兼容图片生成端点。未配置时安全降级到 Mock。 */
export class OpenAIImageProvider {
  constructor({ baseURL = null, apiKey = null, model = null, defaults = {}, fetchImpl = globalThis.fetch } = {}) {
    this.baseURL = String(baseURL ?? '').replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.defaults = defaults;
    this.fetchImpl = fetchImpl;
    this._fallback = new MockImageProvider();
  }

  async generate(prompt, opts = {}) {
    if (!this.baseURL || !this.apiKey || !this.model || typeof this.fetchImpl !== 'function') {
      return this._fallback.generate(prompt, opts);
    }
    const isGptImage = /^gpt-image-/i.test(this.model);
    const settings = { ...this.defaults, ...opts };
    const finalPrompt = withLoraTrigger(prompt, settings);
    const body = {
      model: this.model,
      prompt: finalPrompt,
      // GPT Image 系列直接返回 b64_json；Seedream 等兼容端点可以请求 URL。
      ...(!isGptImage ? { response_format: 'url' } : {}),
      ...(settings.size ? { size: settings.size } : {}),
      ...(isGptImage && settings.quality ? { quality: settings.quality } : {}),
      ...(isGptImage && settings.background ? { background: settings.background } : {}),
      ...(isGptImage && settings.output_format ? { output_format: settings.output_format } : {}),
      ...(isGptImage && settings.output_format !== 'png' && Number.isFinite(settings.output_compression)
        ? { output_compression: Math.max(0, Math.min(100, settings.output_compression)) }
        : {}),
    };
    const res = await this.fetchImpl(`${this.baseURL}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`图片生成失败: ${data?.error?.message || `HTTP ${res.status}`}`);
    const item = data?.data?.[0];
    const mime = settings.output_format === 'jpeg' ? 'image/jpeg' : settings.output_format === 'webp' ? 'image/webp' : 'image/png';
    const url = item?.url || (item?.b64_json ? `data:${mime};base64,${item.b64_json}` : '');
    if (!url) throw new Error('图片生成成功但响应里没有 url 或 b64_json');
    return {
      url,
      seed: item?.seed ?? opts.seed ?? null,
      meta: { provider: 'openai-compatible', model: this.model, prompt: finalPrompt, settings, lora: loraMeta(settings) },
    };
  }

  async edit(prompt, referenceImages = [], opts = {}) {
    if (!this.baseURL || !this.apiKey || !this.model || !referenceImages.length) return this.generate(prompt, opts);
    const settings = { ...this.defaults, ...opts };
    const finalPrompt = withLoraTrigger(prompt, settings);
    const form = new FormData();
    form.set('model', this.model);
    form.set('prompt', finalPrompt);
    // gpt-image-2 的 edits 接口不接受 input_fidelity；旧版 GPT Image
    // 仍可显式传递。按模型能力组装参数，避免整个参考图请求被 400 拒绝。
    if (!/^gpt-image-2(?:$|-)/i.test(this.model) && settings.input_fidelity) {
      form.set('input_fidelity', settings.input_fidelity);
    }
    for (const ref of referenceImages.slice(0, 16)) {
      const bytes = ref.buffer ?? await import('node:fs/promises').then((m) => m.readFile(ref.path));
      form.append('image[]', new Blob([bytes], { type: ref.mime || 'image/png' }), ref.name || 'reference.png');
    }
    if (settings.mask?.buffer) {
      form.set('mask', new Blob([settings.mask.buffer], { type: 'image/png' }), settings.mask.name || 'mask.png');
    }
    for (const key of ['size', 'quality', 'background', 'output_format']) {
      if (settings[key]) form.set(key, String(settings[key]));
    }
    if (settings.output_format !== 'png' && Number.isFinite(settings.output_compression)) {
      form.set('output_compression', String(Math.max(0, Math.min(100, settings.output_compression))));
    }
    const res = await this.fetchImpl(`${this.baseURL}/images/edits`, {
      method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` }, body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`参考图生成失败: ${data?.error?.message || `HTTP ${res.status}`}`);
    const item = data?.data?.[0];
    const mime = settings.output_format === 'jpeg' ? 'image/jpeg' : settings.output_format === 'webp' ? 'image/webp' : 'image/png';
    const url = item?.url || (item?.b64_json ? `data:${mime};base64,${item.b64_json}` : '');
    if (!url) throw new Error('参考图生成成功但响应里没有图片');
    return { url, seed: item?.seed ?? null, meta: { provider: 'openai-compatible-edit', model: this.model, prompt: finalPrompt, settings, referenceCount: referenceImages.length, usage: data?.usage, lora: loraMeta(settings) } };
  }
}

export function withLoraTrigger(prompt, opts = {}) {
  const trigger = String(opts.loraTrigger ?? IMAGE_LORA_TRIGGER ?? '').trim();
  if (!trigger || String(prompt).includes(trigger)) return prompt;
  return `${trigger}, ${prompt}`;
}

export function loraMeta(opts = {}) {
  const id = String(opts.loraId ?? IMAGE_LORA_ID ?? '').trim();
  const trigger = String(opts.loraTrigger ?? IMAGE_LORA_TRIGGER ?? '').trim();
  const status = String(opts.loraStatus ?? IMAGE_LORA_STATUS ?? '').trim();
  return id || trigger || status ? { id, trigger, status } : null;
}

export const defaultImageProvider = IMAGE_BASE_URL && IMAGE_API_KEY && IMAGE_MODEL
  ? new OpenAIImageProvider({
      baseURL: IMAGE_BASE_URL,
      apiKey: IMAGE_API_KEY,
      model: IMAGE_MODEL,
      defaults: {
        size: IMAGE_SIZE,
        quality: IMAGE_QUALITY,
        background: IMAGE_BACKGROUND,
        output_format: IMAGE_OUTPUT_FORMAT,
        output_compression: IMAGE_OUTPUT_COMPRESSION,
        loraId: IMAGE_LORA_ID,
        loraTrigger: IMAGE_LORA_TRIGGER,
        loraStatus: IMAGE_LORA_STATUS,
      },
    })
  : new MockImageProvider();
