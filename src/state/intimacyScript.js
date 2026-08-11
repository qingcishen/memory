// Intimacy I-5 · 亲密场景的纯叙事脚本层。
//
// 这里不决定场景是否可以推进（那是 intimacy 状态机/consent 门控的职责），只把已经
// 确认的 phase 拆成短小的“导演节拍”。模板刻意不指定吻、手、腿等具体动作：当前用户
// 动作永远比模板优先，避免模型为了完成 beat 突然换姿势或凭空增加接触。

export const INTIMACY_BEAT_TEMPLATES = Object.freeze({
  flirting: Object.freeze([
    Object.freeze({
      scene_beat: '承接刚发生的距离或目光变化，只呈现一个能被对方读到的微反应。',
      pace_instruction: '停半拍，不越级到新的亲密动作。',
      sensory_focus: '距离与呼吸',
      emotional_tone: '试探、轻松、留有余地',
    }),
    Object.freeze({
      scene_beat: '在同一个互动点给一点回应，让暧昧来自来回而不是独角戏。',
      pace_instruction: '只推进半步，等待对方的下一次反应。',
      sensory_focus: '接触处的温度',
      emotional_tone: '好奇、含蓄、有回应感',
    }),
    Object.freeze({
      scene_beat: '让一句短话或一小段沉默承担张力，动作只作陪衬。',
      pace_instruction: '把悬念留在这一拍，不急着兑现。',
      sensory_focus: '声音与停顿',
      emotional_tone: '期待、俏皮、克制',
    }),
  ]),
  foreplay: Object.freeze([
    Object.freeze({
      scene_beat: '只写当前动作落下后的第一个身体反应，保持清楚的动作因果。',
      pace_instruction: '一轮只推进这一下，不概述全过程。',
      sensory_focus: '接触与温度',
      emotional_tone: '投入、敏感、专注当下',
    }),
    Object.freeze({
      scene_beat: '角色可在同一动作里微调回应，但不要另起一个不相干的动作。',
      pace_instruction: '沿现有方向小幅变化，不突然跳档。',
      sensory_focus: '压力与重量',
      emotional_tone: '主动但不抢拍、彼此响应',
    }),
    Object.freeze({
      scene_beat: '用一口气、一个声音或一句碎话表现反应，少写解释。',
      pace_instruction: '旁白收短，让停顿和台词占主位。',
      sensory_focus: '呼吸与声音',
      emotional_tone: '亲近、坦率、略带脆弱',
    }),
    Object.freeze({
      scene_beat: '呈现当前动作强弱或速度改变时的即时反应，不换动作。',
      pace_instruction: '只改变一个节奏变量，身体反应紧跟其后。',
      sensory_focus: '速度与热度',
      emotional_tone: '逐渐升温、仍保持回应',
    }),
    Object.freeze({
      scene_beat: '在继续前留出可被读懂的回应空间，用反应决定下一拍。',
      pace_instruction: '先接住反馈，再决定维持、减慢或继续。',
      sensory_focus: '停顿与肌肉松紧',
      emotional_tone: '信任、留心、相互确认',
    }),
  ]),
  peak: Object.freeze([
    Object.freeze({
      scene_beat: '聚焦当前动作造成的一个强烈身体因果，不扩写成全身扫描。',
      pace_instruction: '一句动作、一句反应；不代写对方的动作链。',
      sensory_focus: '受力与身体反应',
      emotional_tone: '强烈、专注、保持连接',
    }),
    Object.freeze({
      scene_beat: '在现有动作中表现一次节奏变化，以及身体跟上或落后半拍。',
      pace_instruction: '只变快慢或强弱中的一项，不凭空换动作。',
      sensory_focus: '节奏与惯性',
      emotional_tone: '急切、真实、有来有回',
    }),
    Object.freeze({
      scene_beat: '让角色在同一接触点给出微主动回应；若不自然，就只写即时反应。',
      pace_instruction: '主动必须接得上当前动作，不能为了模板硬加。',
      sensory_focus: '发力与重量转移',
      emotional_tone: '投入、有主体性、不过度编排',
    }),
    Object.freeze({
      scene_beat: '让短台词、断句或呼吸承担高潮这一拍，旁白只保留必要动作因果。',
      pace_instruction: '台词优先，旁白压到一两句并停在当下。',
      sensory_focus: '声音与呼吸',
      emotional_tone: '直接、失序但仍有回应',
    }),
  ]),
  aftercare: Object.freeze([
    Object.freeze({
      scene_beat: '从刚才的位置自然安静下来，只写身体逐渐松开的一个变化。',
      pace_instruction: '明显降速，不瞬移、不立刻开启新动作。',
      sensory_focus: '余温与重量',
      emotional_tone: '安稳、柔软、落地',
    }),
    Object.freeze({
      scene_beat: '用同一接触点上的小照顾回应对方当下状态，不列照护清单。',
      pace_instruction: '一次只做一件小事，给对方回应时间。',
      sensory_focus: '轻触与渐缓的呼吸',
      emotional_tone: '体贴、清醒、没有表演感',
    }),
    Object.freeze({
      scene_beat: '用一句短话或安静陪伴收住余韵，是否转场跟随当前互动。',
      pace_instruction: '允许停住；没有新动作就不要硬续场。',
      sensory_focus: '声音、安静与距离',
      emotional_tone: '亲密、安全、不急于收尾',
    }),
  ]),
});

