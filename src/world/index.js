// 世界观系统 · 动态世界状态。
//
// 不是写死的设定文档, 而是随对话缓慢演变的背景剧情线(arc) + 氛围基调(atmosphere):
// 平时按当前状态注入 system prompt, 让角色对"我们所处的世界正在发生什么"有连续感;
// 每轮对话后台用 LLM 判断要不要推进 —— 大多数寻常寒暄不推进, 只有对话里出现值得写进
// 背景的进展(换工作/搬家/旅行等)才更新, 避免世界线为一句"在吗"乱跳。
//
// 读取/写入/推进失败都静默降级, 不影响主对话链路 (同 life/emotion 维度的容错约定)。

import { supabase, llm as defaultLlm, LLM_MODEL } from '../config.js';

export function defaultWorldState() {
  return { arc: '', atmosphere: '', last_event: '', updated_at: null };
}

export async function readWorldState(userId, companionId = 'default') {
  if (!userId) return defaultWorldState();
  const { data, error } = await supabase
    .from('world_state')
    .select('arc, atmosphere, last_event, updated_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .maybeSingle();
  if (error || !data) return defaultWorldState();
  return {
    arc: data.arc ?? '',
    atmosphere: data.atmosphere ?? '',
    last_event: data.last_event ?? '',
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
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('world_state').upsert(row, { onConflict: 'user_id,companion_id' }).select().single();
  if (error) throw error;
  return data ?? row;
}

/** 世界状态 -> 注入用的一段话; 全空 (新用户/世界线还没形成) 返回空串。纯函数。 */
export function toWorldPrompt(state) {
  if (!state) return '';
  const parts = [];
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
  } = {}) {
    this.userId = userId;
    this.companionId = companionId;
    this.read = read;
    this.write = write;
    this.llmClient = llmClient;
    this.model = model;
  }

  async current() {
    return this.userId ? this.read(this.userId, this.companionId) : defaultWorldState();
  }

  toPrompt(state) {
    return toWorldPrompt(state);
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
    };
    try {
      return await this.write(this.userId, this.companionId, next);
    } catch {
      return null;
    }
  }
}
