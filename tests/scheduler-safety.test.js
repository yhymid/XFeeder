"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { startChannelQueue } = require('../src/app/runtime');

async function clockQueue(t, channels, run) {
  let now = 1000000;
  const pending = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay }; pending.push(timer); return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => {
    const index = pending.indexOf(timer); if (index >= 0) pending.splice(index, 1);
  });
  const queue = startChannelQueue({ getChannels: () => channels, delayBetweenChannels: 10000, checkFeedsForChannel: run });
  t.after(() => queue.stop());
  await new Promise(setImmediate);
  return { queue, now: () => now, async step(ms = 10000) {
    assert.equal(pending.length, 1, 'one bounded queue timer, never a busy loop');
    const timer = pending.shift();
    assert.equal(timer.delay, 10000);
    now += ms;
    await timer.callback();
  } };
}

test('C3-04: failing channel cannot retry each rotation or amplify traffic over healthy channels', async t => {
  const calls = { failed: 0, healthy: 0, other: 0 };
  const channels = Object.keys(calls).map(cacheKey => ({ cacheKey, TimeChecker: 2 }));
  const clock = await clockQueue(t, channels, async (_index, channel) => {
    calls[channel.cacheKey]++;
    if (channel.cacheKey === 'failed') throw Error('transient fixture');
  });
  for (let index = 0; index < 12; index++) await clock.step();
  assert.deepEqual(calls, { failed: 2, healthy: 1, other: 1 });
});

test('C3-04: attempt, success and next run are distinct; exponential backoff is bounded and success resets it', async t => {
  let succeeds = false, calls = 0;
  const clock = await clockQueue(t, [{ cacheKey: 'one', TimeChecker: 1 }], async () => {
    calls++; if (!succeeds) throw Error('temporary');
  });
  let state = clock.queue.getState().scheduleByCacheKey.one;
  assert.equal(state.lastAttemptAt, 1000000);
  assert.equal(state.lastSuccessAt, null);
  assert.equal(state.nextRunAt, 1060000);
  for (const expectedDelay of [120000, 240000, 480000, 480000]) {
    await clock.step(state.nextRunAt - clock.now());
    state = clock.queue.getState().scheduleByCacheKey.one;
    assert.equal(state.nextRunAt - clock.now(), expectedDelay);
    assert.equal(state.lastAttemptAt, clock.now());
    assert.equal(state.lastSuccessAt, null);
  }
  succeeds = true;
  await clock.step(state.nextRunAt - clock.now());
  state = clock.queue.getState().scheduleByCacheKey.one;
  assert.equal(state.failures, 0);
  assert.equal(state.lastSuccessAt, clock.now());
  assert.equal(state.nextRunAt - clock.now(), 60000);
  assert.equal(calls, 6);
  // A caller cannot mutate the scheduler by editing its snapshot.
  state.nextRunAt = 0;
  await clock.step(10000);
  assert.equal(calls, 6);
});

for (const format of ['seconds', 'date']) {
  test(`C3-04: Retry-After ${format} is a minimum deadline without delaying healthy channels`, async t => {
    const calls = { blocked: 0, healthy: 0 };
    const clock = await clockQueue(t, Object.keys(calls).map(cacheKey => ({ cacheKey, TimeChecker: 1 })), async (_index, channel) => {
      calls[channel.cacheKey]++;
      if (channel.cacheKey === 'blocked') throw Object.assign(Error('429 fixture'), {
        response: { status: 429, headers: { 'Retry-After': format === 'seconds' ? '600' : new Date(Date.now() + 600000).toUTCString() } },
      });
    });
    assert.equal(clock.queue.getState().scheduleByCacheKey.blocked.nextRunAt, 1600000);
    for (let i = 0; i < 59; i++) await clock.step();
    assert.equal(calls.blocked, 1);
    assert.equal(calls.healthy, 10);
    await clock.step();
    assert.equal(calls.blocked, 2);
  });
}


test('X3-20: hot-reloaded channel reorder preserves the intended next channel', async t => {
  const channels = ['alpha', 'bravo', 'charlie'].map(cacheKey => ({ cacheKey, TimeChecker: 1 }));
  const visits = [];
  const clock = await clockQueue(t, channels, async (_index, channel) => {
    visits.push(channel.cacheKey);
  });
  assert.deepEqual(visits, ['alpha']);
  // After alpha, the queued next identity is bravo (index 1).
  // Move bravo to index 2 before the next tick: index-only cursors
  // accidentally revisit alpha and delay bravo.
  channels.splice(0, channels.length, channels[2], channels[0], channels[1]);
  assert.equal(clock.queue.getState().nextChannelKey, 'bravo');
  await clock.step();
  assert.deepEqual(visits, ['alpha', 'bravo']);
  assert.equal(clock.queue.getState().nextChannelKey, 'charlie');
  await clock.step();
  assert.deepEqual(visits, ['alpha', 'bravo', 'charlie']);
  // Existing per-key TimeChecker must not be reset by reordering.
  assert.equal(clock.queue.getState().scheduleByCacheKey.alpha.nextRunAt, 1060000);
});

test('X3-20: removed next channel falls back to the next positional channel', async t => {
  const channels = ['alpha', 'bravo', 'charlie'].map(cacheKey => ({ cacheKey, TimeChecker: 1 }));
  const visits = [];
  const clock = await clockQueue(t, channels, async (_index, channel) => visits.push(channel.cacheKey));
  assert.deepEqual(visits, ['alpha']);
  channels.splice(1, 1); // Delete scheduled bravo while retaining charlie.
  await clock.step();
  assert.deepEqual(visits, ['alpha', 'charlie']);
  assert.equal(clock.queue.getState().nextChannelKey, 'alpha');
});

test('X3-20: queue polling cannot be configured as an accidental hot timer', () => {
  for (const delayBetweenChannels of [0, -1, NaN, Infinity, 1, 99, 1.5, '100', null]) {
    assert.throws(() => startChannelQueue({
      getChannels: () => [{ cacheKey: 'fixture', TimeChecker: 1 }],
      checkFeedsForChannel: async () => {},
      delayBetweenChannels,
    }), /delayBetweenChannels must be an integer/);
  }
});
