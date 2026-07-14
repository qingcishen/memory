// I 线亲密系统纯逻辑测试。不连网。
import assert from 'node:assert';
import {
  IntimacyDimension,
  applyIntimacyDeltas,
  capPhase,
  clampIntimacy,
  defaultIntimacy,
  detectIntimacySignals,
  evolveIntimacyOverTime,
  intimacyUrgency,
  maxAllowedPhase,
  mergeIntimacyConfig,
  prepareIntimacyForTurn,
  settleIntimacyFromTurns,
  toIntimacyPrompt,
} from '../src/state/intimacy.js';
import { buildNarrationPrompt } from '../src/narration.js';
import { buildConversationGoals } from '../src/orchestrator/goals.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log('  ✓', name);
  passed++;
}

console.log('intimacy pure logic');
ok('默认字段齐全', defaultIntimacy().scene_phase === 'none' && defaultIntimacy().consent.active === false);
ok('标量钳制在 0..1', clampIntimacy({ arousal: 3, satisfaction: -1 }).arousal === 1 && clampIntimacy({ arousal: 3, satisfaction: -1 }).satisfaction === 0);

const seeded = clampIntimacy({ sexual_tension: 0.2, last_intimate_at: '2026-01-01T00:00:00.000Z', satisfaction: 0.4 });
const afterDays = evolveIntimacyOverTime(seeded, 72);
ok('有种子时张力随时间上升', afterDays.sexual_tension > seeded.sexual_tension);
ok('唤起随时间回落', evolveIntimacyOverTime({ ...defaultIntimacy(), arousal: 0.9 }, 12).arousal < 0.5);

// stop_signal 曾经是死锁：maxAllowedPhase 见 stop_signal=true 就把 maxPhase 钉死 'none'，
// 而 settleIntimacyFromTurns 里所有清它的分支都要求 maxPhase !== 'none'——一旦置真，正常对话
// 信号永远清不掉它，"停"过一次之后就算只是重新亲一下也会被永久按"温柔拒绝"的指令写。
const stopped = clampIntimacy({ consent: { active: false, pace: 'normal', stop_signal: true } });
ok('stop_signal 卡死 maxAllowedPhase 在 none（回归防护，确认死锁场景真实存在）', maxAllowedPhase({ intimacy: stopped, relationship: { closeness: 0.9, trust: 0.9 }, life: { energy: 0.9 } }) === 'none');
ok('stop_signal 未满 12 小时不重置', evolveIntimacyOverTime(stopped, 8).consent.stop_signal === true);
ok('stop_signal 满 12 小时后自动重置（此前无任何信号路径能清掉它）', evolveIntimacyOverTime(stopped, 12).consent.stop_signal === false);
ok('重置后 maxAllowedPhase 不再被钉死 none', maxAllowedPhase({ intimacy: evolveIntimacyOverTime(stopped, 12), relationship: { closeness: 0.9, trust: 0.9 }, life: { energy: 0.9 } }) !== 'none');

const lowClose = maxAllowedPhase({ relationship: { closeness: 0.2, trust: 0.5, tension: 0, repair_debt: 0 }, life: { energy: 0.8 } });
ok('低亲密最多 flirting', lowClose === 'flirting');
const fight = maxAllowedPhase({ relationship: { closeness: 0.9, trust: 0.8, tension: 0.85, repair_debt: 0.6 }, life: { energy: 0.8 } });
ok('高 tension 门控 flirting', fight === 'flirting');
const okRel = maxAllowedPhase({ relationship: { closeness: 0.85, trust: 0.75, tension: 0, repair_debt: 0 }, life: { energy: 0.8 }, intimacy: { sexual_openness: 0.7 } });
ok('良好关系允许 peak', okRel === 'peak');
ok('capPhase 截断', capPhase('peak', 'flirting') === 'flirting');

const invite = settleIntimacyFromTurns(
  defaultIntimacy({ sexual_openness: 0.8 }),
  [{ role: 'user', content: '我想要你，今晚做吧' }],
  { relationship: { closeness: 0.85, trust: 0.8, tension: 0, repair_debt: 0 }, life: { energy: 0.8 }, sceneType: 'intimate' }
);
ok('邀请+门控通过可进 foreplay/peak', ['foreplay', 'peak'].includes(invite.state.scene_phase));
ok('邀请后 consent.active', invite.state.consent.active === true);

const blocked = settleIntimacyFromTurns(
  defaultIntimacy({ sexual_openness: 0.8 }),
  [{ role: 'user', content: '我们做吧' }],
  { relationship: { closeness: 0.85, trust: 0.8, tension: 0.9, repair_debt: 0.7 }, life: { energy: 0.8 }, sceneType: 'intimate' }
);
ok('吵架门控下不进 peak', blocked.state.scene_phase !== 'peak');

