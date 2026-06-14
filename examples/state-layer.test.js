// StateLayer/Life 纯逻辑测试: emotion + life 统一状态层门面。不连网。
import assert from 'node:assert';
import { StateLayer } from '../src/state/stateLayer.js';
import {
  LifeDimension,
  circadianEnergyBaseline,
  clampLife,
  decayLife,
  defaultLifeState,
  lifeSamplingHints,
  moodToLife,
  toLifePrompt,
} from '../src/state/life.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const localTime = (hour) => new Date(2026, 5, 14, hour).getTime();

console.log('defaultLifeState / clampLife / moodToLife');
{
  const d = defaultLifeState();
  ok('默认 energy=0.6', d.energy === 0.6);
  ok('默认 satiety=0.6', d.satiety === 0.6);
  ok('默认 health=1.0', d.health === 1.0);

  const c = clampLife({ energy: 2, satiety: -1, health: 3, current_activity: '吃饭' });
  ok('energy 上界裁剪到 1', c.energy === 1);
  ok('satiety 下界裁剪到 0', c.satiety === 0);
  ok('health 上界裁剪到 1', c.health === 1);
  ok('保留 current_activity', c.current_activity === '吃饭');
  ok('缺字段补 life 默认值', clampLife({}).energy === 0.6 && clampLife({}).satiety === 0.6 && clampLife({}).health === 1);

  const legacy = moodToLife({ mood: { arousal: 0.2 } });
  ok('moodToLife 兼容旧 arousal->energy', legacy.energy === 0.2);
  ok('moodToLife 会补齐 L2 三维默认值', legacy.satiety === 0.6 && legacy.health === 1);
}

console.log('circadianEnergyBaseline / decayLife');
{
  ok('深夜 energy 基线低于白天', circadianEnergyBaseline(3) < circadianEnergyBaseline(14));
  ok('早晨 energy 基线爬升', circadianEnergyBaseline(7) < circadianEnergyBaseline(10));
  ok('夜晚 energy 基线低于下午', circadianEnergyBaseline(23) < circadianEnergyBaseline(16));

  const fed = decayLife({ energy: 0.7, satiety: 0.8, health: 1 }, 1, localTime(14));
  const hungry = decayLife({ energy: 0.7, satiety: 0.8, health: 1 }, 8, localTime(14));
  ok('长时间未进食 satiety 走低', hungry.satiety < fed.satiety);
  ok('satiety 不会跌破饥饿下限', decayLife({ satiety: 0.2 }, 99, localTime(14)).satiety >= 0.08);

  const night = decayLife({ energy: 0.7, satiety: 0.8, health: 1 }, 4, localTime(3));
  const day = decayLife({ energy: 0.7, satiety: 0.8, health: 1 }, 4, localTime(14));
  ok('同起点下深夜 energy < 白天 energy', night.energy < day.energy);
  ok('低 health 会进一步压低 energy', decayLife({ energy: 0.8, health: 0.4 }, 4, localTime(14)).energy < decayLife({ energy: 0.8, health: 1 }, 4, localTime(14)).energy);
}

console.log('toLifePrompt / lifeSamplingHints');
{
  ok('空状态返回空串', toLifePrompt(null) === '');

  const low = { energy: 0.2, satiety: 0.1, health: 0.4 };
  const lowPrompt = toLifePrompt(low);
  ok('低 energy prompt 提醒有些没精神', lowPrompt.includes('有些没精神'));
  ok('低 satiety prompt 提醒有点饿了', lowPrompt.includes('有点饿了'));
  ok('低 health prompt 提醒身体不舒服', lowPrompt.includes('身体有点不舒服'));
  ok('高 satiety prompt 提醒刚吃饱', toLifePrompt({ energy: 0.6, satiety: 0.9, health: 1 }).includes('刚吃饱很满足'));

  const healthyHigh = lifeSamplingHints({ energy: 0.9, satiety: 0.6, health: 1 });
  const sickHigh = lifeSamplingHints({ energy: 0.9, satiety: 0.6, health: 0.4 });
  ok('高 energy 放宽 maxTokens', healthyHigh.maxTokens === 650);
  ok('低 health 会收紧 maxTokens', sickHigh.maxTokens < healthyHigh.maxTokens);
  ok('低 health 会降低 temperature', sickHigh.temperature < healthyHigh.temperature);
}

console.log('LifeDimension.current/evolve (注入 read/write 模拟持久化)');
{
  let row = null;
  const now = () => localTime(14);
  const read = async () => row ?? { ...defaultLifeState(), updated_at: null };
  const write = async (userId, state) => {
    row = { ...state, updated_at: new Date(now()).toISOString() };
    return row;
  };
  const life = new LifeDimension({ userId: 'u_life', read, write, now });

  ok('新用户读到默认三维', JSON.stringify(await life.current()) === JSON.stringify(clampLife(defaultLifeState())));
  await write('u_life', { energy: 0.9, satiety: 0.8, health: 1 });
  const roundTrip = await life.current();
  ok('写入后能读回三维值', roundTrip.energy === 0.9 && roundTrip.satiety === 0.8 && roundTrip.health === 1);

  row = { energy: 0.9, satiety: 0.9, health: 1, updated_at: new Date(2026, 5, 14, 8).toISOString() };
  await life.evolve([{ role: 'user', content: 'hi' }]);
  ok('evolve 写回衰减后的 life_state', row.satiety < 0.9 && row.energy < 0.9);
  ok('evolve 更新 updated_at 作为新锚点', row.updated_at === new Date(now()).toISOString());

  const anchored = await life.current();
  ok('再次 current() 以新 updated_at 为基准不继续大幅衰减', Math.abs(anchored.satiety - row.satiety) < 1e-9);
}

console.log('StateLayer snapshot/toPrompt/samplingHints/evolve');
{
  let evolved = false;
  const life = {
    async current() {
      return { energy: 0.9, satiety: 0.1, health: 0.4 };
    },
    async evolve() {
      evolved = true;
    },
  };
  const layer = new StateLayer({
    userId: 'u_state_layer',
    life,
    read: async () => ({
      mood: { valence: 0.8, arousal: 0.1 },
      relationship: { closeness: 0.5 },
      updated_at: null,
    }),
  });
  const snapshot = await layer.snapshot();
  ok('snapshot() 返回 emotion + life 两个维度', Object.keys(snapshot).sort().join(',') === 'emotion,life');
  ok('emotion 维度只有 valence/warmth', Object.keys(snapshot.emotion).sort().join(',') === 'valence,warmth');
  ok('life 维度返回 energy/satiety/health', snapshot.life.energy === 0.9 && snapshot.life.satiety === 0.1 && snapshot.life.health === 0.4);

  const prompt = layer.toPrompt(snapshot);
  ok('toPrompt() 拼接 emotion 指引', prompt.includes('心情不错'));
  ok('toPrompt() 拼接 life 饥饿/健康指引', prompt.includes('有点饿了') && prompt.includes('身体有点不舒服'));
  ok('samplingHints() 使用 life 维度并受 health 收紧', layer.samplingHints(snapshot).maxTokens === 260);

  await layer.evolve([{ role: 'user', content: '你好' }]);
  ok('StateLayer.evolve 调用 life.evolve', evolved);
}

console.log(`\nStateLayer 全部 ${passed} 条断言通过`);
