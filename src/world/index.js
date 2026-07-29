// 世界观系统 · 动态世界状态。
//
// 不是写死的设定文档, 而是随对话缓慢演变的背景剧情线(arc) + 氛围基调(atmosphere):
// 平时按当前状态注入 system prompt, 让角色对"我们所处的世界正在发生什么"有连续感;
// 每轮对话后台用 LLM 判断要不要推进 —— 大多数寻常寒暄不推进, 只有对话里出现值得写进
// 背景的进展(换工作/搬家/旅行等)才更新, 避免世界线为一句"在吗"乱跳。
//
// 读取/写入/推进失败都静默降级, 不影响主对话链路 (同 life/emotion 维度的容错约定)。

import { supabase, llm as defaultLlm, LLM_MODEL } from '../config.js';
import { WeatherProvider } from './weather.js';

/**
 * stable_facts: 稳定事实，LLM 不改动，只通过用户配置/对话提取更新。
 * { city?, lat?, lon?, timezone_offset_minutes?, events: [] }
 */
export function defaultStableFacts() {
  return { city: null, lat: null, lon: null, timezone_offset_minutes: null, events: [] };
}

export function normalizeStableFacts(raw) {
  if (!raw || typeof raw !== 'object') return defaultStableFacts();
  return {
    city: raw.city ? String(raw.city).slice(0, 40) : null,
    lat: raw.lat != null ? Number(raw.lat) || null : null,
    lon: raw.lon != null ? Number(raw.lon) || null : null,
    timezone_offset_minutes: raw.timezone_offset_minutes != null ? Number(raw.timezone_offset_minutes) || null : null,
    events: Array.isArray(raw.events) ? raw.events.slice(0, 10).map((e) => ({
      label: String(e.label ?? '').slice(0, 80),
      date: e.date ? String(e.date).slice(0, 20) : null,
    })) : [],
  };
}

export function defaultWorldState() {
  return { arc: '', atmosphere: '', last_event: '', stable_facts: defaultStableFacts(), updated_at: null };
}

