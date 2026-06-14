// M1 纯逻辑测试: 关系-情感状态机。不连网。
// 验收 (见 docs/DEVELOPMENT.md M1):
//   - 吵架轮次后 tension/repair_debt 上升; 和好轮次后回落、closeness 升
//   - 无新输入时 mood 随时间向基线衰减
import assert from 'node:assert';
import {
  defaultState,
  clampState,
  decayState,
  applyDeltas,
  inferHeuristicDeltas,
  moodLabel,
  stateDelta,
  moodShiftMagnitude,
  labelStateEvent,
  detectTensionTarget,
  summarizeTrajectory,
  formatTrajectory,
} from '../src/state/affect.js';
import { applyMoodShiftBoost } from '../src/extract.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('defaultState / clampState');
{
  const d = defaultState();
  ok('基线 valence=0', d.mood.valence === 0);
  ok('基线 closeness=0.5', d.relationship.closeness === 0.5);
  const c = clampState({ mood: { valence: 9, arousal: -5 }, relationship: { tension: 2 } });
  ok('越界 valence 裁剪到 1', c.mood.valence === 1);
  ok('越界 arousal 裁剪到 0', c.mood.arousal === 0);
  ok('越界 tension 裁剪到 1', c.relationship.tension === 1);
  ok('缺失字段补基线 trust=0.5', c.relationship.trust === 0.5);
}

console.log('inferHeuristicDeltas (从对话嗅信号)');
{
  const fight = inferHeuristicDeltas([{ role: 'user', content: '你怎么又这样, 我真的很生气, 别理我了' }]);
  ok('吵架: tension 增量 > 0', fight.relationship.tension > 0);
  ok('吵架: repair_debt 增量 > 0', fight.relationship.repair_debt > 0);
  ok('吵架: 心情 valence 转负', fight.mood.valence < 0);

  const makeup = inferHeuristicDeltas([{ role: 'user', content: '对不起嘛, 是我错了, 别生气了好不好' }]);
  ok('和好: repair_debt 增量 < 0 (清债)', makeup.relationship.repair_debt < 0);
  ok('和好: tension 增量 < 0', makeup.relationship.tension < 0);
  ok('和好: closeness 增量 > 0', makeup.relationship.closeness > 0);

  // AI 的话不该影响状态 (只看对方)
  const aiOnly = inferHeuristicDeltas([{ role: 'assistant', content: '我很生气, 吵架' }]);
  ok('只看对方: AI 的话不产生信号', aiOnly.relationship.tension === 0);
}

console.log('applyDeltas (吵架→和好 的状态因果)');
{
  // 单次吵架: 状态被推动, 但单步上限保证一句话还不至于翻脸
  const fightDelta = inferHeuristicDeltas([{ role: 'user', content: '我很生气, 你太让我失望了' }]);
  const once = applyDeltas(defaultState(), fightDelta);
  ok('吵架后 tension 上升', once.relationship.tension > 0);
  ok('吵架后 repair_debt 上升', once.relationship.repair_debt > 0);
  ok('吵架后心情低落', once.mood.valence < 0);

  // 越吵越凶 (信号累积) 才跨进"受伤/闹脾气"
  const fought = applyDeltas(once, fightDelta);
  ok('持续吵架累积后 tension 更高', fought.relationship.tension > once.relationship.tension);
  ok('升级吵架后标签=受伤/闹脾气', moodLabel(fought) === '受伤/闹脾气');

  // 在"吵架"状态上和好
  const reconciled = applyDeltas(
    fought,
    inferHeuristicDeltas([{ role: 'user', content: '对不起, 我错了, 我们和好吧, 亲亲' }])
  );
  ok('和好后 repair_debt 较吵架时回落', reconciled.relationship.repair_debt < fought.relationship.repair_debt);
  ok('和好后 tension 较吵架时回落', reconciled.relationship.tension < fought.relationship.tension);
  ok('和好后 closeness 较吵架时上升', reconciled.relationship.closeness > fought.relationship.closeness);
}

