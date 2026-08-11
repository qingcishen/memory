/**
 * CEE 生产验收测试套件
 *
 * 覆盖 2026-07-29 生产修复 sprint 中验收的 4 条核心场景：
 *   1. 4h 沉默自然触达：longing + memory_surfaced 累积超过 0.40 阈值，heartbeat 返回 contact=true
 *   2. 情绪注入有效：contextForTurn 的 emotion 参数在 state 情绪为 neutral 时正确传入人格编译
 *   3. applyDrift 存储人格对象而非 userId 字符串（修复前的数据损坏 bug 验证）
 *   4. 并发心跳不产生重复投递：withStateLock 保证写操作串行化
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createExistenceEngine,
  createMemoryContinuousStateStore,
  createMemoryPersonalityStore,
  createMemoryPrivateMemoryStore,
  defaultContinuousState,
} from '../src/existence/index.js';

// NOW = 2026-07-29T20:00:00 Beijing (12:00 UTC) — user historically active at this hour
const NOW = Date.parse('2026-07-29T12:00:00.000Z');

// Recent messages in the same hour window → receptivity high at 20h Beijing
const RECENT_MESSAGES_AT_NOW = [
  { role: 'user', created_at: '2026-07-26T11:50:00Z', content: 'a' },
  { role: 'user', created_at: '2026-07-27T12:05:00Z', content: 'b' },
  { role: 'user', created_at: '2026-07-28T11:55:00Z', content: 'c' },
  { role: 'user', created_at: '2026-07-29T11:48:00Z', content: 'd' },
];

function stateAt(lastInteraction = NOW) {
  const state = defaultContinuousState(lastInteraction);
  state.temporal.last_interaction = new Date(lastInteraction).toISOString();
  state.updated_at = new Date(lastInteraction).toISOString();
  return state;
}

function makeEngine(state, extraOpts = {}) {
  const stateStore = createMemoryContinuousStateStore({
    initial: [{ userId: 'u1', companionId: 'c1', state }],
    clock: () => NOW,
  });
  const personalityStore = createMemoryPersonalityStore();
  const engine = createExistenceEngine({
    userId: 'u1',
    companionId: 'c1',
    stateStore,
    privateMemoryStore: createMemoryPrivateMemoryStore(),
    personalityStore,
    clock: () => NOW,
    ...extraOpts,
  });
  return { engine, stateStore, personalityStore };
}

describe('CEE 生产验收', () => {
  /**
   * T1: 4h 沉默 + memory_surfaced (consolidation 已于 2h 时触发) → desire ≈ 0.405 → contact = true
   *
   * 验收标准：
   *   - result.contactDecision.contact === true
   *   - desire ≥ 0.40 (longing 0.3 + memorySignal 0.105)
   *   - reason.type === 'memory_surfaced'
   */
  it('4h 沉默后 heartbeat 自然触达：longing+memory_surfaced 超过 0.40 阈值', async () => {
    const state = stateAt(NOW - 4 * 60 * 60_000);
    // 模拟 2h consolidation 已触发，浮现出一条记忆
    state.cognitive.memory_surfaced = {
      id: 'mem-001',
      summary: '你上次说要去面试，不知道结果怎么样了',
      emotional_weight: 0.65,
      source: 'silence_consolidation',
    };

    const historyStore = {
      recentMessages: vi.fn(async () => RECENT_MESSAGES_AT_NOW),
      countMessagesSince: vi.fn(async () => 0),
    };
    const { engine } = makeEngine(state, { historyStore });

    const result = await engine.heartbeat({ now: NOW });

    // 主路径：必须决定联系
    expect(result.contactDecision, '4h 沉默后应有联系决策').not.toBeNull();
    expect(result.contactDecision.contact).toBe(true);

    // desire 应 ≥ 0.40 (longing ≈ 1.0 × 0.3 + memorySignal 0.7 × 0.15 = 0.405)
    expect(result.contactDecision.desire).toBeGreaterThanOrEqual(0.40);

    // 理由应来自 memory_surfaced（质量 0.62 ≥ reasonQuality 阈值 0.50）
    expect(result.contactDecision.reason?.type).toBe('memory_surfaced');

    // 状态应已保存，longing 接近饱和
    expect(result.state.temporal.longing).toBeGreaterThan(0.95);
  });

  /**
   * T2: emotion 参数有效注入
   *
   * 修复前：contextForTurn 里 `state.emotional ?? emotion` 永远走 state.emotional（对象总为 truthy）。
   * 修复后：仅当 state.emotional 有实质情绪时才优先，否则使用 emotion 参数。
   *
   * 验收标准：
   *   - state 情绪为 neutral / intensity=0 时，英文旧 API 会映射到 CEE 的
   *     16 类中文权威标签
   *   - state 已有显著情绪时，emotion 参数不覆盖它（反面验证）
   */
  it('emotion 参数在 state 情绪为 neutral 时正确注入 activePersonality', async () => {
    // 初始 state 情绪为 neutral（默认状态）
    const { engine } = makeEngine(stateAt(NOW - 5 * 60_000));

    const sadEmotion = { current_emotion: 'sad', emotion_intensity: 0.7, valence: -0.5, persistence: 0 };

    const turn = await engine.contextForTurn({
      now: NOW,
      emotion: sadEmotion,
      relationship: { closeness: 0.5, trust: 0.6 },
      situation: 'default',
    });

    // 情绪参数应被采用，并映射为 CEE 权威标签；数值底座保持 M1 原值。
    expect(turn.activePersonality.runtime_state.current_emotion).toBe('失落');
    expect(turn.state.emotional.label).toBe('失落');
    expect(turn.state.emotional.valence).toBe(-0.5);

    // 反面：若 state 已有显著情绪（intensity > 0），emotion 参数不应覆盖
    const existingState = stateAt(NOW - 5 * 60_000);
    existingState.emotional.current_emotion = 'excited';
    existingState.emotional.emotion_intensity = 0.8;
    existingState.emotional.valence = 0.7;
    const { engine: engine2 } = makeEngine(existingState);

    const turn2 = await engine2.contextForTurn({
      now: NOW,
      emotion: sadEmotion,  // 传入 sad，但 state 已有 excited
      situation: 'default',
    });
    // state 里的 excited 应优先，并映射为统一标签。
    expect(turn2.activePersonality.runtime_state.current_emotion).toBe('期待');
  });

  /**
   * T3: applyDrift 存储人格对象而非 userId 字符串
   *
   * 修复前：savePersonality 回调为 (personality) => ... 但 personalityDrift.js 调用
   *   savePersonality(userId, scheduledPersonality, meta) ——
   *   导致 personality 参数捕获了 userId 字符串，人格被覆盖为字符串。
   * 修复后：回调签名改为 (_userId, personality) => ...
   *
   * 验收标准：
   *   - applyDrift 完成后，personalityStore.load() 返回含 core_values 的对象
   *   - 存储的不是字符串、不包含 userId 格式
   */
  it('applyDrift 存储人格对象而非 userId 字符串', async () => {
    const { engine, personalityStore } = makeEngine(stateAt(NOW));

    await engine.applyDrift({ type: 'emotional_support_given', intensity: 0.6 }, { now: NOW });

    const saved = await personalityStore.load({ userId: 'u1', companionId: 'c1' });

    // 必须是对象，不能是字符串
    expect(typeof saved, '人格应为对象，不是字符串').toBe('object');
    expect(saved).not.toBeNull();

    // 必须有人格字段，不能是被 userId 覆盖的字符串
    expect(saved).toHaveProperty('core_values');
    expect(Array.isArray(saved.core_values) || typeof saved.core_values === 'object').toBe(true);

    // drift_history 应记录本次漂移事件
    expect(Array.isArray(saved.drift_history)).toBe(true);
    expect(saved.drift_history.length).toBeGreaterThan(0);
    expect(saved.drift_history[0].event_type).toBe('emotional_support_given');
  });

  /**
   * T4: 并发心跳通过 withStateLock 串行化，不产生重复投递
   *
   * 验证：同时发起 N 次 heartbeat()，状态写操作不会交叉进行。
   * 使用计数器检测同一时刻并发写入数；最大并发写入数必须为 1。
   */
  it('并发心跳被 withStateLock 串行化，最大写并发数为 1', async () => {
    const state = stateAt(NOW - 60 * 60_000);
    let concurrentWrites = 0;
    let maxConcurrentWrites = 0;

    // 拦截 stateStore.save 以检测并发
    const baseStore = createMemoryContinuousStateStore({
      initial: [{ userId: 'u1', companionId: 'c1', state }],
      clock: () => NOW,
    });
    const spyStore = {
      load: (...args) => baseStore.load(...args),
      save: async (...args) => {
        concurrentWrites++;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, concurrentWrites);
        // 模拟异步写入延迟以放大并发窗口
        await new Promise((r) => setTimeout(r, 5));
        const result = await baseStore.save(...args);
        concurrentWrites--;
        return result;
      },
    };

    const { engine } = makeEngine(state, { stateStore: spyStore });

    // 同时发起 3 次心跳
    const results = await Promise.all([
      engine.heartbeat({ now: NOW }),
      engine.heartbeat({ now: NOW }),
      engine.heartbeat({ now: NOW }),
    ]);

    // 全部完成，无抛错
    expect(results).toHaveLength(3);
    for (const r of results) expect(r).toHaveProperty('state');

    // 关键断言：写操作从未并发执行
    expect(maxConcurrentWrites).toBe(1);
  });
});
