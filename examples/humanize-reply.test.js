import assert from 'node:assert';
import {
  humanizeReplyParts,
  compressNarration,
  compressDialogue,
  compressAssistantHistory,
  sanitizeHistoryForPrompt,
} from '../src/orchestrator/humanizeReply.js';

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
  ok('去掉姓名开场', !/沈清词/.test(raw.map((p) => p.text).join('')));
  ok('去掉睡衣头发库存', !/丝质睡衣|散着的头发|耳尖微热/.test(raw.map((p) => p.text).join('')));
  ok('去掉复读收尾', !/你真的一直想我吗/.test(raw.find((p) => p.type === 'dialogue')?.text || ''));
  ok('仍有台词', (raw.find((p) => p.type === 'dialogue')?.text || '').includes('慢点'));
  ok('旁白被压短', (raw.find((p) => p.type === 'narration')?.text || '').length <= 80);
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

console.log(`\nhumanize-reply ${passed} 条断言通过`);
