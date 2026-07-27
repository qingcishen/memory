/**
 * 关系叙事常驻槽：跨会话「我们最近怎样」——短、可注入、可夜间刷新。
 */

import { supabase } from '../config.js';
import { embed } from '../embeddings.js';
import { sanitizeForPrompt } from '../promptSafety.js';

export const RELATIONSHIP_NARRATIVE_KIND = 'relationship_narrative';

/**
 * 启发式合成关系周记（无 LLM）
 */
export function synthesizeRelationshipNarrative(ctx = {}) {
  const stage = ctx.stage || {};
  const rel = ctx.relationship || {};
  const story = ctx.storyBeat || ctx.story?.today;
  const episodes = ctx.episodes || [];
  const bits = [];

  if (stage.label || stage.id) {
    bits.push(`现在你们处在「${stage.label || stage.id}」阶段`);
  }
  const c = Number(rel.closeness);
  const t = Number(rel.tension);
  const d = Number(rel.repair_debt);
  if (Number.isFinite(c)) {
    if (c >= 0.75) bits.push('彼此很亲近');
    else if (c >= 0.45) bits.push('关系在慢慢变近');
    else bits.push('还在熟悉彼此');
  }
  if (Number.isFinite(t) && t >= 0.55) bits.push('最近有点紧绷，说话要小心');
  if (Number.isFinite(d) && d >= 0.25) bits.push('还有没完全和好的地方');
  if (story?.content) bits.push(`她生活里最近有：${String(story.content).slice(0, 40)}`);
  if (episodes[0]) {
    const ep = String(episodes[0].content || episodes[0].fact_core || episodes[0]).slice(0, 50);
    if (ep) bits.push(`记得一段相处：${ep}`);
  }
  if (!bits.length) return '';
  return sanitizeForPrompt(`${bits.join('。')}。`);
}

export function relationshipNarrativeToPrompt(text = '') {
  const t = sanitizeForPrompt(text);
  if (!t) return '';
  // 兼容已带前缀的存储文案
  const body = t.replace(/^【关系周记】\s*/, '');
  return `【我们最近】${body}\n这是关系时间线摘要，接话时自然带连续性即可，不要逐条背诵，不要编造摘要里没有的具体事件。`;
}

/**
 * 从 self 记忆行识别周记
 */
export function isRelationshipNarrativeRow(row = {}) {
  return row?.source?.kind === RELATIONSHIP_NARRATIVE_KIND || /^【关系周记】/.test(String(row?.fact_core || row?.content || ''));
}

/** 读取最新关系周记正文（无则 ''） */
export async function readRelationshipNarrative(userId, companionId = 'default') {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('id,content,fact_core,source')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('subject_kind', 'self')
      .contains('source', { kind: RELATIONSHIP_NARRATIVE_KIND })
      .is('superseded_by', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return '';
    const raw = String(data.content || data.fact_core || '');
    return sanitizeForPrompt(raw.replace(/^【关系周记】\s*/, ''));
  } catch {
    return '';
  }
}

/** 写入/轮换关系周记（失败静默） */
export async function saveRelationshipNarrative(userId, companionId = 'default', text = '') {
  const body = sanitizeForPrompt(String(text || '').replace(/^【关系周记】\s*/, ''));
  if (!body) return null;
  const content = `【关系周记】${body}`;
  try {
    const { data: previous } = await supabase
      .from('memories')
      .select('id')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('subject_kind', 'self')
      .contains('source', { kind: RELATIONSHIP_NARRATIVE_KIND })
      .is('superseded_by', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let vector = null;
    try {
      vector = await embed(content);
    } catch {
      /* 无 embedding 仍可落库 */
    }
    const row = {
      user_id: userId,
      companion_id: companionId,
      type: 'reflection',
      content,
      fact_core: content,
      narrative: body,
      subject_kind: 'self',
      importance: 8,
      emotion: 0.2,
      affect_intensity: 0.25,
      fact_locked: false,
      source: { kind: RELATIONSHIP_NARRATIVE_KIND },
    };
    if (vector) row.embedding = vector;

    const { data, error } = await supabase.from('memories').insert(row).select().single();
    if (error) return null;
    if (previous?.id) {
      await supabase.from('memories').update({ superseded_by: data.id }).eq('id', previous.id).is('superseded_by', null);
    }
    return data;
  } catch {
    return null;
  }
}
