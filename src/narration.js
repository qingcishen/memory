// 旁白系统 · 按场景动态给旁白指令。
//
// 原先"性爱场景要写旁白"是写死在 assemble.js 里、对所有对话永远生效的一条规则,
// 且只覆盖了亲密场景一种情况。这里拆成: 场景分类(LLM, 每轮判断) + 场景->指令的映射表,
// 让日常/暧昧/紧张/冲突场景也能各自拿到贴切的旁白指令, 而不是只有一种场景被特殊照顾。
//
// 分类失败一律降级为 'daily'(不追加任何旁白指令), 不影响主对话链路。

import { llm as defaultLlm, LLM_MODEL } from './config.js';

export const SCENE_TYPES = ['daily', 'romantic', 'tense', 'conflict', 'intimate'];

/**
 * 场景 -> 旁白指令。daily 留空: 日常聊天通常不需要 narration part, 格式规则已经在
 * assemble.js 的【输出格式】段管了。旁白现在是独立于台词的 narration part(见
 * src/orchestrator/llm.js), 不再是写死在同一句里的散文——所以这里的指令只描述
 * "要不要加、加了写什么", 不再描述"怎么和台词写在一起"。
 */
export const NARRATION_DIRECTIVES = {
  daily: '',
  romantic:
    '【旁白提示】暧昧时多数轮次只出 dialogue 即可。若出 narration：一两句短神态就够（凑近、手停一下、呼吸变浅），绝不超过台词长度。禁止每轮复读「耳尖微热/散着的头发/半敞睡衣/往怀里嵌」。',
  tense:
    '【旁白提示】紧张时优先台词。若出 narration：一个小动作点到即可（攥衣角、沉默、别开眼），别堆形容词，别写成长段心理报告。',
  conflict:
    '【旁白提示】争执时优先台词。若出 narration：一句肢体/语气变化即可，不要替角色讲道理，不要写成对话摘要。',
  intimate:
    '【亲密场景·像真人，不要像网文】这一轮建议有 narration + dialogue，但以「真人床上反应」为标准，不是写黄文连载。' +
    '【长度】旁白 1～3 句短句即可，通常不要比台词长；禁止写成一整段小说。对方即使发了超长描写，你也只回她会有的那一下反应，不要跟他拼字数。' +
    '【视角】只写她这边的身体/动作/触感；不要全知代写对方的性器、节奏、内心独白（那是对方的事）。' +
    '【沉浸·感官】每轮旁白只主打 1 个感官（触/热/声/重量/气味），写「被碰到→身体怎么变」，禁止「很爽/很舒服」空话和五感齐发。' +
    '【沉浸·微主动】她不是道具：髋送、腿环、手按、自己调角度；节奏可不匀（喘、停半拍、要慢/要深）。' +
    '【禁止套话开场】禁止「她听他那么说/听见那句……」公式；禁止每轮用全名开场。' +
    '【禁止服装头发清单】睡衣、披发、领口、半敞、嵌进怀里——若上轮已写过，本轮禁止再复述；只写本轮新发生的那一个变化。' +
    '【用词】可以直接，但要像现场喘着说出来的触感，不要报菜名式堆解剖学流水账。' +
    '【台词】dialogue 必须像枕边随口说：短、碎、可喘可凶可软；禁止解说剧情，禁止每轮以「你是不是一直想我」式检查收尾。',
};

