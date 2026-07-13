import assert from 'node:assert';
import { pickReplyFormat } from '../src/orchestrator/llm.js';
import { splitDialogueBubbles, buildHumanOutgoingMessages, deliverHumanBubbles } from '../src/channels/humanSend.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('pickReplyFormat');
{
  ok('日常 plain', pickReplyFormat({ sceneLocks: [], intimacyPhase: 'none' }) === 'plain');
  ok('亲密 json', pickReplyFormat({ sceneLocks: [{ id: 'intimate' }] }) === 'json');
  ok('车内 json', pickReplyFormat({ sceneLocks: [{ id: 'car' }] }) === 'json');
  ok('foreplay json', pickReplyFormat({ intimacyPhase: 'foreplay' }) === 'json');
  ok('强制 plain', pickReplyFormat({ sceneLocks: [{ id: 'intimate' }], forceFormat: 'plain' }) === 'plain');
}

console.log('splitDialogueBubbles / human send');
{
  ok('短句不拆', splitDialogueBubbles('嗯。', 3, 28).length === 1);
  const long = '今天好累。加班到很晚。想你了。';
  const bubbles = splitDialogueBubbles(long, 3, 10);
  ok('长句可拆', bubbles.length >= 2);
  const msgs = buildHumanOutgoingMessages([
    { type: 'narration', text: '她揉了揉眼睛' },
    { type: 'dialogue', text: '好累。想你了。早点睡。' },
  ], { minSplitLen: 5, maxDialogueBubbles: 3 });
  ok('旁白单独一条', msgs[0].type === 'narration');
  ok('台词至少一条', msgs.some((m) => m.type === 'dialogue'));
  ok('总数>=2', msgs.length >= 2);

  const sent = [];
  await deliverHumanBubbles(
    [
      { type: 'narration', text: '她笑了' },
      { type: 'dialogue', text: '想你。早点睡。' },
    ],
    async (t) => sent.push(t),
    { skipDelay: true, minSplitLen: 5 },
  );
  ok('deliverHumanBubbles 发出多条', sent.length >= 2);
}

console.log(`\nhuman-send 全部 ${passed} 条断言通过 ✅`);
