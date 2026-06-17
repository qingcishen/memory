// A1 · 外貌/自拍 · 出图 provider (可插拔)。
//
// 本仓库【不内置真实出图模型】。出图是仓库外基础设施 (Stable Diffusion / ComfyUI / 某图像 API),
// 这里只定义统一接口 + 一个不出真图的 Mock, 让上层(图库/策略/编排)能先跑通闭环。
// 真正接出图时实现 HttpImageProvider.generate 即可; A2 (角色 LoRA 锁脸) 在仓库外训练。
//
// 接口约定: generate(prompt, opts) -> Promise<{ url, seed, meta }>

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

export const defaultImageProvider = new MockImageProvider();
