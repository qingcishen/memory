import { supabase } from '../config.js';
import { BeliefEngine, BeliefRepository } from '../belief/index.js';
import { InMemoryTurnEventStore, SupabaseTurnEventStore } from './turnEventStore.js';

const reportedFallbacks = new Set();

/**
 * 生产认知核心：时态信念投影 + 跨进程 turn 提交账本。
 *
 * 两项能力都依赖较新的数据库 schema。为了让尚未执行迁移的部署仍能对话，
 * 这里只对“缺表/缺函数/旧列”做确定性降级；认证、网络和数据错误继续抛出，
 * 避免把真实故障长期伪装成正常状态。
 */
export function createPersistentCognitiveCore({
  userId,
  companionId = 'default',
  client = supabase,
  onFallback = null,
} = {}) {
  if (!String(userId ?? '').trim()) {
    throw new Error('Persistent cognitive core requires userId');
  }
  const beliefEngine = new ResilientBeliefEngine({
    primary: new BeliefEngine({
      userId,
      companionId,
      repository: new BeliefRepository({ client }),
    }),
    onFallback,
  });
  const turnEventStore = new ResilientTurnEventStore({
    primary: new SupabaseTurnEventStore({ client }),
    fallback: new InMemoryTurnEventStore(),
    onFallback,
  });
  return { beliefEngine, turnEventStore };
}

/** Belief 是派生视图；schema 未迁移时返回与“暂无信念”一致的安全结果。 */
export class ResilientBeliefEngine {
  constructor({ primary, onFallback = null } = {}) {
    if (!primary) throw new Error('ResilientBeliefEngine requires primary');
    this.primary = primary;
    this.userId = primary.userId;
    this.companionId = primary.companionId;
    this.onFallback = onFallback;
    this.schemaAvailable = true;
  }

  project(belief, evidence, opts) {
    return this.run('project', [belief, evidence, opts], () => ({
      skipped: true,
      reason: 'belief_schema_unavailable',
    }));
  }

  projectMemory(memory, opts) {
    return this.run('projectMemory', [memory, opts], () => []);
  }

  projectEvent(event, opts) {
    return this.run('projectEvent', [event, opts], () => []);
  }

  current(query = {}) {
    return this.run('current', [query], () => []);
  }

  history(query = {}) {
    return this.run('history', [query], () => []);
  }

  resolve(query = {}) {
    return this.run('resolve', [query], unknownBeliefResolution);
  }

  forgetMemoryIds(memoryIds = []) {
    return this.run('forgetMemoryIds', [memoryIds], () => ({
      evidenceDeleted: 0,
      beliefsDeleted: [],
    }));
  }

  async run(method, args, fallback) {
    if (!this.schemaAvailable) return fallback();
    try {
      return await this.primary[method](...args);
    } catch (error) {
      if (!isMissingCognitiveSchemaError(error)) throw error;
      this.schemaAvailable = false;
      reportFallback(this.onFallback, 'belief_engine', error);
      return fallback();
    }
  }
}

/**
 * 提交账本只能在主后端成功响应前选择后端：一旦看见 Supabase 中的事件或取得 lease，
 * 后续绝不能半途换成本地账本，否则会破坏幂等与 fencing。旧 schema 会在首次
 * claim/get 时切换。
 */
export class ResilientTurnEventStore {
  constructor({ primary, fallback = new InMemoryTurnEventStore(), onFallback = null } = {}) {
    if (!primary) throw new Error('ResilientTurnEventStore requires primary');
    this.primary = primary;
    this.fallback = fallback;
    this.onFallback = onFallback;
    this.backend = 'primary';
    this.primaryBackendConfirmed = false;
  }

  async claim(scope = {}) {
    if (this.backend === 'fallback') return this.fallback.claim(scope);
    try {
      const result = await this.primary.claim(scope);
      this.primaryBackendConfirmed = true;
      return result;
    } catch (error) {
      if (this.primaryBackendConfirmed || !isMissingCognitiveSchemaError(error)) throw error;
      this.activateFallback(error);
      return this.fallback.claim(scope);
    }
  }

  async get(scope = {}) {
    if (this.backend === 'fallback') return this.fallback.get(scope);
    try {
      const result = await this.primary.get(scope);
      this.primaryBackendConfirmed = true;
      return result;
    } catch (error) {
      if (this.primaryBackendConfirmed || !isMissingCognitiveSchemaError(error)) throw error;
      this.activateFallback(error);
      return this.fallback.get(scope);
    }
  }

  renew(scope = {}) {
    return this.activeStore().renew(scope);
  }

  complete(scope = {}, result = {}) {
    return this.activeStore().complete(scope, result);
  }

  fail(scope = {}, error) {
    return this.activeStore().fail(scope, error);
  }

  checkpoint(scope = {}, projection, checkpoint = {}) {
    return this.activeStore().checkpoint(scope, projection, checkpoint);
  }

  activeStore() {
    return this.backend === 'fallback' ? this.fallback : this.primary;
  }

  activateFallback(error) {
    this.backend = 'fallback';
    reportFallback(this.onFallback, 'turn_event_store', error);
  }
}

export function isMissingCognitiveSchemaError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  if (['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(code)) {
    return true;
  }
  const message = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return (
    /relation .+ does not exist/.test(message) ||
    /function .+ does not exist/.test(message) ||
    /could not find (the )?(table|function|column)/.test(message) ||
    /schema cache/.test(message) ||
    /column .+ does not exist/.test(message)
  );
}

function unknownBeliefResolution() {
  return { status: 'unknown', beliefs: [], confidence: 0, provenance: [] };
}

function reportFallback(onFallback, capability, error) {
  if (typeof onFallback === 'function') {
    try {
      onFallback({ capability, error });
    } catch {
      // 可观测性回调不能反过来破坏主链降级。
    }
    return;
  }
  if (reportedFallbacks.has(capability)) return;
  reportedFallbacks.add(capability);
  console.warn(
    `[cognitive-core] ${capability} schema unavailable; using safe fallback: ${String(error?.message ?? error)}`,
  );
}
