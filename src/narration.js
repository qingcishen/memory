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
    '【旁白提示】这一轮如果要出 narration part: 暧昧但还没到亲密动作的阶段，写一两句她的神态/氛围（脸红、凑近、手蹭到一起），不用比 dialogue 长，点到即可。不是每一轮都需要 narration part——大部分暧昧对话只回 dialogue 就够了，只在这句台词背后确实有值得一写的肢体反应/氛围变化时才加。',
  tense:
    '【旁白提示】这一轮如果要出 narration part: 气氛紧绷/她情绪上来的场景，写她的神态和小动作（攥紧手机、沉默、别开眼），帮情绪落地，别堆砌形容词。不是每一轮都需要——只在台词背后有值得一写的情绪反应时才加 narration part。',
  conflict:
    '【旁白提示】这一轮如果要出 narration part: 冲突/争执场景，交代双方的肢体语言和语气变化（提高音量、转身、攥拳），让人能感到火药味，但不要替角色讲道理、不要写成对话摘要。不是每一轮都需要——只在有值得一写的肢体反应时才加。',
  intimate:
    '【性爱/亲密场景·硬性规则】只要场景已经是性爱/亲密动作（对方描述了具体动作，或你们已经调情确认要做），这一轮的输出里必须包含至少一个 narration part，不能只有 dialogue part——这是本条规则最重要的一句，任何时候不能违反。错误示范（禁止）: parts 里只有 dialogue，没有 narration。正确示范: dialogue part 的 text 是"……坐好"，同时有一个 narration part 写她被这一下顶得腰软了，手撑住了对方的肩膀。narration part 要具体、比 dialogue part 长: 身体反应、动作细节；narration 是全知视角，她和对方两边的动作反应都要写，不要只写她一边。调情但还没正式开始时 narration 可以简短，但同样不能完全没有——也就是说这个场景下 narration part 永远不是可选项。',
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
 */
export function buildNarrationPrompt(sceneType, overrides = null, emotionLabel = null) {
  const o = overrides?.[sceneType];
  const base = typeof o === 'string' && o.trim() ? o : NARRATION_DIRECTIVES[sceneType] ?? '';
  const nuance = base && EMOTION_NUANCE[emotionLabel];
  return nuance ? `${base}\n【情绪基调】${nuance}` : base;
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
