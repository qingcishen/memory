// S1 · 生活叙事引擎地基：固定卡司、持久化故事线、K1 图谱接入。
import { supabase, llm as defaultLlm, LLM_MODEL, PARAMS } from '../config.js';
import { normalizeEntityKey, normalizeRelation } from '../knowledge/extract.js';
import { upsertEntities, upsertRelations } from '../knowledge/store.js';
import { sanitizeForPrompt } from '../promptSafety.js';
import { updateFromTurn } from '../state/affect.js';
import { readWorldState, writeWorldState } from '../world/index.js';

export const STORY_STAGES = ['setup', 'rising', 'climax', 'cooldown', 'closed'];

export function normalizeCast(cast = []) {
  const seen = new Set();
  return (cast ?? []).map((member) => ({
    name: String(member?.name ?? '').trim(), role: String(member?.role ?? '').trim() || 'acquaintance',
    closeness: clamp(Number(member?.closeness) || 0, 0, 1), entityId: member?.entityId ?? null,
  })).filter((member) => member.name && !seen.has(member.name) && seen.add(member.name));
}

export function normalizeStoryline(line = {}, index = 0) {
  const stage = STORY_STAGES.includes(line?.stage) ? line.stage : 'setup';
  return {
    id: String(line?.id ?? `story-${index + 1}`), title: String(line?.title ?? '').trim(), stage,
    mood_link: clamp(Number(line?.mood_link) || 0, -1, 1), last_beat: String(line?.last_beat ?? '').trim(),
    next_beat_hint: String(line?.next_beat_hint ?? '').trim(), last_beat_at: line?.last_beat_at ?? null,
    beats_day: line?.beats_day ?? null, beats_today: Math.max(0, Math.floor(Number(line?.beats_today) || 0)),
    beat_shared_at: line?.beat_shared_at ?? null, last_beat_sharing: clamp(Number(line?.last_beat_sharing) || 0, 0, 1),
  };
}

export function toStoryPrompt(snapshot, { cast = [], forceToday = false } = {}) {
  const lines = snapshot?.lines ?? [];
  if (!lines.length && !snapshot?.today) return '';
  const active = lines
    .filter((line) => line.stage !== 'closed')
    .map((line) => `- ${line.title}（${line.stage}）${line.last_beat ? `：${line.last_beat}` : ''}`);
  const todayRaw = snapshot?.today?.content ?? snapshot?.today;
  const today = todayRaw
    ? `\n【今天必知】${typeof todayRaw === 'string' ? todayRaw : snapshot.today.content}——被问「今天/最近/在忙什么」时优先从这里答，像她自己的生活，不要说「剧情线」。`
    : '';
  const castLine =
    Array.isArray(cast) && cast.length
      ? `\n配角名字固定：${cast.map((m) => m.name).filter(Boolean).slice(0, 6).join('、')}——禁止改名或换人。`
      : '';
  const force =
    forceToday && todayRaw
      ? '\n本轮若对方聊近况或闲聊开口，至少轻轻带一点今天的生活碎片，别整轮只客服式接话。'
      : '';
  return `【她最近的生活】\n${active.join('\n')}${today}${castLine}${force}\n这些是连续发生的生活，不要像念设定；上周的事这周可以有下文。`;
}

export function nextStoryStage(stage, requested = null) {
  const next = { setup: 'rising', rising: 'climax', climax: 'cooldown', cooldown: 'closed', closed: 'closed' }[stage] ?? 'setup';
  return requested === stage || requested === next ? requested : next;
}

export function composeTickPrompt(line, cast = [], facts = []) {
  const castFacts = cast.map((m) => `${m.name}：${m.role}，亲近度约 ${m.closeness}`).join('\n') || '(无固定卡司)';
  return [
    `故事线：${line.title}\n阶段：${line.stage}\n上一拍：${line.last_beat || '(刚开始)'}\n下一拍提示：${line.next_beat_hint || '(自然推进)'}`,
    `不可更改的卡司事实：\n${castFacts}`,
    `相关固定事实与边界：\n${facts.join('\n') || '(无额外事实)'}`,
    '生成今天发生的一小拍，必须延续上一拍且不改变人物姓名、身份、关系和项目硬事实。没有事实支持的金额、合同、客户真名、人员任免或重大结果一律不要编造。不要涉及用户与她之间未发生的共同经历。',
  ].join('\n\n');
}

