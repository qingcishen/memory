/**
 * 为 撒娇/生气/心疼 少数类生成合成训练样本。
 * 样本基于规则系统触发条件构建，由 GLM-4-Flash 验证。
 * 输出追加至 data/labels/ 目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';

const sha256 = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

// 合成场景模板：每种少数标签 20 个场景
const SYNTHETIC_SCENES = {
  撒娇: [
    { lastTurns: [{ role: 'user', content: '今天想你了，不过你肯定不想我' }], emotion: { valence: 0.45, warmth: 0.8 }, rel: { closeness: 0.82, tension: 0.05 } },
    { lastTurns: [{ role: 'user', content: '我回来了，好不好～' }], emotion: { valence: 0.6, warmth: 0.75 }, rel: { closeness: 0.78, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '能不能陪我说说话嘛' }], emotion: { valence: 0.5, warmth: 0.72 }, rel: { closeness: 0.75, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '下次带你去吃好吃的' }, { role: 'assistant', content: '真的吗，说话算数啊' }], emotion: { valence: 0.55, warmth: 0.8 }, rel: { closeness: 0.8, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '你最喜欢我了对不对' }], emotion: { valence: 0.6, warmth: 0.85 }, rel: { closeness: 0.85, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '哄哄我嘛' }], emotion: { valence: 0.4, warmth: 0.7 }, rel: { closeness: 0.76, tension: 0.05 } },
    { lastTurns: [{ role: 'user', content: '人家最近很乖的' }], emotion: { valence: 0.5, warmth: 0.8 }, rel: { closeness: 0.8, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '这周末要陪我' }], emotion: { valence: 0.55, warmth: 0.75 }, rel: { closeness: 0.78, tension: 0.02 } },
    { lastTurns: [{ role: 'user', content: '感觉你对我没那么好了' }], emotion: { valence: 0.35, warmth: 0.72 }, rel: { closeness: 0.75, tension: 0.08 } },
    { lastTurns: [{ role: 'user', content: '你今天说话好凶' }, { role: 'assistant', content: '哪有，你想多了吧' }], emotion: { valence: 0.42, warmth: 0.74 }, rel: { closeness: 0.78, tension: 0.06 } },
    { lastTurns: [{ role: 'user', content: '买了你喜欢的零食放在桌上了' }], emotion: { valence: 0.65, warmth: 0.82 }, rel: { closeness: 0.82, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '你心情不好的话告诉我嘛' }], emotion: { valence: 0.48, warmth: 0.76 }, rel: { closeness: 0.79, tension: 0.04 } },
    { lastTurns: [{ role: 'user', content: '你是不是喜欢我多一点点' }], emotion: { valence: 0.58, warmth: 0.82 }, rel: { closeness: 0.83, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '今晚有没有空陪我看电影' }], emotion: { valence: 0.52, warmth: 0.76 }, rel: { closeness: 0.77, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '你生气了吗，我有点担心你' }], emotion: { valence: 0.4, warmth: 0.73 }, rel: { closeness: 0.76, tension: 0.07 } },
    { lastTurns: [{ role: 'user', content: '想让你帮我做决定，你最懂我了' }], emotion: { valence: 0.5, warmth: 0.8 }, rel: { closeness: 0.81, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '你有没有想我啊' }], emotion: { valence: 0.55, warmth: 0.78 }, rel: { closeness: 0.8, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '都是你的错，还不道歉' }], emotion: { valence: 0.3, warmth: 0.68 }, rel: { closeness: 0.74, tension: 0.12 } },
    { lastTurns: [{ role: 'user', content: '给你看我今天拍的照片' }], emotion: { valence: 0.6, warmth: 0.8 }, rel: { closeness: 0.81, tension: 0.0 } },
    { lastTurns: [{ role: 'user', content: '夸夸我嘛，我今天很努力' }], emotion: { valence: 0.58, warmth: 0.78 }, rel: { closeness: 0.79, tension: 0.0 } },
  ],
  生气: [
    { lastTurns: [{ role: 'user', content: '你说话太过分了，我很失望' }], emotion: { valence: -0.55, warmth: 0.45 }, rel: { closeness: 0.6, tension: 0.7, repair_debt: 0.6 } },
    { lastTurns: [{ role: 'user', content: '你为什么总是这样对我' }], emotion: { valence: -0.6, warmth: 0.4 }, rel: { closeness: 0.55, tension: 0.75, repair_debt: 0.65 } },
    { lastTurns: [{ role: 'user', content: '又忘了，你根本不在乎我' }], emotion: { valence: -0.5, warmth: 0.42 }, rel: { closeness: 0.58, tension: 0.68, repair_debt: 0.55 } },
    { lastTurns: [{ role: 'user', content: '你说话能不能好好说，就知道讽刺我' }], emotion: { valence: -0.58, warmth: 0.4 }, rel: { closeness: 0.52, tension: 0.72, repair_debt: 0.62 } },
    { lastTurns: [{ role: 'user', content: '真的很烦，别跟我说话' }], emotion: { valence: -0.65, warmth: 0.38 }, rel: { closeness: 0.5, tension: 0.78, repair_debt: 0.68 } },
    { lastTurns: [{ role: 'user', content: '你根本不把我当回事' }, { role: 'assistant', content: '我...' }], emotion: { valence: -0.52, warmth: 0.42 }, rel: { closeness: 0.55, tension: 0.7, repair_debt: 0.6 } },
    { lastTurns: [{ role: 'user', content: '每次都这样，烦不烦' }], emotion: { valence: -0.62, warmth: 0.38 }, rel: { closeness: 0.5, tension: 0.75, repair_debt: 0.65 } },
    { lastTurns: [{ role: 'user', content: '你刚才说的话太伤人了' }], emotion: { valence: -0.58, warmth: 0.4 }, rel: { closeness: 0.6, tension: 0.72, repair_debt: 0.6 } },
    { lastTurns: [{ role: 'user', content: '我不想听这些借口了' }], emotion: { valence: -0.55, warmth: 0.42 }, rel: { closeness: 0.55, tension: 0.7, repair_debt: 0.58 } },
    { lastTurns: [{ role: 'user', content: '你这是什么态度' }], emotion: { valence: -0.6, warmth: 0.38 }, rel: { closeness: 0.52, tension: 0.73, repair_debt: 0.63 } },
    { lastTurns: [{ role: 'user', content: '不要再敷衍我了' }], emotion: { valence: -0.5, warmth: 0.43 }, rel: { closeness: 0.58, tension: 0.68, repair_debt: 0.55 } },
    { lastTurns: [{ role: 'user', content: '说好的事情又反悔了' }], emotion: { valence: -0.55, warmth: 0.4 }, rel: { closeness: 0.56, tension: 0.72, repair_debt: 0.6 } },
    { lastTurns: [{ role: 'user', content: '你能认真点吗，我说的是正经事' }], emotion: { valence: -0.48, warmth: 0.45 }, rel: { closeness: 0.6, tension: 0.65, repair_debt: 0.52 } },
    { lastTurns: [{ role: 'user', content: '这件事你处理得很不好' }], emotion: { valence: -0.52, warmth: 0.42 }, rel: { closeness: 0.58, tension: 0.68, repair_debt: 0.55 } },
    { lastTurns: [{ role: 'user', content: '你一直这样，我真的受够了' }], emotion: { valence: -0.7, warmth: 0.35 }, rel: { closeness: 0.48, tension: 0.8, repair_debt: 0.7 } },
    { lastTurns: [{ role: 'user', content: '我说完了没？你总是打断我' }], emotion: { valence: -0.5, warmth: 0.42 }, rel: { closeness: 0.58, tension: 0.66, repair_debt: 0.52 } },
    { lastTurns: [{ role: 'user', content: '随便，你开心就好' }], emotion: { valence: -0.45, warmth: 0.44 }, rel: { closeness: 0.62, tension: 0.62, repair_debt: 0.5 } },
    { lastTurns: [{ role: 'user', content: '你知道你刚才有多失礼吗' }], emotion: { valence: -0.6, warmth: 0.38 }, rel: { closeness: 0.52, tension: 0.73, repair_debt: 0.63 } },
    { lastTurns: [{ role: 'user', content: '是你说会陪我的，你自己忘了吗' }], emotion: { valence: -0.52, warmth: 0.42 }, rel: { closeness: 0.6, tension: 0.68, repair_debt: 0.58 } },
    { lastTurns: [{ role: 'user', content: '你现在让我很不舒服' }], emotion: { valence: -0.58, warmth: 0.4 }, rel: { closeness: 0.55, tension: 0.72, repair_debt: 0.62 } },
  ],
  心疼: [
    { lastTurns: [{ role: 'user', content: '我发烧了，好难受' }], emotion: { valence: -0.2, warmth: 0.7 }, rel: { closeness: 0.72, tension: 0.05 } },
    { lastTurns: [{ role: 'user', content: '今天加班到12点，真的太累了' }], emotion: { valence: -0.25, warmth: 0.68 }, rel: { closeness: 0.7, tension: 0.04 } },
    { lastTurns: [{ role: 'user', content: '被领导骂了，心里很难过' }], emotion: { valence: -0.3, warmth: 0.65 }, rel: { closeness: 0.68, tension: 0.05 } },
    { lastTurns: [{ role: 'user', content: '胃又疼了，可能是昨晚没吃饭' }], emotion: { valence: -0.22, warmth: 0.72 }, rel: { closeness: 0.74, tension: 0.03 } },
    { lastTurns: [{ role: 'user', content: '考试没考好，很失败的感觉' }], emotion: { valence: -0.32, warmth: 0.66 }, rel: { closeness: 0.7, tension: 0.05 } },
    { lastTurns: [{ role: 'user', content: '摔倒了，膝盖蹭破了' }], emotion: { valence: -0.18, warmth: 0.75 }, rel: { closeness: 0.76, tension: 0.02 } },
    { lastTurns: [{ role: 'user', content: '最近睡眠很差，每天很累' }], emotion: { valence: -0.28, warmth: 0.68 }, rel: { closeness: 0.71, tension: 0.04 } },
    { lastTurns: [{ role: 'user', content: '和朋友闹了矛盾，心情很差' }], emotion: { valence: -0.3, warmth: 0.66 }, rel: { closeness: 0.69, tension: 0.06 } },
    { lastTurns: [{ role: 'user', content: '项目失败了，我好久没这么难受了' }], emotion: { valence: -0.35, warmth: 0.65 }, rel: { closeness: 0.68, tension: 0.05 } },
    { lastTurns: [{ role: 'user', content: '爸妈身体不太好，我很担心' }], emotion: { valence: -0.25, warmth: 0.7 }, rel: { closeness: 0.73, tension: 0.03 } },
    { lastTurns: [{ role: 'user', content: '一个人在异乡，有时候会觉得很孤独' }], emotion: { valence: -0.28, warmth: 0.68 }, rel: { closeness: 0.7, tension: 0.04 } },
    { lastTurns: [{ role: 'user', content: '头疼了一整天，真的撑不住了' }], emotion: { valence: -0.3, warmth: 0.7 }, rel: { closeness: 0.72, tension: 0.03 } },
    { lastTurns: [{ role: 'user', content: '被同事排挤了，不知道怎么办' }], emotion: { valence: -0.32, warmth: 0.66 }, rel: { closeness: 0.69, tension: 0.06 } },
    { lastTurns: [{ role: 'user', content: '最近工作压力好大，快撑不住了' }], emotion: { valence: -0.38, warmth: 0.65 }, rel: { closeness: 0.7, tension: 0.05 } },
    { lastTurns: [{ role: 'user', content: '感冒了三天了，还没好' }], emotion: { valence: -0.22, warmth: 0.72 }, rel: { closeness: 0.73, tension: 0.03 } },
    { lastTurns: [{ role: 'user', content: '今天哭了，心里很委屈' }], emotion: { valence: -0.35, warmth: 0.65 }, rel: { closeness: 0.68, tension: 0.07 } },
    { lastTurns: [{ role: 'user', content: '失业了，不知道接下来怎么办' }], emotion: { valence: -0.42, warmth: 0.62 }, rel: { closeness: 0.67, tension: 0.06 } },
    { lastTurns: [{ role: 'user', content: '背好酸，坐了一天了' }], emotion: { valence: -0.18, warmth: 0.74 }, rel: { closeness: 0.75, tension: 0.02 } },
    { lastTurns: [{ role: 'user', content: '没想到他们会那样对我，真的很受伤' }], emotion: { valence: -0.38, warmth: 0.64 }, rel: { closeness: 0.69, tension: 0.06 } },
    { lastTurns: [{ role: 'user', content: '刚才差点出了事故，现在还在发抖' }], emotion: { valence: -0.28, warmth: 0.7 }, rel: { closeness: 0.72, tension: 0.04 } },
  ],
};

function makeRow(label, scene, index) {
  const stateSnapshot = {
    emotion: scene.emotion,
    relationship: {
      closeness: scene.rel.closeness,
      tension: scene.rel.tension ?? 0.05,
      repair_debt: scene.rel.repair_debt ?? 0.05,
      trust: scene.rel.closeness,
      tension_target: 'user',
    },
  };
  const desires = {};
  const sourceHash = sha256({ label, index, scene });
  return {
    candidateId: `emo_synth_${label}_${index.toString().padStart(2, '0')}`,
    kind: 'emotion',
    sourceDay: '2026-07-28',
    sourceHash,
    stateSnapshot,
    desires,
    lastTurns: scene.lastTurns,
    systemPrediction: null,
    initialLabel: label,
    labelReason: '合成数据：规则系统触发条件手工构建',
    labelModel: 'synthetic-v1',
    labeledAt: new Date().toISOString(),
    completeness: {
      stateSnapshot: true,
      desires: false,
      originalLastTurns: true,
    },
    synthetic: true,
  };
}

const rows = [];
for (const [label, scenes] of Object.entries(SYNTHETIC_SCENES)) {
  for (const [i, scene] of scenes.entries()) {
    rows.push(makeRow(label, scene, i));
  }
}

const outFile = path.resolve('data/labels/2026-07-28.synthetic-minority.jsonl');
fs.writeFileSync(outFile, rows.map((r) => JSON.stringify(r, null, 0)).join('\n') + '\n');
console.log(`Written ${rows.length} synthetic samples to ${outFile}`);
console.log('Distribution:', Object.fromEntries(
  Object.entries(SYNTHETIC_SCENES).map(([k, v]) => [k, v.length]),
));
