// M7 · 调试工具: 打印某用户的完整记忆画像。
//   npm run inspect <userId>
// 输出: 关系-情感状态 + 记忆 (按 subject_kind 分组, 带激活明细) + 待触发的预期记忆。
// 需要真实 .env 凭证 (连 Supabase 只读)。

import { supabase } from '../src/config.js';
import { readState, moodLabel } from '../src/state/affect.js';
import { scoreActivation } from '../src/engine/activation.js';
import { driftFromOrigin } from '../src/memory/reconsolidate.js';
import { dailyCost, query as queryTraces, traceDay } from '../src/trace.js';

const userId = process.argv[2];
if (!userId) {
  console.error('用法: npm run inspect <userId> | npm run inspect -- trace [YYYY-MM-DD] [userId]');
  process.exit(1);
}

const hr = (t) => console.log(`\n${'─'.repeat(50)}\n${t}\n${'─'.repeat(50)}`);
const f = (x) => (typeof x === 'number' ? x.toFixed(2) : '—');

async function main() {
  if (userId === 'trace') {
    const day = process.argv[3] ?? traceDay();
    const traceUserId = process.argv[4];
    const traces = queryTraces({ day, userId: traceUserId });
    console.log(JSON.stringify({ summary: dailyCost(day), traces }, null, 2));
    return;
  }
  hr(`关系-情感状态  ·  ${userId}`);
  const state = await readState(userId);
  const r = state.relationship;
  console.log(`心情: ${moodLabel(state)}  (valence=${f(state.mood.valence)}, arousal=${f(state.mood.arousal)})`);
  console.log(`关系: 亲密 ${f(r.closeness)} | 紧张 ${f(r.tension)} | 信任 ${f(r.trust)} | 待和好 ${f(r.repair_debt)}`);
  console.log(`更新于: ${state.updated_at ?? '(从未, 用基线)'}`);
  try {
    const { readIntimacy } = await import('../src/state/intimacy.js');
    const intimacy = await readIntimacy(userId);
    console.log(
      `亲密: phase=${intimacy.scene_phase} | 唤起 ${f(intimacy.arousal)} | 张力 ${f(intimacy.sexual_tension)} | 满足 ${f(intimacy.satisfaction)} | 事后需 ${f(intimacy.aftercare_need)} | consent=${intimacy.consent?.active}`
    );
  } catch {
    /* 列未迁移时忽略 */
  }

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
        const drift = driftFromOrigin(m);
        const driftTag = Math.abs(drift.valence) > 0.01 ? `漂移${drift.valence > 0 ? '+' : ''}${f(drift.valence)}` : null;
        const tags = [m.modality !== 'text' ? m.modality : null, m.fact_locked ? '🔒' : null, m.access_count ? `×${m.access_count}` : null, driftTag]
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