export class StoryEngine {
  constructor({ userId, companionId = 'default', companionName = '她', cast = [], lines = [], client = supabase, entityWriter = upsertEntities, relationWriter = upsertRelations, llmClient = defaultLlm, model = LLM_MODEL, memory = null, desire = null, affectUpdater = updateFromTurn, worldRead = readWorldState, worldWrite = writeWorldState, factProvider = null, onStoryBeat = null } = {}) {
    Object.assign(this, { userId, companionId, companionName, client, entityWriter, relationWriter, llmClient, model, memory, desire, affectUpdater, worldRead, worldWrite, factProvider, onStoryBeat });
    this.castSeed = normalizeCast(cast);
    this.lineSeeds = (lines ?? []).map(normalizeStoryline).filter((line) => line.title);
    this.entityIds = new Map();
  }

  cast() { return this.castSeed.map((member) => ({ ...member, entityId: this.entityIds.get(normalizeEntityKey(member.name)) ?? member.entityId })); }

  async seed() {
    if (!this.userId) return { cast: 0, lines: 0 };
    const castCount = await this.seedCast().catch(() => 0);
    if (this.lineSeeds.length) {
      const rows = this.lineSeeds.map((line) => ({
        user_id: this.userId, companion_id: this.companionId, storyline_key: line.id, title: line.title,
        stage: line.stage, mood_link: line.mood_link, last_beat: line.last_beat, next_beat_hint: line.next_beat_hint,
      }));
      const { error } = await this.client.from('story_lines').upsert(rows, { onConflict: 'user_id,companion_id,storyline_key', ignoreDuplicates: true });
      if (error) throw error;
    }
    return { cast: castCount, lines: this.lineSeeds.length };
  }

  async seedCast() {
    if (!this.castSeed.length) return 0;
    const companionKey = normalizeEntityKey(this.companionName);
    const entities = [
      { key: companionKey, name: this.companionName, type: 'person', aliases: [] },
      ...this.castSeed.map((member) => ({ key: normalizeEntityKey(member.name), name: member.name, type: 'person', aliases: [] })),
    ];
    const ids = await this.entityWriter(this.userId, this.companionId, entities);
    this.entityIds = ids;
    const relations = this.castSeed.map((member) => ({
      sourceKey: companionKey, targetKey: normalizeEntityKey(member.name),
      relation: normalizeRelation(`${member.role}_of`) ?? 'knows', confidence: Math.max(0.7, member.closeness),
      evidence: `固定卡司：${member.name}是${this.companionName}的${member.role}`,
    }));
    return this.relationWriter(this.userId, this.companionId, relations, ids);
  }

  async current(now = Date.now()) {
    if (!this.userId) return { lines: this.lineSeeds, today: null };
    const { data, error } = await this.client.from('story_lines').select('storyline_key,title,stage,mood_link,last_beat,next_beat_hint,last_beat_at,beats_day,beats_today,beat_shared_at,last_beat_sharing,updated_at').eq('user_id', this.userId).eq('companion_id', this.companionId).order('updated_at', { ascending: false });
    if (error) throw error;
    const lines = (data ?? []).map((row) => normalizeStoryline({ ...row, id: row.storyline_key }));
    const day = new Date(now).toISOString().slice(0, 10);
    const latest = lines.find((line) => line.last_beat_at && String(line.last_beat_at).slice(0, 10) === day);
    const today = latest ? { storylineId: latest.id, title: latest.title, content: latest.last_beat, mood_link: latest.mood_link, created_at: latest.last_beat_at } : null;
    return { lines, today };
  }

  toPrompt(snapshot, opts = {}) {
    return toStoryPrompt(snapshot, { cast: this.castSeed, ...opts });
  }

  async pendingShare(now = Date.now()) {
    const { lines } = await this.current(now);
    const pending = lines.find((line) => line.last_beat_at && (!line.beat_shared_at || new Date(line.beat_shared_at).getTime() < new Date(line.last_beat_at).getTime()));
    return pending ? { storylineId: pending.id, title: pending.title, content: pending.last_beat, mood_link: pending.mood_link, sharing: pending.last_beat_sharing, created_at: pending.last_beat_at } : null;
  }

