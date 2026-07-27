// bench:clean —— 清除本地评测产物 + 数据库里所有 bench_ 前缀用户的数据。
// 评测数据与生产数据的隔离约定 (v3 §1.4): 评测只写 bench_ 开头的 user_id, 因此按前缀删除是安全的。

import fs from 'node:fs';
import path from 'node:path';

const TABLES = [
  'memories', 'knowledge_entities', 'knowledge_relations', 'affective_state', 'life_state',
  'affective_state_history', 'prospective', 'proactive_rate_limits', 'behavior_state', 'story_lines',
  'companions', 'appearance_assets', 'companion_card_assets', 'album_custom_entries', 'jobs',
  'chat_history', 'chat_session_state', 'chat_emotion_residue', 'channel_events', 'world_state',
];

fs.rmSync(path.resolve('bench/results'), { recursive: true, force: true });
console.log('本地 bench/results 已清除。');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.log('未配置 Supabase 凭证, 跳过数据库清理 (离线单测不产生 DB 数据)。');
  process.exit(0);
}

const { supabase } = await import('../src/config.js');
let leftover = 0;
for (const table of TABLES) {
  const { error } = await supabase.from(table).delete().like('user_id', 'bench\\_%');
  if (error) {
    // 表不存在 / 无 user_id 列: 跳过即可, 不算失败
    console.log(`- ${table}: 跳过 (${error.message})`);
    continue;
  }
  const { count, error: countError } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .like('user_id', 'bench\\_%');
  const remain = countError ? '?' : count ?? 0;
  if (typeof remain === 'number') leftover += remain;
  console.log(`- ${table}: 已清, 残留 ${remain}`);
}
if (leftover > 0) {
  console.error(`⚠️ 仍有 ${leftover} 行 bench_ 数据残留, 请检查上面的输出。`);
  process.exit(1);
}
console.log('数据库 bench_ 数据已全部清除 ✓');
