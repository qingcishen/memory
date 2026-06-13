// M7 · 调试工具: 打印某用户的完整记忆画像。
//   npm run inspect <userId>
// 输出: 关系-情感状态 + 记忆 (按 subject_kind 分组, 带激活明细) + 待触发的预期记忆。
// 需要真实 .env 凭证 (连 Supabase 只读)。

import { supabase } from '../src/config.js';
import { readState, moodLabel } from '../src/state/affect.js';
import { scoreActivation } from '../src/engine/activation.js';

const userId = process.argv[2];
if (!userId) {
  console.error('用法: npm run inspect <userId>');
  process.exit(1);
}

const hr = (t) => console.log(`\n${'─'.repeat(50)}\n${t}\n${'─'.repeat(50)}`);
const f = (x) => (typeof x === 'number' ? x.toFixed(2) : '—');

async function main() {
  hr(`关系-情感状态  ·  ${userId}`);
  const state = await readState(userId);
  const r = state.relationship;
  console.log(`心情: ${moodLabel(state)}  (valence=${f(state.mood.valence)}, arousal=${f(state.mood.arousal)})`);
  console.log(`关系: 亲密 ${f(r.closeness)} | 紧张 ${f(r.tension)} | 信任 ${f(r.trust)} | 待和好 ${f(r.repair_debt)}`);
  console.log(`更新于: ${state.updated_at ?? '(从未, 用基线)'}`);

  hr('记忆 (按主体分组, 含激活明细)');
  const { data: mems, error } = await supabase
    .from('memories')
    .select('*')
    .eq('user_id', userId)
    .is('superseded_by', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!mems || mems.length === 0) {
    console.log('  (没有记忆)');
  } else {
    const scored = scoreActivation(
      mems.map((m) => ({ ...m, similarity: 0 })), // 无 query, 只看 base/mood/mile 的常驻激活
      state
    );
    for (const kind of ['user', 'self', 'dyad']) {
      const group = scored.filter((m) => (m.subject_kind ?? 'user') === kind);
      if (group.length === 0) continue;
      console.log(`\n[${kind}] ${group.length} 条`);
      for (const m of group) {
        const a = m._act;
        const tags = [m.modality !== 'text' ? m.modality : null, m.fact_locked ? '🔒' : null, m.access_count ? `×${m.access_count}` : null]
          .filter(Boolean)
          .join(' ');
        console.log(
          `  act=${f(m._activation)} [B=${f(a.B)} mood=${f(a.mood)} mile=${f(a.mile)}]  ${m.fact_core ?? m.content}  ${tags}`
        );
        if (m.narrative) console.log(`        ↳ ${m.narrative}  (重构 ${m.reconsolidation_count ?? 0} 次)`);
      }
    }
  }

  hr('预期记忆 (待触发)');
  const { data: pros } = await supabase
    .from('prospective')
    .select('content, trigger_kind, trigger_at, status')
    .eq('user_id', userId)
    .eq('status', 'pending');
  if (!pros || pros.length === 0) console.log('  (无)');
  else for (const p of pros) console.log(`  [${p.trigger_kind} @ ${p.trigger_at ?? 'cue'}] ${p.content}`);

  console.log('');
}

main().catch((e) => {
  console.error('出错:', e.message);
  process.exit(1);
});