  async markShared(beat, now = Date.now()) {
    if (!beat?.storylineId) return false;
    const sharedAt = new Date(now).toISOString();
    const { error } = await this.client.from('story_lines').update({ beat_shared_at: sharedAt }).eq('user_id', this.userId).eq('companion_id', this.companionId).eq('storyline_key', beat.storylineId);
    if (error) throw error;
    await this.desire?.accumulate?.({ sharing: -Math.max(0.35, Number(beat.sharing) || 0.5) });
    return true;
  }

  async tick({ now = Date.now(), state = null, storylineIds = null } = {}) {
    if (!this.userId) return null;
    const snapshot = await this.current(now).catch(() => ({ lines: [] }));
    const allowed = Array.isArray(storylineIds) && storylineIds.length
      ? new Set(storylineIds.map(String))
      : null;
    const active = snapshot.lines
      .filter((line) => line.stage !== 'closed' && (!allowed || allowed.has(line.id)))
      .slice(0, PARAMS.story.maxActiveLines);
    if (!active.length) return null;
    const day = new Date(now).toISOString().slice(0, 10);
    const line = active.find((item) => item.beats_day !== day || item.beats_today < PARAMS.story.beatsPerDay);
    if (!line) return null;
    const facts = this.factProvider ? await this.factProvider(line).catch(() => []) : this.castSeed.map((m) => `${this.companionName} —${normalizeRelation(`${m.role}_of`)}→ ${m.name}`);
    let response;
    try {
      response = await this.llmClient.chat.completions.create({
        model: this.model, temperature: 0.2, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你负责推进 AI 伴侣的连续生活故事。严格输出 JSON：{"content":"今天发生的具体小进展","next_stage":"rising","next_beat_hint":"下一拍提示","mood_link":-0.2,"sharing":0.5}。content 只写她生活中真实可记的一件事；mood_link 范围 -1..1；sharing 范围 0..1。' },
          { role: 'user', content: composeTickPrompt(line, this.castSeed, facts) },
        ],
      });
    } catch { return null; }
    let parsed;
    try { parsed = JSON.parse(response.choices[0].message.content); } catch { return null; }
    const content = sanitizeForPrompt(parsed?.content);
    if (!content || content.startsWith('[内容含可疑')) return null;
    const beat = {
      storylineId: line.id, title: line.title, content,
      stage: nextStoryStage(line.stage, parsed?.next_stage),
      mood_link: clamp(Number(parsed?.mood_link ?? line.mood_link) || 0, -1, 1),
      sharing: clamp(Number(parsed?.sharing) || 0.5, 0, 1), created_at: new Date(now).toISOString(),
    };
    const nextHint = sanitizeForPrompt(parsed?.next_beat_hint) || line.next_beat_hint;
    const beatsToday = line.beats_day === day ? line.beats_today + 1 : 1;
    const { error } = await this.client.from('story_lines').update({ stage: beat.stage, mood_link: beat.mood_link, last_beat: beat.content, next_beat_hint: nextHint, last_beat_at: beat.created_at, last_beat_sharing: beat.sharing, beat_shared_at: null, beats_day: day, beats_today: beatsToday, updated_at: beat.created_at }).eq('user_id', this.userId).eq('companion_id', this.companionId).eq('storyline_key', line.id);
    if (error) return null;
    await this.applyBeat(beat, state).catch(() => {});
    return beat;
  }

  async applyBeat(beat, state) {
    await Promise.allSettled([
      this.memory?.recordSelfEvent?.(`${beat.title}：${beat.content}`, { importance: 5, valence: beat.mood_link, intensity: Math.max(0.35, Math.abs(beat.mood_link)) }),
      this.desire?.accumulate?.({ sharing: beat.sharing, comfort: beat.mood_link < 0 ? Math.abs(beat.mood_link) * 0.5 : 0 }),
      this.affectUpdater?.(this.userId, this.companionId, [], { useLLM: false, extraDeltas: { mood: { valence: beat.mood_link * 0.35, arousal: Math.abs(beat.mood_link) * 0.15 } } }),
      this.updateWorld(beat),
      // L5：故事拍软种子情绪残留（编排器注入 onStoryBeat 时）
      typeof this.onStoryBeat === 'function' ? Promise.resolve(this.onStoryBeat(beat)) : null,
    ].filter(Boolean));
  }

  async updateWorld(beat) {
    const world = await this.worldRead(this.userId, this.companionId).catch(() => ({}));
    return this.worldWrite(this.userId, this.companionId, { ...world, arc: `${beat.title}：${beat.content}`, last_event: beat.content, atmosphere: world?.atmosphere ?? '' });
  }
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