console.log('applyDeltas 单步上限 (防一句话推爆)');
{
  const cap = PARAMS.state.maxStepPerTurn;
  const pushed = applyDeltas(defaultState(), { relationship: { tension: 99 } });
  ok('单轮 tension 推动不超过 maxStepPerTurn', Math.abs(pushed.relationship.tension - 0) <= cap + 1e-9);
}

console.log('decayState (无输入时 mood 向基线回落)');
{
  const excited = clampState({ mood: { valence: 0.8, arousal: 0.9 }, relationship: { tension: 0.6, closeness: 0.9, repair_debt: 0.5 } });

  const after1h = decayState(excited, 1);
  ok('1h 后 valence 朝 0 回落 (绝对值变小)', Math.abs(after1h.mood.valence) < Math.abs(excited.mood.valence));
  ok('1h 后 arousal 朝基线 0.3 回落', after1h.mood.arousal < excited.mood.arousal && after1h.mood.arousal > 0.3);

  // 半衰期处恰好走一半
  const hl = PARAMS.state.halfLifeHours.valence;
  const atHalf = decayState({ mood: { valence: 0.8, arousal: 0.3 }, relationship: {} }, hl);
  ok('valence 在半衰期处约等于一半', Math.abs(atHalf.mood.valence - 0.4) < 1e-6);

  // mood 已平复, 但关系黏着字段不随时间动
  const longAfter = decayState(excited, 1000);
  ok('久置后 valence ≈ 基线 0', Math.abs(longAfter.mood.valence) < 0.02);
  ok('closeness 不随时间衰减 (黏着)', longAfter.relationship.closeness === excited.relationship.closeness);
  ok('repair_debt 不随时间消失 (只和好才清)', longAfter.relationship.repair_debt === excited.relationship.repair_debt);
  ok('tension 随时间缓和但比 mood 慢', longAfter.relationship.tension < excited.relationship.tension);
}

console.log('stateDelta / labelStateEvent (历史快照触发与事件标签)');
{
  const base = defaultState();
  ok('相同状态 delta=0', stateDelta(base, base) === 0);
  const fought = applyDeltas(base, inferHeuristicDeltas([{ role: 'user', content: '我很生气, 太失望了' }]));
  ok('吵架后 delta 明显 > 0', stateDelta(base, fought) > 0.3);
  ok('吵架被标为"吵架"', labelStateEvent(base, fought) === '吵架');
  const reconciled = applyDeltas(fought, inferHeuristicDeltas([{ role: 'user', content: '对不起, 我错了, 和好吧' }]));
  ok('和好被标为"和好"', labelStateEvent(fought, reconciled) === '和好');
  ok('微小变化无事件标签', labelStateEvent(base, applyDeltas(base, { mood: { valence: 0.01 } })) === null);
}

console.log('moodShiftMagnitude / applyMoodShiftBoost (情绪 → 记忆重要性, emotion-design.md §8)');
{
  const base = defaultState();
  ok('相同状态 moodShift=0', moodShiftMagnitude(base, base) === 0);

  const fought = applyDeltas(base, inferHeuristicDeltas([{ role: 'user', content: '我很生气, 太失望了' }]));
  const shift = moodShiftMagnitude(base, fought);
  ok('吵架后 moodShift 达到单轮上限 (两个 mood 字段都被推满)', Math.abs(shift - 0.6) < 1e-9);

  const mems = [{ fact_core: '诗雅很生气', importance: 5 }];
  ok('心情位移在阈值以下时 importance 不变', applyMoodShiftBoost(mems, 0)[0].importance === 5);
  ok('心情位移达到满额时 importance 加满额', applyMoodShiftBoost(mems, shift)[0].importance === 7);
  ok('心情位移在阈值与满额之间按比例加成', Math.abs(applyMoodShiftBoost(mems, 0.375)[0].importance - 6) < 1e-9);

  const maxed = applyMoodShiftBoost([{ fact_core: 'x', importance: 9.5 }], shift);
  ok('importance 加成后仍夹在 10 以内', maxed[0].importance === 10);
}

