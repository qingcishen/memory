import assert from 'node:assert';
import { EMOTION_LABELS, inferEmotionLabel } from '../src/state/emotionLabel.js';
let passed = 0;
function ok(name, condition) { assert.ok(condition, name); console.log('  ✓', name); passed++; }
const state = (o = {}) => ({ emotion: { valence: 0, warmth: 0.7, ...(o.emotion ?? {}) }, relationship: { closeness: 0.75, tension: 0, repair_debt: 0, ...(o.relationship ?? {}) } });
const user = (content) => [{ role: 'user', content }];

console.log('inferEmotionLabel B1 场景表');
ok('标签集合冻结为八种', EMOTION_LABELS.join(',') === '平静,开心,委屈,吃醋,生气,失落,撒娇,心疼');
ok('被冷落三天后对方出现 → 委屈而非生气', inferEmotionLabel(state(), { attention: 0.9 }, user('我回来啦，最近太忙了')) === '委屈');
ok('质问不回/把我忘了 → 委屈（不依赖 desire）', inferEmotionLabel(state(), {}, user('这几天都不回我，你是不是把我忘了？')) === '委屈');
ok('高亲密时提到别的女生 → 吃醋', inferEmotionLabel(state(), {}, user('今天认识了一个很漂亮的女生')) === '吃醋');
ok('低亲密时提到女生不越界吃醋', inferEmotionLabel(state({ relationship: { closeness: 0.3 } }), {}, user('今天认识了一个女生')) !== '吃醋');
ok('称她是女朋友不会误判成吃醋', inferEmotionLabel(state(), {}, user('你就是我最喜欢的女朋友')) !== '吃醋');
ok('明确冲突且高 tension → 生气', inferEmotionLabel(state({ relationship: { tension: 0.8, repair_debt: 0.7 } }), {}, user('我们刚才吵架了，我还是很烦')) === '生气');
ok('高关系债时对方道歉 → 不继续判生气', inferEmotionLabel(state({ relationship: { tension: 0.8, repair_debt: 0.7 } }), {}, user('对不起，我错了，别生气了')) !== '生气');
ok('对方受伤且关系亲近 → 心疼', inferEmotionLabel(state(), {}, user('我今天被老板骂了，真的很难过')) === '心疼');
ok('低落但无冲突 → 失落', inferEmotionLabel(state({ emotion: { valence: -0.7 } }), {}, user('今天就普通聊聊')) === '失落');
ok('想被安慰且亲近 → 撒娇', inferEmotionLabel(state(), { comfort: 0.8 }, user('在吗')) === '撒娇');
ok('正向心情 → 开心', inferEmotionLabel(state({ emotion: { valence: 0.7, warmth: 0.5 }, relationship: { closeness: 0.5 } }), {}, user('好呀')) === '开心');
ok('没有明显信号 → 平静', inferEmotionLabel(state(), {}, user('今天星期几')) === '平静');
console.log(`\nEmotionLabel 全部 ${passed} 条断言通过`);