const stop = settleIntimacyFromTurns(
  defaultIntimacy({ scene_phase: 'peak', consent: { active: true, pace: 'normal', stop_signal: false }, arousal: 0.8 }),
  [{ role: 'user', content: '停下，不要了' }],
  { relationship: { closeness: 0.9, trust: 0.8 }, life: { energy: 0.8 }, sceneType: 'intimate' }
);
ok('说停离开 peak', stop.state.scene_phase !== 'peak' && stop.state.consent.stop_signal === true);

const aftercare = settleIntimacyFromTurns(
  defaultIntimacy({ scene_phase: 'peak', consent: { active: true, pace: 'normal', stop_signal: false }, aftercare_need: 0.5 }),
  [
    { role: 'user', content: '做完了，抱抱' },
    { role: 'assistant', content: '嗯…抱着我' },
  ],
  { relationship: { closeness: 0.9, trust: 0.8 }, life: { energy: 0.7 }, sceneType: 'intimate' }
);
ok('事后进入 aftercare 或降低 aftercare_need', aftercare.state.scene_phase === 'aftercare' || aftercare.state.aftercare_need < 0.5);

const pre = prepareIntimacyForTurn(defaultIntimacy({ sexual_openness: 0.8 }), {
  userMessage: '亲我一下',
  sceneType: 'romantic',
  relationship: { closeness: 0.8, trust: 0.7, tension: 0, repair_debt: 0 },
  life: { energy: 0.8 },
});
ok('prepare 预演 flirting 级', ['flirting', 'foreplay', 'none'].includes(pre.scene_phase));

ok('低阈值不注入 prompt', toIntimacyPrompt(defaultIntimacy()) === '' || !toIntimacyPrompt(defaultIntimacy()).includes('0.'));
const highPrompt = toIntimacyPrompt(
  defaultIntimacy({ arousal: 0.8, scene_phase: 'foreplay', consent: { active: true, pace: 'slow', stop_signal: false } }),
  { relationship: { closeness: 0.9, trust: 0.8, tension: 0, repair_debt: 0 }, life: { energy: 0.8 } }
);
ok('高唤起注入表现指引', highPrompt.includes('亲密状态') && !highPrompt.includes('0.8'));
const gatePrompt = toIntimacyPrompt(defaultIntimacy({ arousal: 0.6, scene_phase: 'flirting' }), {
  relationship: { closeness: 0.9, trust: 0.8, tension: 0.9, repair_debt: 0.6 },
  life: { energy: 0.8 },
});
ok('门控失败注入拒绝指引', gatePrompt.includes('不适合') || gatePrompt.includes('拒绝'));

const peakNar = buildNarrationPrompt('intimate', null, null, 'peak');
ok('peak 旁白强制 narration', peakNar.includes('必须') || peakNar.includes('硬性'));
const afterNar = buildNarrationPrompt('intimate', null, null, 'aftercare');
ok('aftercare 旁白不写正戏续车', afterNar.includes('余韵') || afterNar.includes('事后'));

const urgMid = intimacyUrgency(defaultIntimacy({ sexual_tension: 0.7, satisfaction: 0.5 }));
ok('中等张力 urgency', urgMid.urgent && urgMid.kind === 'tension' && !urgMid.canInitiate);
const urg = intimacyUrgency(defaultIntimacy({ sexual_tension: 0.9, satisfaction: 0.5 }));
ok('高张力可主动发起', urg.urgent && urg.kind === 'tension' && urg.canInitiate === true);
ok('高张力语气允许主动亲近', urg.tone.includes('想要') || urg.tone.includes('主动') || urg.tone.includes('拽'));

const goals = buildConversationGoals({
  desires: { attention: 0, sharing: 0, comfort: 0, security: 0 },
  intimacy: defaultIntimacy({ sexual_tension: 0.9 }),
});
ok('goals 可含 intimacy 意图', goals.some((g) => g.kind === 'intimacy') || !PARAMS.intimacy?.proactive?.enabled);
ok('高张力 goals 含主动带向亲密', goals.some((g) => g.kind === 'intimacy' && /主动|亲密|拽/.test(g.text)));

