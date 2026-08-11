import { llm, LLM_MODEL, PARAMS } from './config.js';
import { recordLlmCall } from './metrics.js';
import { normalizeMemory } from './ontology.js';
import { normalizeBelief } from './belief/ontology.js';

const STABLE_PREFERENCE_PREDICATES = new Set([
  'likes',
  'dislikes',
  'avoids',
  'prefers',
  'has_boundary',
]);
const STABLE_IDENTITY_PREDICATES = new Set([
  'name',
  'birth_date',
  'lives_in',
  'works_at',
  'studies_at',
  'occupation',
  'allergic_to',
]);

const EXTRACT_SYSTEM = `你是一个记忆提取器, 服务于一个 AI 伴侣。
从给定对话中提取值得"长期记住"的信息。只提取持久的事实、重要事件、明确的偏好或关系变化。
忽略寒暄、闲聊、临时性的话。宁缺毋滥。

每条记忆把"客观事实"与"情感色彩"分开输出:
- type: "fact" | "episode" | "preference" | "relationship"
- fact_core: 不带主观色彩的客观事实陈述, 第三人称, 主语用真实角色名。例如 "诗雅讨厌香菜"、"沈清词生病时张逸晨照顾她"。这层将被永久保存、永不改写, 所以只写事实, 别写评价。
- narrative: (可选) 她当下对这件事的主观解读/感受, 例如 "她说起香菜时皱了下眉, 大概是真的很抗拒"。没有就给 null。
- subject_kind: 这条记忆属于谁 —— "user"(关于对方的事) / "self"(她对自己的设定, 如她自述的喜好) / "dyad"(你俩共有的, 如"我们一起看了那场雨")
- importance: 1-10。生日/重要承诺/重大事件=8-10; 明确偏好=4-6; 一般信息=3-4; 琐事不要提取
- fact_locked: true 仅用于绝对不容出错的硬事实(生日、名字、明确承诺、性/关系硬边界), 其余 false
- importance: 一时兴起的口味/想试一次 → 2-3；稳定偏好 → 4-6；硬边界/承诺 → 7-10
- affect: {"valence": -1..1, "intensity": 0..1} —— 这件事的情绪正负向与强度
- belief: (可选) 仅当 user 本人明确陈述稳定偏好或身份事实时输出：
  {"subject":"user","asserted_by":"user","predicate":"...","object":"...","evidence_quote":"用户原话中的逐字片段"}
  predicate 只能是 likes / dislikes / avoids / prefers / has_boundary / name / birth_date / lives_in / works_at / studies_at / occupation / allergic_to。
  evidence_quote 必须逐字出现在 user 的原消息里；助手猜测、隐含推断、临时想法、计划和不确定说法一律 belief=null。

偏好分层（系统会自动推断，你按事实写即可）:
- 硬边界: fact_locked=true（雷点、停词、过敏、名字生日）
- 稳定偏好: type=preference、importance≥4
- 一时兴起: type=preference、importance≤3 或事实里写「今天想/试试」

严格输出 JSON: {"memories": [...]}。没有可记的就输出 {"memories": []}。
不要使用"AI"、"机器人"、"用户"这类系统身份词指代对话双方; 用输入里给出的真实名字。
不要输出 JSON 以外的任何内容, 不要用 markdown 代码块。`;

const EXTRACT_INTIMATE_EXTRA = `
【亲密场景补充】本轮对话含亲密/性爱语境时，额外优先提取：
- 明确的性偏好/节奏/姿势偏好 → type=preference, subject_kind 多为 self 或 user
- 明确的雷点与边界（说停必须停、不喜欢某种称呼）→ preference 且 fact_locked=true, importance≥7
- 对双方关系有意义的亲密里程碑（第一次、特别温柔的一次事后）→ episode + subject_kind=dyad
不要把每一句动作描写都记成记忆；只记可复用的偏好、边界与里程碑。`;

/**
 * 从最近若干轮对话里提取记忆。
 * @param {Array<{role:string, content:string}>} turns
 * @param {string} subjectName 对方的名字, 用于 user 主语
 * @param {string} companionName 伴侣角色名, 用于 assistant 主语
 * @param {{ intimate?: boolean }} opts 亲密轮次时附加偏好/边界抽取提示
 * @returns {Promise<Array>} 提取出的记忆 (未含 embedding)
 */