/** I2: intimacy.scene_phase → 旁白细分；缺省回退 sceneType 指令。 */
export const PHASE_NARRATION_DIRECTIVES = {
  none: '',
  flirting:
    '【旁白·暧昧】可写可不写。写了就一句：距离、呼吸、手指。不要正戏动作，不要姓名开场，不要睡衣头发复读。',
  foreplay:
    '【旁白·前戏】1～2 句：他碰到哪 → 她哪里发热/发软/夹紧/喘。只写她侧，感官单一。不要解剖长文，不要比台词长很多。尚未到事后，别无故收尾。',
  peak:
    '【旁白·正戏·像真人】必须有 narration，但短：1～3 句「这一下」的身体因果（顶到→腿软/夹紧/腰塌/呼吸断）。' +
    '每轮只推进一步；可微主动（髋/手/腿）。禁止：全知双方长文、睡衣头发复读、姓名开场、黄文流水账、替他写活塞步骤。' +
    'dialogue 更重要：短、真、碎（嗯/别…/再…/轻点/深一点），像真人床上会说的，不是旁白解说。',
  aftercare:
    '【旁白·事后】可有可无。若写：贴、呼吸渐平、手指还在背上，一两句。禁止技巧堆砌和无缝续车。台词短、软、可哑。',
  cooldown:
    '【旁白·冷却】点到神态即可或省略。不要再写正戏。',
};

/**
 * 场景基调之上的情绪细节层 (B 行为策略线的 inferEmotionLabel 产出)。
 * 只覆盖"场景本身猜不出、但情绪标签能猜出"的那部分微妙意味——委屈/吃醋/撒娇/心疼
 * 这几种在 tense/romantic 场景下会长得很像"她有点情绪"，但具体是哪种情绪该有区分的
 * 神态。开心/平静/生气/失落不额外加(生气/失落已被 tense/conflict 场景本身覆盖到)。
 */
export const EMOTION_NUANCE = {
  委屈: '这一刻她心里有点委屈，动作上可以带一点小别扭或欲言又止，但不会大吵大闹。',
  吃醋: '这一刻她心里夹着一点不易察觉的醋意，动作/语气可以有一丝不自然的别扭，但嘴上未必承认。',
  撒娇: '带一点撒娇讨好的意味，动作可以更黏人、更任性一点。',
  心疼: '她其实有点心疼对方，神态里可以露出关切，但嘴上未必会直说。',
};

/**
 * 场景类型 -> 旁白指令; 未知类型或 daily 返回空串。纯函数。
 * overrides: 角色人设的按场景覆盖 (CompanionConfig.narrationDirectives, 来自
 * companions/<id>/narration.json) —— 角色专属的旁白写法/尺度/称呼属于人设,
 * 这里的 NARRATION_DIRECTIVES 只是通用兜底。
 * emotionLabel: B 线的离散情绪推断结果 (见 src/state/emotionLabel.js), 只在
 * 场景本身已经决定要写旁白(base 非空)时才叠加情绪细节——不会让纯日常聊天
 * 单纯因为"有点委屈"就被迫多写一条 narration part, 维持"不是每轮都需要"的原则。
 * intimacyPhase: I 线 scene_phase；在 romantic/intimate 或 phase≠none 时优先用阶段旁白。
 */
// 低推进度场景 (相拥/安睡/事后余韵这类"没有新动作"的状态) 最容易出现旁白复读——
// 历史里其实带着上几轮的原文, 但模型仍会顺着"贴脸/揪衣角/嗓子哑"这类安全意象
// 一路抄下去。只在真的要出 narration part 时才追加这条, 不给纯日常台词加负担。
export const NO_REPEAT_HINT =
  '【别复读·硬性】对照最近几轮自己的旁白与台词：禁止同句式开场（听他/被他/把脸埋进…），禁止同套意象换词重排（散着头发/丝质睡衣/半敞/往怀里嵌/耳尖微热/指尖收紧/嗓子哑）。' +
  '没有新动作就不要 narration；有新动作只写「新增的那一下」。台词收尾也别每轮黏「抱紧/别松/再待一会儿」。';

