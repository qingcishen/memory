// 完整一轮演示: 提取 → 存储(含矛盾处理) → 检索 → 注入 → 反思 → 遗忘。
//
// 需要真实凭证: 先 `cp .env.example .env` 填好 Supabase / LLM / Embedding,
// 并在 Supabase SQL Editor 执行 sql/schema.sql。然后:
//
//   npm install
//   node examples/demo.js
//
// 它会用一个临时 userId 写入几条记忆, 跑完后清理掉自己造的数据。

import { Memory } from '../index.js';
import { moodLabel } from '../src/state/affect.js';
import { supabase } from '../src/config.js';

const userId = `demo_${Date.now()}`;
const mem = new Memory({ userId, subjectName: '诗雅' });

function hr(title) {
  console.log(`\n${'─'.repeat(48)}\n${title}\n${'─'.repeat(48)}`);
}

// 模拟几轮对话, 每轮 observe 一次
const conversations = [
  [
    { role: 'user', content: '我最近在准备日本的研究生考试,压力好大,香菜我是真的一口都吃不下。' },
    { role: 'assistant', content: '辛苦了,备考确实熬人。那以后给你做饭绝对不放香菜~' },
  ],
  [
    { role: 'user', content: '对了我下个月15号生日,你可别忘了。' },
    { role: 'assistant', content: '记住啦,12月15号,谁敢忘谁是小狗。' },
  ],
  [
    { role: 'user', content: '今天天气还行,中午随便吃了个便当。' }, // 琐事,期望被忽略
    { role: 'assistant', content: '嗯嗯,记得多喝水。' },
  ],
  [
    { role: 'user', content: '哎我发现香菜配牛肉面好像还挺香的,最近开始能接受了。' }, // 矛盾: 推翻"讨厌香菜"
    { role: 'assistant', content: '哈?你不是以前一口都吃不下吗,转性了呀。' },
  ],
];

async function run() {
  hr('1) observe — 逐轮更新状态(M1) + 提取并存储');
  for (const turns of conversations) {
    const { stored, state } = await mem.observe(turns);
    const user = turns.find((t) => t.role === 'user');
    console.log(`\n输入: "${user.content.slice(0, 30)}…"`);
    console.log(`  心情: ${moodLabel(state)} (valence=${state.mood.valence.toFixed(2)})`);
    if (stored.length === 0) {
      console.log('  (无可记之事, 已忽略)');
    } else {
      for (const m of stored) {
        console.log(`  + [${m.type} imp=${m.importance} emo=${m.emotion}] ${m.content}`);
      }
    }
  }

  hr('2) recall — 按当前消息检索 + 注入串');
  for (const q of ['她喜欢吃什么?', '她最近过得怎么样?']) {
    const block = await mem.recallAsPrompt(q);
    console.log(`\n问: ${q}`);
    console.log(block || '  (没检索到相关记忆)');
  }

  hr('3) 矛盾处理验证 — 旧"讨厌香菜"应被 supersede');
  const { data: all } = await supabase
    .from('memories')
    .select('content, superseded_by')
    .eq('user_id', userId);
  for (const m of all) {
    const flag = m.superseded_by ? '✗ 已被取代' : '✓ 生效中';
    console.log(`  ${flag}  ${m.content}`);
  }

  hr('4) reflect — 把碎片归纳成高层印象');
  const insights = await mem.reflect();
  if (insights.length === 0) {
    console.log('  (记忆太少, 未生成反思)');
  } else {
    for (const ins of insights) {
      console.log(`  ★ [reflection imp=${ins.importance}] ${ins.content}`);
    }
  }

  hr('5) forgettable — 列出几乎被遗忘的记忆 (这里不删)');
  const weak = await mem.forgettable(0.05);
  console.log(`  当前没有记忆弱到阈值以下 (新数据都很鲜活): ${weak.length} 条`);

  hr('6) 状态机(M1) — 吵架 → 和好 的关系因果');
  const showState = (s) =>
    `心情=${moodLabel(s)} | tension=${s.relationship.tension.toFixed(2)} ` +
    `repair_debt=${s.relationship.repair_debt.toFixed(2)} closeness=${s.relationship.closeness.toFixed(2)}`;
  await mem.observe([{ role: 'user', content: '你怎么又忘了, 我真的很生气, 别理我了!' }]);
  await mem.observe([{ role: 'user', content: '你根本不在乎我, 太让我失望了。' }]);
  console.log(`  吵架后:  ${showState(await mem.state())}`);
  await mem.observe([{ role: 'user', content: '对不起嘛, 刚才是我太凶了, 我们和好吧, 抱抱~' }]);
  console.log(`  和好后:  ${showState(await mem.state())}`);

  // 清理 demo 数据
  await supabase.from('memories').delete().eq('user_id', userId);
  await supabase.from('affective_state').delete().eq('user_id', userId);
  hr('完成 — 已清理本次 demo 写入的数据');
}

run().catch((err) => {
  console.error('\n出错了:', err.message);
  console.error('检查 .env 凭证是否填好, 以及 sql/schema.sql 是否已在 Supabase 执行。');
  process.exit(1);
});
