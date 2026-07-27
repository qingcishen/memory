// 旁白系统测试: buildNarrationPrompt/parseSceneLabel/composeClassifyInput 纯逻辑 + SceneClassifier 注入假 llm, 不连网。
import assert from 'node:assert';
import {
  SCENE_TYPES,
  NARRATION_DIRECTIVES,
  EMOTION_NUANCE,
  buildNarrationPrompt,
  parseSceneLabel,
  composeClassifyInput,
  SceneClassifier,
} from '../src/narration.js';
import { rewriteNarrationParts } from '../src/orchestrator/llm.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('buildNarrationPrompt / NARRATION_DIRECTIVES (纯逻辑)');
{
  ok('daily 没有额外旁白指令', buildNarrationPrompt('daily') === '');
  ok('romantic 有旁白提示', buildNarrationPrompt('romantic').includes('【旁白提示】'));
  ok('tense 有旁白提示', buildNarrationPrompt('tense').includes('【旁白提示】'));
  ok('conflict 有旁白提示', buildNarrationPrompt('conflict').includes('【旁白提示】'));
  ok('intimate 是硬性规则', buildNarrationPrompt('intimate').includes('【性爱/亲密场景·硬性规则】'));
  ok('未知场景类型 -> 空串', buildNarrationPrompt('not-a-scene') === '');
  ok('每种场景类型在映射表里都有一条(可能为空)', SCENE_TYPES.every((t) => typeof NARRATION_DIRECTIVES[t] === 'string'));
  ok('通用默认不含角色专属名字', !Object.values(NARRATION_DIRECTIVES).some((d) => /清词|逸晨/.test(d)));

  // 角色人设覆盖 (companions/<id>/narration.json -> CompanionConfig.narrationDirectives)
  const overrides = { romantic: '角色专属的暧昧旁白写法', intimate: '   ' };
  ok('人设覆盖优先于通用默认', buildNarrationPrompt('romantic', overrides) === '角色专属的暧昧旁白写法');
  ok('空白覆盖回退通用默认', buildNarrationPrompt('intimate', overrides).includes('【性爱/亲密场景·硬性规则】'));
  ok('未覆盖的场景走通用默认', buildNarrationPrompt('tense', overrides).includes('【旁白提示】'));
  ok('overrides 为 null 安全', buildNarrationPrompt('romantic', null).includes('【旁白提示】'));
}

console.log('buildNarrationPrompt: emotionLabel 情绪基调叠加 (接入 B 行为策略线)');
{
  const withNuance = buildNarrationPrompt('tense', null, '委屈');
  ok('场景本有旁白 + 情绪标签有细节 -> 叠加基调段', withNuance.includes('【旁白提示】') && withNuance.includes('【情绪基调】') && withNuance.includes(EMOTION_NUANCE.委屈));
  ok('daily 场景即使情绪标签有细节也不强加旁白', buildNarrationPrompt('daily', null, '委屈') === '');
  ok('情绪标签为空不叠加', buildNarrationPrompt('tense', null, null) === NARRATION_DIRECTIVES.tense);
  ok('情绪标签不在细节表里 (如 平静/开心) 不叠加', buildNarrationPrompt('romantic', null, '开心') === NARRATION_DIRECTIVES.romantic);
  ok('吃醋/撒娇/心疼都在细节表里', ['吃醋', '撒娇', '心疼'].every((k) => typeof EMOTION_NUANCE[k] === 'string' && EMOTION_NUANCE[k]));
  const overridden = buildNarrationPrompt('romantic', { romantic: '角色专属写法' }, '撒娇');
  ok('人设覆盖之上依然能叠加情绪基调', overridden.startsWith('角色专属写法') && overridden.includes(EMOTION_NUANCE.撒娇));
}

console.log('parseSceneLabel (纯逻辑)');
{
  ok('合法类型原样(小写)通过', parseSceneLabel('intimate') === 'intimate');
  ok('大小写/空白容错', parseSceneLabel('  Romantic \n') === 'romantic');
  ok('不认识的词降级 daily', parseSceneLabel('不知道') === 'daily');
  ok('空/undefined 降级 daily', parseSceneLabel(undefined) === 'daily' && parseSceneLabel('') === 'daily');
}

