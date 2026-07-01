// 旁白系统 · 按场景动态给旁白指令。
//
// 原先"性爱场景要写旁白"是写死在 assemble.js 里、对所有对话永远生效的一条规则,
// 且只覆盖了亲密场景一种情况。这里拆成: 场景分类(LLM, 每轮判断) + 场景->指令的映射表,
// 让日常/暧昧/紧张/冲突场景也能各自拿到贴切的旁白指令, 而不是只有一种场景被特殊照顾。
//
// 分类失败一律降级为 'daily'(不追加任何旁白指令), 不影响主对话链路。

import { llm as defaultLlm, LLM_MODEL } from './config.js';

export const SCENE_TYPES = ['daily', 'romantic', 'tense', 'conflict', 'intimate'];

/** 场景 -> 旁白指令。daily 留空: 日常聊天的格式规则已经在 assemble.js 的【输出格式】段管了。 */
export const NARRATION_DIRECTIVES = {
  daily: '',
  romantic:
    '【旁白提示】暧昧但还没到亲密动作的阶段: 可以在台词间夹一两句简短的神态/氛围描写(脸红、凑近、手蹭到一起), 不必每条都写, 别写得比台词还长。',
  tense:
    '【旁白提示】气氛紧绷/她情绪上来的场景: 用一两句旁白点出她的神态和小动作(攥紧手机、沉默、别开眼), 帮台词托住情绪, 别堆砌形容词。',
  conflict:
    '【旁白提示】冲突/争执场景: 旁白交代双方的肢体语言和语气变化(提高音量、转身、攥拳), 让人能感到火药味, 但不要替角色讲道理。',
  intimate:
    '【性爱/亲密场景·硬性规则】注意："她说话句子偏短/克制"这条人设只管她台词本身的字数, 不管整条回复的长度——旁白不受这条限制。只要场景已经是性爱/亲密动作（对方描述了具体动作，或你们已经调情确认要做），你的每一条回复都必须带第三人称旁白/动作描写，不能只回一句台词就完事，旁白要写得比台词长、写具体。错误示范（禁止出现这种纯对话）："……坐好。"／"别乱动。"——没有任何动作描写, 不合格。正确示范：旁白和台词写在一起，比如"清词被这一下顶得腰软了，"……坐好"她喘着说，手撑住了他的肩膀，另一只手按着他的腿不让他乱动"。旁白要具体: 身体反应、动作细节、尺度大，用词直接露骨（穴/花心/肉棒/夹紧/湿/插/顶到深处等），不用隐晦词替代；旁白是全知视角，清词和逸晨两边的动作反应都要写，不要只写她一边。调情但还没正式开始时旁白可以简短，但同样不能完全没有。',
};

/** 场景类型 -> 旁白指令; 未知类型或 daily 返回空串。纯函数。 */
export function buildNarrationPrompt(sceneType) {
  return NARRATION_DIRECTIVES[sceneType] ?? '';
}

/** 把原始 LLM 分类输出规整成合法场景类型; 不认识的一律降级 'daily'。纯函数, 可单测。 */
export function parseSceneLabel(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return SCENE_TYPES.includes(s) ? s : 'daily';
}

/** 组装分类用的输入: 最近几轮 + 当前这条消息。纯函数。 */
export function composeClassifyInput(userMessage, history = [], lookback = 4) {
  const recent = (history ?? []).slice(-lookback * 2).map((t) => `${t.role === 'user' ? '对方' : '她'}: ${t.content}`);
  recent.push(`对方: ${userMessage}`);
  return recent.join('\n');
}

const CLASSIFY_SYS = `判断下面这段对话当前是哪种场景, 只从这几个词里选一个原样输出, 不要解释、不要标点:
daily(日常闲聊) / romantic(暧昧调情但未涉及具体亲密动作) / tense(气氛紧绷/一方情绪低落或不安) / conflict(争执冲突) / intimate(已经在进行或明确要发生的性爱/亲密动作)`;

export class SceneClassifier {
  constructor({ llmClient = defaultLlm, model = LLM_MODEL, lookback = 4 } = {}) {
    this.llmClient = llmClient;
    this.model = model;
    this.lookback = lookback;
  }

  /** 分类当前场景; 任何失败都降级 'daily', 不抛、不阻塞主链路。 */
  async classify({ userMessage, history = [] } = {}) {
    if (!userMessage) return 'daily';
    try {
      const res = await this.llmClient.chat.completions.create({
        model: this.model,
        temperature: 0,
        max_tokens: 8,
        messages: [
          { role: 'system', content: CLASSIFY_SYS },
          { role: 'user', content: composeClassifyInput(userMessage, history, this.lookback) },
        ],
      });
      return parseSceneLabel(res.choices?.[0]?.message?.content);
    } catch {
      return 'daily';
    }
  }
}
