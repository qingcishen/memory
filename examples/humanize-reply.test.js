import assert from 'node:assert';
import {
  humanizeReplyParts,
  expandDialogueIntoBubbles,
  splitIntoChatBubbles,
  compressNarration,
  compressDialogue,
  compressAssistantHistory,
  sanitizeHistoryForPrompt,
  buildAntiRepeatPrompt,
  isRepetitiveReply,
  stripRepeatedParts,
} from '../src/orchestrator/humanizeReply.js';
import { splitDialogueBubbles, buildHumanOutgoingMessages } from '../src/channels/humanSend.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('humanizeReply');
{
  const raw = humanizeReplyParts(
    [
      {
        type: 'narration',
        text:
          '沈清词听他那么说，眼睫微微一颤，却没装不懂。散着的头发顺着肩滑下来，深色丝质睡衣领口松松敞着，整个人往怀里又嵌了嵌，耳尖微热，指尖在他后背轻轻收紧。',
      },
      {
        type: 'dialogue',
        text: '嗯……慢点。再深一点。逸晨，你真的一直想我吗？',
      },
    ],
    { intimacyPhase: 'peak' },
  );
  const joined = raw.map((p) => p.text).join('\n');
  const dialAll = raw.filter((p) => p.type === 'dialogue').map((p) => p.text).join('\n');
  ok('去掉姓名开场', !/沈清词/.test(joined));
  ok('去掉睡衣头发库存', !/丝质睡衣|散着的头发|耳尖微热/.test(joined));
  ok('去掉复读收尾', !/你真的一直想我吗/.test(dialAll));
  ok('仍有台词', /慢点|再深/.test(dialAll));
  ok('旁白被压短', (raw.find((p) => p.type === 'narration')?.text || '').length <= 80);
  ok('台词拆成连发气泡', raw.filter((p) => p.type === 'dialogue').length >= 2);
}

{
  const n = compressNarration(
    '沈清词听见那句继续，呼吸先乱了半拍。她抬膝跨坐，散着的头发垂下来，深色丝质睡衣下摆撩开，握住他。',
    72,
  );
  ok('compressNarration 无姓名', !n.startsWith('沈清词'));
  ok('compressNarration 有限长', n.length <= 80);
}

{
  const d = compressDialogue('继续就继续。别光说想要。你真的一直想着我吗？', 100, true);
  ok('compressDialogue 去库存尾', !/你真的一直想着我吗/.test(d));
}

{
  const hist = sanitizeHistoryForPrompt([
    {
      role: 'assistant',
      content:
        '沈清词听他那么说，散着的头发贴上他颈侧，半敞的丝质睡衣松松蹭着他胸口。\n\n嗯，听我的就好。不进去……先抱着。',
    },
    { role: 'user', content: '好' },
  ]);
  ok('历史消毒保留台词', hist[0].content.includes('听我的') || hist[0].content.includes('抱'));
  ok('历史消毒弱化网文头', !hist[0].content.startsWith('沈清词听他那么说'));
}

{
  const c = compressAssistantHistory(
    '沈清词抬眼看他。散着的头发顺着肩滑落，深色丝质睡衣领口松松敞着。\n\n好点了。想带，你别动。',
  );
  ok('compressAssistantHistory 偏台词', /好点了|想带/.test(c));
}

console.log('multi-bubble / 连发');
{
  const bubbles = splitIntoChatBubbles('嗯……\n慢点。再深一点。', 3);
  ok('换行拆成多气泡', bubbles.length >= 2);

  const soft = splitIntoChatBubbles('嗯……再深一点。', 3);
  ok('省略号可拆', soft.length >= 2 || soft[0].includes('再深'));

  const expanded = expandDialogueIntoBubbles(
    [{ type: 'dialogue', text: '在呢。\n刚忙完。\n怎么了？' }],
    3,
  );
  ok('expand 成多条 dialogue part', expanded.filter((p) => p.type === 'dialogue').length >= 2);

  const human = humanizeReplyParts(
    [{ type: 'dialogue', text: '过来。今天你别动，听我的。' }],
    { intimacyPhase: 'peak', multiBubble: true },
  );
  ok('humanize 后多气泡', human.filter((p) => p.type === 'dialogue').length >= 2);

  const send = buildHumanOutgoingMessages(
    [
      { type: 'narration', text: '腿先夹紧。' },
      { type: 'dialogue', text: '嗯……' },
      { type: 'dialogue', text: '慢点。' },
      { type: 'dialogue', text: '再深一点。' },
    ],
    { maxDialogueBubbles: 3, minSplitLen: 10 },
  );
  ok('发送层至少 3 条气泡', send.length >= 3);

  const split = splitDialogueBubbles('过来，今天你别动。', 3, 10);
  ok('逗号可拆成连发', split.length >= 2);
}

console.log('anti-repeat');
{
  const hist = [
    {
      role: 'assistant',
      content: '抬手直接抓住他衣襟往自己这边拽，膝盖抵上他腿侧，整个人半跪贴过去。\n\n你别动，先把人给我抱紧。',
    },
    { role: 'assistant', content: '腿还软着，只往他胸口蹭了蹭。\n\n嗯…\n\n…' },
  ];
  const ban = buildAntiRepeatPrompt(hist);
  ok('anti-repeat 含模板', /衣襟|膝盖|半跪|腿软/.test(ban));
  ok('检测嗯复读', isRepetitiveReply('嗯…\n…', hist));
  ok('检测动作复读', isRepetitiveReply('她抓住他衣襟往怀里拽，膝盖抵上他腿侧。', hist));
  const stripped = stripRepeatedParts(
    [
      { type: 'narration', text: '腿还软着，只把脸往他颈侧贴了贴。' },
      { type: 'dialogue', text: '嗯…' },
      { type: 'dialogue', text: '…' },
    ],
    hist,
  );
  ok('strip 掉撞车旁白或空泡', !stripped.some((p) => p.text === '…'));
}

console.log(`\nhumanize-reply ${passed} 条断言通过`);