const BODY_FOCUS_CUES = [
  { pattern: /(?:hand|finger|palm|手|指|掌)/iu, label: '手与指尖' },
  { pattern: /(?:mouth|lip|kiss|breath|口|嘴|唇|吻)/iu, label: '唇边与呼吸' },
  { pattern: /(?:face|cheek|eye|脸|颊|眼)/iu, label: '脸侧与目光' },
  { pattern: /(?:neck|shoulder|颈|脖|肩)/iu, label: '颈肩的温度与受力' },
  { pattern: /(?:back|waist|spine|背|腰|脊)/iu, label: '腰背的受力变化' },
  { pattern: /(?:torso|chest|abdomen|belly|上身|胸|腹|肚)/iu, label: '上身的起伏与温度' },
  { pattern: /(?:hip|leg|thigh|knee|foot|髋|腿|膝|脚)/iu, label: '髋腿的发力与重量' },
  { pattern: /(?:whole|body|全身|身体)/iu, label: '全身最明显的一个反应点' },
];

const ACTION_CUES = [
  { pattern: /(?:亲|吻|唇|kiss)/iu, label: '亲吻或唇边接触', sensory: '唇边与呼吸' },
  { pattern: /(?:抱|搂|拥|怀里|贴住|靠在)/u, label: '拥抱或贴近', sensory: '距离、温度与重量' },
  { pattern: /(?:握|牵|摸|碰|触|按|揉|手|指)/u, label: '手部接触', sensory: '接触点的压力与温度' },
  { pattern: /(?:看着|盯|对视|目光|眼神)/u, label: '目光互动', sensory: '距离与目光停留' },
  { pattern: /(?:耳边|声音|说|叫|喘|呼吸)/u, label: '声音或呼吸互动', sensory: '声音、气息与停顿' },
  { pattern: /(?:靠近|退开|转身|躺|坐|起身|距离|姿势)/u, label: '距离或姿势变化', sensory: '重心与距离变化' },
  { pattern: /(?:继续|再来|别停|不要停|节奏|快点)/u, label: '当前动作的延续或节奏变化', sensory: '节奏与身体跟拍' },
];

const STOP_CUE = /(?:停下|停一下|停一停|暂停|(?:^|[\s，。！？、])停(?:$|[\s，。！？、])|不要了|不要这样|不想继续|不行|算了|放开|松开|别碰|别这样|离我远点|等一下|等等|不舒服|疼(?:了|死|得)?)/u;
const SLOW_CUE = /(?:慢点|慢一点|轻点|轻一点)/u;