export async function extractMemories(turns, subjectName = '用户', companionName = '她', opts = {}) {
  const transcript = turns
    .map((t) => `${t.role === 'user' ? subjectName : companionName}: ${t.content}`)
    .join('\n');

  const system = opts.intimate ? `${EXTRACT_SYSTEM}\n${EXTRACT_INTIMATE_EXTRA}` : EXTRACT_SYSTEM;

  const res = await llm.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `对方名字: ${subjectName}\n伴侣名字: ${companionName}\n\n对话:\n${transcript}` },
    ],
  });
  recordLlmCall('extract', res.usage);

  return parseMemoryExtraction(
    res.choices[0].message.content,
    subjectName,
    companionName,
    { ...opts, turns },
  );
}

/** 解析并收紧 LLM 输出；belief 只有通过显式来源与谓词白名单后才会进入 memory.source。 */
export function parseMemoryExtraction(
  content,
  subjectName = '用户',
  _companionName = '她',
  opts = {},
) {
  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.memories) ? parsed.memories : [];
  const userEvidence = (opts.turns ?? [])
    .filter((turn) => turn?.role === 'user')
    .map((turn) => String(turn.content ?? '').normalize('NFKC'));

  return list
    .map((raw) => {
      const memory = normalizeMemory(raw);
      const belief = opts.intimate
        ? null
        : normalizeStableExtractedBelief(raw?.belief, memory, {
            subjectName,
            userEvidence,
          });
      if (!belief) return memory;
      return {
        ...memory,
        source: {
          kind: 'conversation_extract',
          version: 1,
          speaker: 'user',
          ...(opts.eventId ? { eventId: String(opts.eventId) } : {}),
          beliefs: [belief],
        },
      };
    })
    .filter((memory) =>
      memory.fact_core && memory.importance >= PARAMS.minImportance,
    );
}

export function normalizeStableExtractedBelief(raw, memory, {
  subjectName = '用户',
  userEvidence = [],
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (memory?.subject_kind !== 'user') return null;
  if (raw.subject !== 'user' || (raw.asserted_by ?? raw.assertedBy) !== 'user') return null;
  const predicate = String(raw.predicate ?? '').trim().toLowerCase();
  const isPreference = STABLE_PREFERENCE_PREDICATES.has(predicate);
  const isIdentity = STABLE_IDENTITY_PREDICATES.has(predicate);
  if (!isPreference && !isIdentity) return null;
  if (isPreference && memory.type !== 'preference') return null;
  if (isIdentity && memory.type !== 'fact') return null;
  if (predicate === 'has_boundary' && !memory.fact_locked) return null;
  if (['name', 'birth_date', 'allergic_to'].includes(predicate) && !memory.fact_locked) {
    return null;
  }

  const evidenceQuote = String(raw.evidence_quote ?? raw.evidenceQuote ?? '')
    .normalize('NFKC')
    .trim();
  if (
    evidenceQuote.length < 2 ||
    !userEvidence.some((message) => message.includes(evidenceQuote))
  ) {
    return null;
  }
  const rawObject = raw.objectValue ?? raw.object_value ?? raw.object;
  if (!['string', 'number', 'boolean'].includes(typeof rawObject)) return null;
  const objectText = String(rawObject).normalize('NFKC').trim().slice(0, 120);
  if (!objectText) return null;
  const objectValue = typeof rawObject === 'string' ? objectText : rawObject;

  const slotKey = isPreference
    ? `user:preference:${stableSlotPart(objectText)}`
    : predicate === 'allergic_to'
      ? `user:allergy:${stableSlotPart(objectText)}`
      : `user:identity:${predicate}`;
  try {
    return normalizeBelief({
      subjectKey: 'user',
      subjectLabel: subjectName,
      predicate,
      objectValue,
      objectText,
      beliefKind: isPreference ? 'preference' : 'identity',
      epistemicStatus: 'asserted',
      confidence: 0.95,
      slotKey,
      metadata: { extractor: 'stable_memory_v1' },
    }, { sourceKind: 'user' });
  } catch {
    return null;
  }
}

function stableSlotPart(value) {
  return String(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_.-]/gu, '')
    .slice(0, 80) || 'value';
}

/**
 * 情绪 → 记忆重要性 (emotion-design.md §8): 本轮心情位移越大, 说明发生的事越"要紧",
 * 给这一轮提取出的记忆 importance 一点加成(按 PARAMS.moodShiftImportanceBoost, 夹在 1-10 内)。
 * @param memories extractMemories 的结果
 * @param moodShift moodShiftMagnitude(before, after) 的值
 */
export function applyMoodShiftBoost(memories, moodShift = 0) {
  const { threshold, maxShift, maxBoost } = PARAMS.moodShiftImportanceBoost;
  if (memories.length === 0 || !(moodShift > threshold)) return memories;
  const ratio = Math.min(1, (moodShift - threshold) / (maxShift - threshold));
  const boost = maxBoost * ratio;
  return memories.map((m) => ({ ...m, importance: Math.min(10, m.importance + boost) }));
}
