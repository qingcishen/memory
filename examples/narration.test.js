// 旁白系统测试: buildNarrationPrompt/parseSceneLabel/composeClassifyInput 纯逻辑 + SceneClassifier 注入假 llm, 不连网。
import assert from 'node:assert';
import {
  SCENE_TYPES,
  NARRATION_DIRECTIVES,
  buildNarrationPrompt,
  parseSceneLabel,
  composeClassifyInput,
  SceneClassifier,
} from '../src/narration.js';

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
}

console.log(`\n旁白系统 全部 ${passed} 条断言通过`);