console.log('composeClassifyInput (纯逻辑)');
{
  const input = composeClassifyInput('在干嘛', [
    { role: 'user', content: '早' },
    { role: 'assistant', content: '早呀' },
  ]);
  ok('历史按角色标注', input.includes('对方: 早') && input.includes('她: 早呀'));
  ok('当前消息排在最后', input.trim().endsWith('对方: 在干嘛'));

  const long = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` }));
  const trimmed = composeClassifyInput('最新', long, 2);
  ok('lookback 裁剪历史长度 (2 轮=4条+当前1条)', trimmed.split('\n').length === 5);
}

console.log('composeClassifyInput: previousScene 连续性提示 (防单轮误判导致场景来回跳)');
{
  const withPrev = composeClassifyInput('嗯', [], 4, 'tense');
  ok('非 daily 的上一轮场景附带提示', withPrev.includes('[提示: 上一轮场景是 tense'));
  const prevDaily = composeClassifyInput('嗯', [], 4, 'daily');
  ok('上一轮是 daily 时不附加提示 (daily 没有连续性可言)', !prevDaily.includes('[提示:'));
  const noPrev = composeClassifyInput('嗯', [], 4, null);
  ok('没有 previousScene 时输出与旧签名一致', noPrev === composeClassifyInput('嗯', [], 4));
}

console.log('SceneClassifier (注入假 llm, 不连网)');
{
  const sc = new SceneClassifier({
    llmClient: {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: 'intimate' } }] }) } },
    },
  });
  ok('分类结果按 parseSceneLabel 规整', (await sc.classify({ userMessage: '继续' })) === 'intimate');

  const messyClassifier = new SceneClassifier({
    llmClient: {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: ' Tense\n' } }] }) } },
    },
  });
  ok('模型输出带空白/大小写也能规整', (await messyClassifier.classify({ userMessage: '别说了' })) === 'tense');

  const failing = new SceneClassifier({
    llmClient: {
      chat: {
        completions: {
          create: async () => {
            throw new Error('超时');
          },
        },
      },
    },
  });
  ok('LLM 失败 -> 降级 daily, 不抛', (await failing.classify({ userMessage: '你好' })) === 'daily');

  ok('没有 userMessage -> 直接 daily, 不调 LLM', (await new SceneClassifier({}).classify({})) === 'daily');

  let seenPrompt = '';
  const spying = new SceneClassifier({
    llmClient: { chat: { completions: { create: async (req) => { seenPrompt = req.messages.at(-1).content; return { choices: [{ message: { content: 'tense' } }] } } } } },
  });
  await spying.classify({ userMessage: '嗯', previousScene: 'tense' });
  ok('classify 把 previousScene 转发进分类 prompt', seenPrompt.includes('上一轮场景是 tense'));
}

console.log('独立旁白模型');
{
  const original = [
    { type: 'narration', text: '她笑了。' },
    { type: 'dialogue', text: '你来啦。' },
  ];
  const fake = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: '{"narrations":["她眼尾轻轻弯起，朝他靠近了半步。"]}' } }],
      usage: {},
    }) } },
  };
  const rewritten = await rewriteNarrationParts(original, [], { client: fake, model: 'narrator-test' });
  ok('独立模型会替换旁白', rewritten[0].text.includes('眼尾'));
  ok('独立模型不改台词', rewritten[1].text === '你来啦。');
  ok('未配置模型时保持原旁白', (await rewriteNarrationParts(original, [], { client: fake, model: '' }))[0].text === '她笑了。');
  const failed = await rewriteNarrationParts(original, [], { client: { chat: { completions: { create: async () => { throw new Error('超时'); } } } }, model: 'broken' });
  ok('旁白模型失败时安全回退', failed[0].text === '她笑了。' && failed[1].text === '你来啦。');
}

console.log(`\n旁白系统 全部 ${passed} 条断言通过`);