export function buildNarrationPrompt(sceneType, overrides = null, emotionLabel = null, intimacyPhase = null) {
  const phase = intimacyPhase && PHASE_NARRATION_DIRECTIVES[intimacyPhase] !== undefined ? intimacyPhase : null;
  let base = '';
  if (phase && phase !== 'none') {
    // 人设可按 phase 键覆盖，也可仍用 intimate/romantic 场景键
    const phaseOverride = overrides?.[phase];
    const sceneOverride = overrides?.[sceneType];
    if (typeof phaseOverride === 'string' && phaseOverride.trim()) base = phaseOverride;
    else if (PHASE_NARRATION_DIRECTIVES[phase]) base = PHASE_NARRATION_DIRECTIVES[phase];
    else if (typeof sceneOverride === 'string' && sceneOverride.trim()) base = sceneOverride;
    else base = NARRATION_DIRECTIVES[sceneType] ?? '';
  } else {
    const o = overrides?.[sceneType];
    base = typeof o === 'string' && o.trim() ? o : NARRATION_DIRECTIVES[sceneType] ?? '';
  }
  // peak 硬规则：若阶段是 peak 但 base 被设成空，回退 peak 指令
  if (phase === 'peak' && !base.trim()) base = PHASE_NARRATION_DIRECTIVES.peak;
  if (!base) return base;
  const nuance = EMOTION_NUANCE[emotionLabel];
  const withNuance = nuance ? `${base}\n【情绪基调】${nuance}` : base;
  return `${withNuance}\n${NO_REPEAT_HINT}`;
}

/** 把原始 LLM 分类输出规整成合法场景类型; 不认识的一律降级 'daily'。纯函数, 可单测。 */
export function parseSceneLabel(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return SCENE_TYPES.includes(s) ? s : 'daily';
}

/**
 * 组装分类用的输入: 最近几轮 + 当前这条消息 (+ 可选的连续性提示)。纯函数。
 * previousScene: 上一轮判定的场景; 非 daily 时附一句"倾向保持"的提示——LLM 单轮分类
 * 对模糊语句很容易在 daily/romantic/tense 之间来回抖动, 给一点惯性能显著减少闪回感,
 * 真正转场(如从暧昧突然吵起来)时提示只是"倾向", 不会盖过明显的场景变化。
 */
export function composeClassifyInput(userMessage, history = [], lookback = 4, previousScene = null) {
  const recent = (history ?? []).slice(-lookback * 2).map((t) => `${t.role === 'user' ? '对方' : '她'}: ${t.content}`);
  recent.push(`对方: ${userMessage}`);
  const hint = previousScene && previousScene !== 'daily' ? `\n[提示: 上一轮场景是 ${previousScene}, 除非这段对话明显转变, 否则倾向保持]` : '';
  return recent.join('\n') + hint;
}

const CLASSIFY_SYS = `判断下面这段对话当前是哪种场景, 只从这几个词里选一个原样输出, 不要解释、不要标点:
daily(日常闲聊) / romantic(暧昧调情但未涉及具体亲密动作) / tense(气氛紧绷/一方情绪低落或不安) / conflict(争执冲突) / intimate(已经在进行或明确要发生的性爱/亲密动作)`;

export class SceneClassifier {
  constructor({ llmClient = defaultLlm, model = LLM_MODEL, lookback = 4 } = {}) {
    this.llmClient = llmClient;
    this.model = model;
    this.lookback = lookback;
  }

  /**
   * 分类当前场景; 任何失败都降级 'daily', 不抛、不阻塞主链路。
   * previousScene: 上一轮场景 (调用方维护, 如 Orchestrator._lastSceneType), 用于连续性提示。
   */
  async classify({ userMessage, history = [], previousScene = null, signal } = {}) {
    if (!userMessage) return 'daily';
    try {
      const res = await this.llmClient.chat.completions.create({
        model: this.model,
        temperature: 0,
        max_tokens: 8,
        messages: [
          { role: 'system', content: CLASSIFY_SYS },
          { role: 'user', content: composeClassifyInput(userMessage, history, this.lookback, previousScene) },
        ],
      }, { signal });
      return parseSceneLabel(res.choices?.[0]?.message?.content);
    } catch {
      return 'daily';
    }
  }
}
