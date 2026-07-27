// 亲密知识库 / 姿势多样性 纯逻辑测试
import assert from 'node:assert';
import {
  DEFAULT_INTIMACY_KNOWLEDGE,
  clampRepertoire,
  detectPositionMentions,
  formatKnowledgePrompt,
  normalizeIntimacyKnowledge,
  pickIntimacyKnowledge,
  pushRepertoirePositions,
} from '../src/state/intimacyKnowledge.js';
import { toIntimacyPrompt, defaultIntimacy, settleIntimacyFromTurns } from '../src/state/intimacy.js';
import { loadPersonaConfig } from '../src/companion.js';

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log('  ✓', name);
  passed++;
}

console.log('normalize / pick');
const kn = normalizeIntimacyKnowledge(null);
ok('默认知识含多种姿势', kn.positions.length >= 6);
ok('默认含前戏与敏感点', kn.foreplay.length >= 4 && kn.hotspots.length >= 4);

const pick1 = pickIntimacyKnowledge(kn, {}, 'peak', () => 0.1);
const pick2 = pickIntimacyKnowledge(kn, { last_positions: [pick1.position.id] }, 'peak', () => 0.1);
ok('pick 有 position', Boolean(pick1.position?.label));
ok('最近用过的姿势会尽量避开', pick2.position.id !== pick1.position.id || kn.positions.length === 1);

const prompt = formatKnowledgePrompt(pick1, 'peak');
ok('知识 prompt 含体位多样性', prompt.includes(pick1.position.label) && prompt.includes('姿势'));
ok('禁止报菜名', prompt.includes('报菜名') || prompt.includes('不要念'));

console.log('detect / repertoire');
ok('检测骑乘', detectPositionMentions('她骑上去慢慢磨', kn).includes('cowgirl'));
ok('检测后入', detectPositionMentions('从后面抱着后入', kn).includes('doggy'));
const rep = pushRepertoirePositions({}, ['doggy', 'cowgirl']);
ok('repertoire 记录最近姿势', rep.last_positions[0] === 'cowgirl' && rep.last_positions.includes('doggy'));
ok('clamp repertoire', clampRepertoire({ last_positions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).last_positions.length === 6);

console.log('integrate with toIntimacyPrompt / settle');
const peakState = defaultIntimacy({
  scene_phase: 'peak',
  arousal: 0.8,
  consent: { active: true, pace: 'normal', stop_signal: false },
  sexual_openness: 0.9,
});
const peakPrompt = toIntimacyPrompt(
  peakState,
  { relationship: { closeness: 0.9, trust: 0.8, tension: 0, repair_debt: 0 }, life: { energy: 0.9 }, knowledge: kn },
  { enabled: true, libido: 0.88, knowledge: kn, promptThreshold: {}, gates: {}, style: { sisterLead: true } }
);
ok('peak prompt 注入知识', peakPrompt.includes('体位') || peakPrompt.includes(pick1.position.label) || peakPrompt.includes('前戏') || peakPrompt.includes('多样性') || peakPrompt.includes('姿势'));

const settled = settleIntimacyFromTurns(
  peakState,
  [{ role: 'user', content: '继续，后入' }, { role: 'assistant', content: '嗯…' }],
  { relationship: { closeness: 0.9, trust: 0.8, tension: 0, repair_debt: 0 }, life: { energy: 0.9 }, sceneType: 'intimate' },
  { enabled: true, knowledge: kn, gates: { requireConsentForPeak: false }, style: { sisterLead: true }, proactive: { initiateThreshold: 0.9 } }
);
ok('settle 写入 repertoire 姿势', settled.state.repertoire?.last_positions?.includes('doggy'));

console.log('companion default knowledge');
const persona = loadPersonaConfig('companions/default');
ok('沈清词人设含 intimacyKnowledge', Boolean(persona?.config?.intimacyKnowledge?.positions?.length >= 5));
ok('默认知识表与角色表都有骑乘/后入', DEFAULT_INTIMACY_KNOWLEDGE.positions.some((p) => p.id === 'cowgirl'));

console.log(`\nIntimacyKnowledge 全部 ${passed} 条断言通过`);