console.log('summarizeTrajectory / formatTrajectory (关系走向)');
{
  ok('空历史 points=0', summarizeTrajectory([]).points === 0);
  const history = [
    { mood: { valence: 0, arousal: 0.3 }, relationship: { closeness: 0.4, tension: 0.1, repair_debt: 0, trust: 0.4 }, created_at: '2026-01-01' },
    { mood: { valence: -0.5, arousal: 0.8 }, relationship: { closeness: 0.4, tension: 0.7, repair_debt: 0.6, trust: 0.4 }, created_at: '2026-02-01' },
    { mood: { valence: 0.3, arousal: 0.3 }, relationship: { closeness: 0.6, tension: 0.2, repair_debt: 0.0, trust: 0.6 }, created_at: '2026-03-01' },
  ];
  const s = summarizeTrajectory(history);
  ok('统计到 3 个点', s.points === 3);
  ok('亲密度上升趋势', s.closenessTrend === 'rising');
  ok('信任上升趋势', s.trustTrend === 'rising');
  ok('捕捉到紧张峰值', s.peakTension >= 0.7);
  ok('数到 1 次和好 (repair_debt 大幅回落)', s.repairs === 1);
  const txt = formatTrajectory(s);
  ok('轨迹文本提到越来越亲近', txt.includes('亲近'));
  ok('轨迹文本提到争执', txt.includes('争执'));
  ok('空轨迹 → 空串', formatTrajectory(summarizeTrajectory([])) === '');
}

console.log('#5 情绪指向性 (tension 冲着谁/为了什么)');
{
  // 默认指向 user, 保持旧语义
  ok('defaultState: tension_target 默认 user', defaultState().relationship.tension_target === 'user');
  ok('defaultState: tension_topic 默认 null', defaultState().relationship.tension_topic === null);

  // detectTensionTarget 纯逻辑
  ok('冲着用户: "你怎么又这样" → user', detectTensionTarget('你怎么又这样, 烦死了').target === 'user');
  const ext = detectTensionTarget('明天要考试了, 压力好大快崩溃');
  ok('为外部事焦虑 → external', ext.target === 'external');
  ok('external 抓出话题 (考试)', ext.topic === '考试');
  ok('没明显线索默认 user', detectTensionTarget('今天天气不错').target === 'user');

  // applyDeltas: tension 上升时采纳指向; clampState 校验非法 target
  const fightExt = applyDeltas(defaultState(), {
    relationship: { tension: 0.3, tension_target: 'external', tension_topic: '工作' },
  });
  ok('applyDeltas: tension 升 → 采纳 external 指向', fightExt.relationship.tension_target === 'external');
  ok('applyDeltas: 采纳话题', fightExt.relationship.tension_topic === '工作');
  const noTension = applyDeltas(defaultState(), {
    relationship: { closeness: 0.1, tension_target: 'external', tension_topic: '考试' },
  });
  ok('applyDeltas: tension 没升则不采纳新指向', noTension.relationship.tension_target === 'user');
  ok('clampState: 非法 target 回退 user', clampState({ relationship: { tension_target: 'xyz' } }).relationship.tension_target === 'user');

  // decayState: tension 缓和回基线下后, 清空指向
  const cleared = decayState(
    { mood: { valence: 0 }, relationship: { tension: 0.02, tension_target: 'external', tension_topic: '考试' } },
    0
  );
  ok('decayState: tension 低于阈值 → target 回 user', cleared.relationship.tension_target === 'user');
  ok('decayState: tension 低于阈值 → topic 清空', cleared.relationship.tension_topic === null);
}

console.log(`\nM1 全部 ${passed} 条断言通过 ✅`);
