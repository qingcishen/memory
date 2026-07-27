// U1 · “她眼中的你”用户画像。画像是她的主观看法，因此存为特殊 self reflection。
import { supabase, llm as defaultLlm, LLM_MODEL } from './config.js';
import { embed } from './embeddings.js';
import { sanitizeForPrompt } from './promptSafety.js';

export const USER_PROFILE_KIND = 'user_profile';

export function normalizeUserProfile(value = {}) {
  const list = (items, max = 8) => [...new Set((Array.isArray(items) ? items : []).map((v) => sanitizeForPrompt(v)).filter(Boolean))].slice(0, max);
  return {
    summary: sanitizeForPrompt(value?.summary).slice(0, 240),
    habits: list(value?.habits),
    sensitivities: list(value?.sensitivities),
    importantPeople: list(value?.importantPeople),
    needs: list(value?.needs),
  };
}

export function profileToText(profile) {
  const p = normalizeUserProfile(profile);
  const parts = [];
  if (p.summary) parts.push(`总体印象：${p.summary}`);
  if (p.habits.length) parts.push(`习惯：${p.habits.join('；')}`);
  if (p.sensitivities.length) parts.push(`在意和雷点：${p.sensitivities.join('；')}`);
  if (p.importantPeople.length) parts.push(`重要的人：${p.importantPeople.join('；')}`);
  if (p.needs.length) parts.push(`相处时需要留意：${p.needs.join('；')}`);
  return parts.join('\n');
}

export function formatUserProfilePrompt(profileOrText) {
  const text = typeof profileOrText === 'string' ? sanitizeForPrompt(profileOrText) : profileToText(profileOrText);
  return text ? `【她眼中的你】\n${text}\n这是她基于长期相处形成的主观看法；自然体现理解，不要逐项背诵，也不要把推测说成绝对事实。` : '';
}

export async function updateUserProfile(userId, companionId = 'default', opts = {}) {
  const loadMemories = opts.loadMemories ?? defaultLoadMemories;
  const loadPrevious = opts.loadPrevious ?? defaultLoadPrevious;
  const saveProfile = opts.saveProfile ?? defaultSaveProfile;
  const llmClient = opts.llmClient ?? defaultLlm;
  const [memories, previous] = await Promise.all([loadMemories(userId, companionId, opts.recent ?? 80), loadPrevious(userId, companionId)]);
  if (!memories?.length) return null;
  const evidence = memories.map((m) => `- ${sanitizeForPrompt(m.fact_core || m.content)}`).filter((line) => line !== '- ').join('\n');
  const old = previous?.content ? `\n上一版画像（可修正，不必照抄）：\n${sanitizeForPrompt(previous.content)}` : '';
  let response;
  try {
    response = await llmClient.chat.completions.create({
      model: opts.model ?? LLM_MODEL, temperature: 0.2, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '根据长期记忆维护“她眼中的对方”。只提炼有证据、对相处有用的稳定观察；不要编造身份和经历。严格输出 JSON：{"summary":"总体印象","habits":[],"sensitivities":[],"importantPeople":[],"needs":[]}。' },
        { role: 'user', content: `${evidence}${old}` },
      ],
    });
  } catch { return null; }
  let profile;
  try { profile = normalizeUserProfile(JSON.parse(response.choices[0].message.content)); } catch { return null; }
  const content = profileToText(profile);
  if (!content) return null;
  return saveProfile(userId, companionId, { profile, content, previous });
}

async function defaultLoadMemories(userId, companionId, limit) {
  const { data, error } = await supabase.from('memories').select('fact_core,content,subject_kind,importance,created_at').eq('user_id', userId).eq('companion_id', companionId).in('subject_kind', ['user', 'dyad']).is('superseded_by', null).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

async function defaultLoadPrevious(userId, companionId) {
  const { data, error } = await supabase.from('memories').select('id,content').eq('user_id', userId).eq('companion_id', companionId).eq('subject_kind', 'self').contains('source', { kind: USER_PROFILE_KIND }).is('superseded_by', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return null;
  return data;
}

async function defaultSaveProfile(userId, companionId, { content, previous }) {
  const vector = await embed(content);
  const { data, error } = await supabase.from('memories').insert({
    user_id: userId, companion_id: companionId, type: 'reflection', content, fact_core: content,
    narrative: content, subject_kind: 'self', importance: 10, emotion: 0.3, affect_intensity: 0.3,
    fact_locked: false, embedding: vector, source: { kind: USER_PROFILE_KIND },
  }).select().single();
  if (error) throw error;
  if (previous?.id) await supabase.from('memories').update({ superseded_by: data.id }).eq('id', previous.id).is('superseded_by', null);
  return data;
}

export async function readUserProfilePrompt(userId, companionId = 'default') {
  const row = await defaultLoadPrevious(userId, companionId);
  return formatUserProfilePrompt(row?.content ?? '');
}
