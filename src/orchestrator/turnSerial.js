/**
 * 单个 Orchestrator 实例内的 turn 串行器。
 * 普通 Promise 在完成后释放；AsyncIterable 必须消费/关闭后才释放，避免流式回复
 * 尚未 Commit 时下一轮已经读取并覆盖共享 session/history/state。
 */
export function createTurnSerialExecutor() {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    run(task) {
      pending += 1;
      const predecessor = tail.catch(() => {});
      let release;
      const completed = new Promise((resolve) => {
        release = resolve;
      });
      tail = predecessor.then(() => completed);

      return predecessor.then(async () => {
        try {
          const result = await task();
          if (isAsyncIterable(result)) {
            return releaseAfterIteration(result, release, () => {
              pending -= 1;
            });
          }
          pending -= 1;
          release();
          return result;
        } catch (error) {
          pending -= 1;
          release();
          throw error;
        }
      });
    },

    pendingCount() {
      return pending;
    },
  };
}

function isAsyncIterable(value) {
  return Boolean(value && typeof value[Symbol.asyncIterator] === 'function');
}

function releaseAfterIteration(iterable, release, onRelease) {
  const iterator = iterable[Symbol.asyncIterator]();
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    onRelease();
    release();
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(...args) {
      try {
        const result = await iterator.next(...args);
        if (result.done) finish();
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    },
    async return(value) {
      try {
        return typeof iterator.return === 'function'
          ? await iterator.return(value)
          : { done: true, value };
      } finally {
        finish();
      }
    },
    async throw(error) {
      try {
        if (typeof iterator.throw === 'function') return await iterator.throw(error);
        throw error;
      } finally {
        finish();
      }
    },
  };
}
