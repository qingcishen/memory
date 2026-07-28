import { describe, expect, it } from 'vitest';
import { createTurnSerialExecutor } from '../src/orchestrator/turnSerial.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('turn serial executor', () => {
  it('runs ordinary turns in arrival order even when the first is slow', async () => {
    const serial = createTurnSerialExecutor();
    const gate = deferred();
    const started = deferred();
    const events = [];
    const first = serial.run(async () => {
      events.push('first:start');
      started.resolve();
      await gate.promise;
      events.push('first:end');
      return 'first';
    });
    const second = serial.run(async () => {
      events.push('second:start');
      return 'second';
    });

    await started.promise;
    expect(events).toEqual(['first:start']);
    expect(serial.pendingCount()).toBe(2);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(serial.pendingCount()).toBe(0);
  });

  it('holds the queue until a streaming turn is fully consumed', async () => {
    const serial = createTurnSerialExecutor();
    const gate = deferred();
    const events = [];
    const first = await serial.run(async () => (async function* stream() {
      events.push('stream:start');
      yield 'chunk';
      await gate.promise;
      events.push('stream:end');
    })());
    const second = serial.run(async () => {
      events.push('second:start');
      return 'second';
    });

    const consume = (async () => {
      const values = [];
      for await (const value of first) values.push(value);
      return values;
    })();
    await Promise.resolve();
    expect(events).toEqual(['stream:start']);
    gate.resolve();
    await expect(consume).resolves.toEqual(['chunk']);
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['stream:start', 'stream:end', 'second:start']);
  });

  it('releases the queue when a stream consumer stops early', async () => {
    const serial = createTurnSerialExecutor();
    const first = await serial.run(async () => (async function* stream() {
      yield 'first';
      yield 'unused';
    })());
    const second = serial.run(async () => 'second');

    for await (const value of first) {
      expect(value).toBe('first');
      break;
    }
    await expect(second).resolves.toBe('second');
    expect(serial.pendingCount()).toBe(0);
  });

  it('releases an unstarted stream when the caller closes it', async () => {
    const serial = createTurnSerialExecutor();
    const first = await serial.run(async () => (async function* stream() {
      yield 'unused';
    })());
    const second = serial.run(async () => 'second');

    await first.return();

    await expect(second).resolves.toBe('second');
    expect(serial.pendingCount()).toBe(0);
  });
});
