const TERMINAL_PROJECTION_STATES = new Set(['applied', 'enqueued', 'dispatched', 'skipped']);

/**
 * Turn Commit 的投影执行器。
 * checkpoint 表示当前 worker 已完成同步应用或已把异步工作交给既有执行路径，
 * 不等同于跨外部系统的 exactly-once。
 */
export function createTurnProjectionRunner({
  eventStore = null,
  scope,
  priorState = {},
} = {}) {
  const state = { ...(priorState ?? {}) };

  return {
    async run(name, handler, { successStatus = 'applied', skip = false } = {}) {
      const previous = state[name];
      if (TERMINAL_PROJECTION_STATES.has(previous?.status)) {
        return { name, skipped: true, checkpoint: previous };
      }
      if (skip) {
        const checkpoint = await save(name, { status: 'skipped' });
        return { name, skipped: true, checkpoint };
      }

      try {
        const value = await handler();
        const checkpoint = await save(name, { status: successStatus });
        return { name, skipped: false, checkpoint, value };
      } catch (error) {
        await save(name, {
          status: 'failed',
          errorCode: String(error?.code ?? 'PROJECTION_FAILED'),
        }).catch(() => {});
        throw error;
      }
    },

    snapshot() {
      return { ...state };
    },
  };

  async function save(name, patch) {
    const checkpoint = {
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    state[name] = checkpoint;
    if (eventStore?.checkpoint) {
      await eventStore.checkpoint(scope, name, checkpoint);
    }
    return checkpoint;
  }
}

export function completedProjectionNames(state = {}) {
  return Object.entries(state)
    .filter(([, value]) => TERMINAL_PROJECTION_STATES.has(value?.status))
    .map(([name]) => name);
}