function clamp01(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function wrapIndex(value, length) {
  const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return ((n % length) + length) % length;
}

function bodyFocusCandidates(bodyFocus) {
  if (typeof bodyFocus === 'string') return [bodyFocus];
  if (Array.isArray(bodyFocus)) return bodyFocus.flatMap((value) => bodyFocusCandidates(value));
  if (!bodyFocus || typeof bodyFocus !== 'object') return [];

  const preferred = ['primary', 'current', 'area', 'region', 'part', 'target', 'name'];
  const candidates = preferred.flatMap((key) => bodyFocusCandidates(bodyFocus[key]));
  const weightedKeys = Object.entries(bodyFocus)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
  const remaining = Object.entries(bodyFocus)
    .filter(([key]) => !preferred.includes(key))
    .flatMap(([key, value]) => [key, ...bodyFocusCandidates(value)]);
  return [...candidates, ...weightedKeys, ...remaining];
}

function resolveBodyFocus(bodyFocus) {
  const candidates = bodyFocusCandidates(bodyFocus);
  for (const candidate of candidates) {
    const cue = BODY_FOCUS_CUES.find(({ pattern }) => pattern.test(String(candidate)));
    if (cue) return cue.label;
  }
  // body_focus 可能来自未来版本的新 schema。不要把未知原文抬升到 system prompt，
  // 但仍告诉模型已有焦点，只要求它沿当前动作解释。
  return candidates.length ? '状态中已记录的身体焦点' : '';
}

function resolveUserCue(userMessage) {
  const text = String(userMessage ?? '').slice(0, 500);
  // “别停/不要停”不是停止信号；先移除再检查独立的边界表达。
  const safetyText = text.replace(/(?:别|不要|不许)停(?:下|了)?/gu, '');
  if (STOP_CUE.test(safetyText)) return { kind: 'stop' };
  if (SLOW_CUE.test(text)) return { kind: 'slow' };
  const action = ACTION_CUES.find(({ pattern }) => pattern.test(text));
  return action ? { kind: 'action', ...action } : null;
}

function arousalDirection(arousal) {
  if (arousal < 0.34) {
    return {
      pace: '低唤起：放慢并给反应留空间',
      tone: '松弛、可随时停住',
    };
  }
  if (arousal > 0.72) {
    return {
      pace: '高唤起：句子更短，但不自动加码',
      tone: '强烈但仍读得到彼此反应',
    };
  }
  return {
    pace: '中等唤起：保持当前速度',
    tone: '投入而克制',
  };
}

function buildPrompt({ scene_beat, pace_instruction, sensory_focus, emotional_tone }) {
  return [
    '【本轮亲密叙事节拍】',
    `场景：${scene_beat}`,
    `节奏：${pace_instruction}`,
    `感官：${sensory_focus}`,
    `情绪：${emotional_tone}`,
  ].join('\n');
}

/**
 * 根据亲密状态生成一个结构化导演节拍。纯函数；不修改输入。
 *
 * 未支持的 phase（none/cooldown/未知）返回 null，调用方不应注入提示。
 * userMessage 只用于识别安全信号与动作类别，原文不会被复制进 system prompt。
 *
 * @param {{
 *   phase?: string,
 *   beatIndex?: number,
 *   arousal?: number,
 *   body_focus?: unknown,
 *   userMessage?: string,
 * }} input
 * @returns {{
 *   scene_beat: string,
 *   pace_instruction: string,
 *   sensory_focus: string,
 *   emotional_tone: string,
 *   prompt: string,
 * } | null}
 */
export function generateIntimacyBeat({
  phase,
  beatIndex = 0,
  arousal = 0.5,
  body_focus = null,
  userMessage = '',
} = {}) {
  const templates = INTIMACY_BEAT_TEMPLATES[phase];
  if (!templates?.length) return null;

  const template = templates[wrapIndex(beatIndex, templates.length)];
  const userCue = resolveUserCue(userMessage);
  const bodyFocus = resolveBodyFocus(body_focus);
  const intensity = arousalDirection(clamp01(arousal));

  let sceneBeat;
  let paceInstruction;
  let sensoryFocus;
  let emotionalTone;

  if (userCue?.kind === 'stop') {
    sceneBeat = '停在用户刚表达的边界上，只写角色立即停止和给出空间。';
    paceInstruction = '立即停止推进；边界优先于阶段和节拍模板。';
    sensoryFocus = '距离与逐渐平稳的呼吸，不情色化边界';
    emotionalTone = '尊重、清醒、没有施压';
  } else {
    const anchor = userCue?.kind === 'action'
      ? `锚定用户本轮的${userCue.label}，不换动作。`
      : '没有明确新动作时只写新增反应，不凭空加动作。';
    sceneBeat = `${template.scene_beat}${anchor}`;
    paceInstruction = userCue?.kind === 'slow'
      ? `立即按用户表达减速或减轻；${template.pace_instruction}`
      : `${intensity.pace}；${template.pace_instruction}`;
    sensoryFocus = userCue?.kind === 'action'
      ? `${userCue.sensory}${bodyFocus ? `；${bodyFocus}只在与当前动作重合时使用` : ''}`
      : bodyFocus
        ? `${template.sensory_focus}，优先落在${bodyFocus}`
        : template.sensory_focus;
    emotionalTone = `${template.emotional_tone}；${intensity.tone}`;
  }

  const beat = {
    scene_beat: sceneBeat,
    pace_instruction: paceInstruction,
    sensory_focus: sensoryFocus,
    emotional_tone: emotionalTone,
  };
  return { ...beat, prompt: buildPrompt(beat) };
}
