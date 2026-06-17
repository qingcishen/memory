// 一次性把 companions/default.json 里全部 knowledge 条目灌进 self 记忆。
// 用法: node scripts/seed-knowledge-now.js
// 默认 userId=telegram:8210906354, companionId=default

import dotenv from 'dotenv';
import fs from 'node:fs';
import { dailyTraining, selfFactCores } from '../src/training.js';
import { personaJsonToConfig } from '../src/companion.js';

dotenv.config();

const USER_ID = process.env.SEED_USER_ID || 'telegram:8210906354';
const COMPANION_ID = process.env.SEED_COMPANION_ID || 'default';
const PERSONA_FILE = process.env.SEED_PERSONA_FILE || 'companions/default.json';

const json = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'));
const { config } = personaJsonToConfig(json);
const bank = config.knowledgeBank ?? [];

console.log(`\n灌入目标: ${USER_ID} / ${COMPANION_ID}`);
console.log(`知识库条数: ${bank.length}`);

// 先看已有多少
const existing = await selfFactCores(USER_ID, COMPANION_ID).catch(() => new Set());
const pending = bank.filter(item => {
  const fact = typeof item === 'string' ? item : item?.fact_core;
  return fact && !existing.has(fact);
});
console.log(`已灌入: ${existing.size}  待灌入: ${pending.length}\n`);

if (pending.length === 0) {
  console.log('全部知识已在记忆中，无需重复灌入。');
  process.exit(0);
}

// 一次性全部灌入（limit = pending.length）
const result = await dailyTraining(USER_ID, COMPANION_ID, {
  knowledgeBank: bank,
  limit: pending.length,
  llm: null,  // 不写自我日记，只灌知识
});

console.log(`✓ 成功灌入 ${result.seeded.length} 条知识到 self 记忆`);
if (result.seeded.length > 0) {
  console.log('\n灌入的条目:');
  result.seeded.forEach((m, i) => {
    const text = m?.fact_core ?? m;
    console.log(`  ${i + 1}. ${String(text).slice(0, 60)}…`);
  });
}