export async function readWorldState(userId, companionId = 'default') {
  if (!userId) return defaultWorldState();
  const { data, error } = await supabase
    .from('world_state')
    .select('arc, atmosphere, last_event, stable_facts, updated_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .maybeSingle();
  if (error || !data) return defaultWorldState();
  return {
    arc: data.arc ?? '',
    atmosphere: data.atmosphere ?? '',
    last_event: data.last_event ?? '',
    stable_facts: normalizeStableFacts(data.stable_facts),
    updated_at: data.updated_at ?? null,
  };
}

export async function writeWorldState(userId, companionId = 'default', state) {
  if (!userId) throw new Error('writeWorldState 需要 userId');
  const row = {
    user_id: userId,
    companion_id: companionId,
    arc: state?.arc ?? '',
    atmosphere: state?.atmosphere ?? '',
    last_event: state?.last_event ?? '',
    stable_facts: normalizeStableFacts(state?.stable_facts),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('world_state').upsert(row, { onConflict: 'user_id,companion_id' }).select().single();
  if (error) throw error;
  return { ...defaultWorldState(), ...(data ?? row), stable_facts: normalizeStableFacts((data ?? row).stable_facts) };
}

/** 世界状态 -> 注入用的一段话; 全空 (新用户/世界线还没形成) 返回空串。纯函数。 */
export function toWorldPrompt(state, opts = {}) {
  if (!state) return '';
  const parts = [];
  const sf = normalizeStableFacts(state.stable_facts);
  if (sf.city) parts.push(`所在城市: ${sf.city}`);
  if (sf.events?.length) {
    const upcomingStr = sf.events.map((e) => e.date ? `${e.label}（${e.date}）` : e.label).join('、');
    parts.push(`近期事项: ${upcomingStr}`);
  }
  if (opts.weatherLine) parts.push(opts.weatherLine);
  if (state.atmosphere && state.atmosphere.trim()) parts.push(`当前世界氛围: ${state.atmosphere.trim()}`);
  if (state.arc && state.arc.trim()) parts.push(`背景剧情: ${state.arc.trim()}`);
  if (state.last_event && state.last_event.trim()) parts.push(`最近的进展: ${state.last_event.trim()}`);
  if (parts.length === 0) return '';
  return `${parts.join('\n')}\n结合这些背景自然对话, 别生硬复述设定。`;
}

/** 组装喂给"要不要推进世界线"判断的输入; 纯函数, 可单测。 */
export function composeEvolveInput(state, turns = []) {
  const convo = (turns ?? []).map((t) => `${t.role === 'user' ? '对方' : '她'}: ${t.content}`).join('\n');
  const s = state ?? defaultWorldState();
  return [
    `当前世界状态: 氛围=${s.atmosphere || '(无)'}; 背景剧情=${s.arc || '(无)'}; 最近进展=${s.last_event || '(无)'}`,
    `最近对话:\n${convo || '(无)'}`,
  ].join('\n\n');
}

// 常见城市经纬度预设，供没有显式坐标时按城市名获取天气。
const CITY_COORDS = {
  '北京': { lat: 39.9042, lon: 116.4074 },
  '上海': { lat: 31.2304, lon: 121.4737 },
  '深圳': { lat: 22.5431, lon: 114.0579 },
  '广州': { lat: 23.1291, lon: 113.2644 },
  '武汉': { lat: 30.5928, lon: 114.3055 },
  '成都': { lat: 30.5728, lon: 104.0668 },
  '杭州': { lat: 30.2741, lon: 120.1551 },
  '南京': { lat: 32.0603, lon: 118.7969 },
  '重庆': { lat: 29.5630, lon: 106.5516 },
  '西安': { lat: 34.3416, lon: 108.9398 },
  '长沙': { lat: 28.2282, lon: 112.9388 },
  '苏州': { lat: 31.2989, lon: 120.5853 },
  '天津': { lat: 39.3434, lon: 117.3616 },
  '郑州': { lat: 34.7473, lon: 113.6249 },
};

const EVOLVE_SYS = `你在帮一个 AI 伴侣维护"世界观状态"——她所处世界的背景剧情与氛围基调, 用来让对话有连续感。
大多数日常寒暄不需要推进世界线, 只有对话里出现了值得写进背景的进展(换工作/搬家/旅行/两人关系之外的生活事件等)才更新。
如果这一轮没有这样的进展, 把 changed 设为 false。严格输出 JSON: {"changed": true/false, "arc": "...", "atmosphere": "...", "last_event": "..."}。`;

export class WorldDimension {
  constructor({
    userId,
    companionId = 'default',
    read = readWorldState,
    write = writeWorldState,
    llmClient = defaultLlm,
    model = LLM_MODEL,
    weatherProvider = null,
  } = {}) {
    this.userId = userId;
    this.companionId = companionId;
    this.read = read;
    this.write = write;
    this.llmClient = llmClient;
    this.model = model;
    this._weatherProvider = weatherProvider;
  }

  async current() {
    return this.userId ? this.read(this.userId, this.companionId) : defaultWorldState();
  }

  /**
   * W-3 天气：返回结构化天气对象 { temperature, condition, tempC, desc }。
   * 优先用 weatherProvider（外部注入或按 stable_facts.city 自动创建）；失败时 null。
   */
  async weather() {
    let provider = this._weatherProvider;
    if (!provider) {
      const state = await this.current().catch(() => defaultWorldState());
      const sf = state.stable_facts;
      if (sf?.lat != null && sf?.lon != null) {
        provider = new WeatherProvider({ place: sf.city || '当前城市', lat: sf.lat, lon: sf.lon });
      } else if (sf?.city) {
        // 没有经纬度时用城市名查预设（仅几个常见城市；无预设时返回 null）
        const preset = CITY_COORDS[sf.city];
        if (preset) provider = new WeatherProvider({ place: sf.city, ...preset });
      }
    }
    if (!provider) return null;
    try {
      const raw = await provider.fetch();
      if (!raw) return null;
      return { temperature: raw.tempC, condition: raw.desc, tempC: raw.tempC, desc: raw.desc };
    } catch {
      return null;
    }
  }

  toPrompt(state, opts = {}) {
    return toWorldPrompt(state, opts);
  }

  /**
   * W-1 更新稳定事实（不经 LLM，直接写库）。
   * 用于用户告知城市、配置坐标、或对话中抽取到新 event 时。
   */
  async updateStableFacts(patch = {}) {
    if (!this.userId) return null;
    const state = await this.current().catch(() => defaultWorldState());
    const merged = normalizeStableFacts({ ...state.stable_facts, ...patch });
    const next = { ...state, stable_facts: merged };
    return this.write(this.userId, this.companionId, next).catch(() => null);
  }

  /**
   * 后台判断这一轮要不要推进世界线; 无 userId/无对话内容时跳过。
   * 任何失败(LLM 报错/JSON 解析失败/写库失败)都静默返回 null, 不影响主对话链路。
   */
  async evolve(turns = []) {
    if (!this.userId || !turns?.length) return null;
    const state = await this.current().catch(() => defaultWorldState());
    let res;
    try {
      res = await this.llmClient.chat.completions.create({
        model: this.model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EVOLVE_SYS },
          { role: 'user', content: composeEvolveInput(state, turns) },
        ],
      });
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.choices[0].message.content);
    } catch {
      return null;
    }
    if (!parsed?.changed) return state;
    const next = {
      arc: String(parsed.arc ?? state.arc ?? ''),
      atmosphere: String(parsed.atmosphere ?? state.atmosphere ?? ''),
      last_event: String(parsed.last_event ?? state.last_event ?? ''),
      // W-2: evolve 不改 stable_facts，保持 LLM 不可覆盖的稳定事实。
      stable_facts: state.stable_facts,
    };
    try {
      return await this.write(this.userId, this.companionId, next);
    } catch {
      return null;
    }
  }
}