const grown = evolveIntimacyOverTime(defaultIntimacy({ sexual_openness: 0.8, sexual_tension: 0, satisfaction: 0.55 }), 72);
ok('高开放度沉默后张力可累积', grown.sexual_tension > 0.15);
const sisterCfg = mergeIntimacyConfig(PARAMS.intimacy, {
  libido: 0.88,
  tensionGrowthPerHour: 0.014,
  satisfactionDecayPerHour: 0.006,
  initiateThreshold: 0.62,
});
const sisterGrown = evolveIntimacyOverTime(
  defaultIntimacy({ sexual_openness: 0.92, sexual_tension: 0, satisfaction: 0.5 }),
  48,
  sisterCfg
);
ok('高 libido 姐姐张力涨得更快', sisterGrown.sexual_tension > grown.sexual_tension);
ok('高 libido 满足感会回落', sisterGrown.satisfaction < 0.5);
const sisterUrg = intimacyUrgency(defaultIntimacy({ sexual_tension: 0.65 }), sisterCfg.proactive);
ok('高 libido 更低门槛可发起', sisterUrg.canInitiate === true);
const autoFlirt = prepareIntimacyForTurn(
  defaultIntimacy({ sexual_tension: 0.88, sexual_openness: 0.82, satisfaction: 0.3 }),
  { userMessage: '我回来了', sceneType: 'daily', relationship: { closeness: 0.9, trust: 0.8, tension: 0, repair_debt: 0 }, life: { energy: 0.8 } }
);
ok('高张力日常也自动进 flirting（她可先动）', autoFlirt.scene_phase === 'flirting');

console.log('IntimacyDimension lazy IO (mock)');
{
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const now = start + 72 * 60 * 60 * 1000;
  let row = clampIntimacy({ sexual_tension: 0.15, last_intimate_at: new Date(start).toISOString(), satisfaction: 0.35, updated_at: new Date(start).toISOString() });
  const dim = new IntimacyDimension({
    userId: 'u_int',
    now: () => now,
    read: async () => row,
    write: async (_u, _c, intimacy, writtenAt) => {
      row = { ...intimacy, updated_at: new Date(writtenAt).toISOString() };
      return row;
    },
  });
  const snap = await dim.snapshot();
  ok('snapshot 惰性抬张力', snap.sexual_tension >= 0.15);
  await dim.evolve([{ role: 'user', content: '我们做吧，我想要你' }], {
    relationship: { closeness: 0.9, trust: 0.8, tension: 0, repair_debt: 0 },
    life: { energy: 0.8 },
    sceneType: 'intimate',
  });
  ok('evolve 写回 phase', ['flirting', 'foreplay', 'peak'].includes(row.scene_phase));
  ok('evolve 更新时间锚', row.updated_at === new Date(now).toISOString());
}

console.log('delta apply');
ok('delta 受 maxStep 限制', applyIntimacyDeltas({ arousal: 0.1 }, { arousal: 1 }, 0.2).arousal <= 0.3 + 1e-9);
ok('detect stop', detectIntimacySignals([{ role: 'user', content: '停下' }]).stop === true);

console.log('姐系：懂暗示 / 主动');
{
  const subtle = detectIntimacySignals([{ role: 'user', content: '他从后面拍了拍我的屁股' }]);
  ok('拍屁股识别为 subtle', subtle.subtle === true);
  ok('subtle 视为 invite 入口', subtle.invite === true);
  const led = settleIntimacyFromTurns(
    defaultIntimacy({ sexual_openness: 0.85 }),
    [{ role: 'user', content: '我只是拍了拍你的屁股' }],
    { relationship: { closeness: 0.88, trust: 0.8, tension: 0, repair_debt: 0 }, life: { energy: 0.8 }, sceneType: 'romantic' }
  );
  ok('关系好时拍屁股可进 flirting/foreplay', ['flirting', 'foreplay', 'peak'].includes(led.state.scene_phase));
  const leadPrompt = toIntimacyPrompt(
    defaultIntimacy({ arousal: 0.5, scene_phase: 'flirting', sexual_openness: 0.8 }),
    { relationship: { closeness: 0.88, trust: 0.8, tension: 0, repair_debt: 0 }, life: { energy: 0.8 } }
  );
  ok('亲密阶段 prompt 含读空气/接住', leadPrompt.includes('读空气') || leadPrompt.includes('接住') || leadPrompt.includes('小动作'));
  ok('亲密阶段 prompt 含台词约束', leadPrompt.includes('电报') || leadPrompt.includes('台词'));
  const dailyPrompt = toIntimacyPrompt(
    defaultIntimacy({ sexual_openness: 0.8, scene_phase: 'none', arousal: 0, sexual_tension: 0 }),
    { relationship: { closeness: 0.95, trust: 0.8, tension: 0, repair_debt: 0 }, life: { energy: 0.8 } }
  );
  ok('高亲密纯日常不硬灌姐系亲密指引', dailyPrompt === '');
}

console.log(`\nIntimacy 全部 ${passed} 条断言通过`);
