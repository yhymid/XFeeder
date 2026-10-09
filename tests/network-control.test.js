"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeNetworkConfig,
  requireNetworkConfig,
  resolveNetworkPolicy,
} = require("../src/network/config");
const { BandwidthController } = require("../src/network/bandwidth-controller");
const { ConcurrencyGate } = require("../src/network/concurrency");
const { NetworkService } = require("../src/network/service");
const { ChannelTasks } = require("../src/app/channel-tasks");
const { context, waiting, runContext } = require("../src/network/context");
const { cancelled } = require("../src/network/abort");
const { deferred } = require("./fixtures/network.cjs");

function fakeClock() {
  let now = 0,
    nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
    get pending() {
      return timers.size;
    },
  };
}

test("TASK 02: exact presets and legacy Unlimited without mutating input", () => {
  const legacy = requireNetworkConfig();
  assert.equal(legacy.downloadBytesPerSecond, null);
  assert.equal(legacy.networkFriendlyMode, false);
  assert.equal(legacy.maxConcurrentRequests, null);
  assert.equal(legacy.scraplingResourceSaving, true);
  for (const [profile, bytes] of Object.entries({
    potato: 1250,
    low: 250000,
    medium: 1250000,
    high: 6250000,
    "very-high": 12500000,
    unlimited: null,
  })) {
    const input = Object.freeze({ bandwidthProfile: profile });
    assert.equal(requireNetworkConfig(input).downloadBytesPerSecond, bytes);
    assert.deepEqual(input, { bandwidthProfile: profile });
  }
});

test("TASK 02: Custom supports independent directions and integer canonical units", () => {
  const config = requireNetworkConfig({
    bandwidthProfile: "custom",
    downloadLimitMbps: 2,
    uploadLimitMbps: 0.25,
  });
  assert.equal(config.downloadBytesPerSecond, 250000);
  assert.equal(config.uploadBytesPerSecond, 31250);
  assert.equal(
    requireNetworkConfig({ bandwidthProfile: "custom", uploadLimitMbps: 1 })
      .downloadBytesPerSecond,
    null,
  );
  assert.equal(
    requireNetworkConfig({
      bandwidthProfile: "custom",
      downloadLimitMbps: 0.000008,
    }).downloadBytesPerSecond,
    1,
  );
});

test("TASK 02: invalid limits, units and types return structured errors", () => {
  for (const value of [
    -1,
    0,
    NaN,
    Infinity,
    -Infinity,
    "10 Mbps",
    "10",
    {},
    1e20,
    0.00000001,
  ]) {
    const result = normalizeNetworkConfig({
      bandwidthProfile: "custom",
      downloadLimitMbps: value,
    });
    assert.equal(result.ok, false, String(value));
    assert.ok(
      result.errors.every(
        (e) => e.path.startsWith("network.") && e.code && e.message,
      ),
    );
  }
  for (const input of [
    null,
    [],
    { bandwidthProfile: "unknown" },
    { bandwidthProfile: "custom" },
    { downloadUnit: "MBps" },
    { maxConcurrentRequests: 0 },
    { networkFriendlyMode: "true" },
    { scraplingResourceSaving: null },
  ]) {
    assert.equal(
      normalizeNetworkConfig(input).ok,
      false,
      JSON.stringify(input),
    );
  }
  assert.throws(() => requireNetworkConfig({ uploadLimitMbps: -1 }), {
    code: "INVALID_NETWORK_CONFIG",
  });
});

test("TASK 03: Unlimited needs no timer or queue", async () => {
  const clock = fakeClock(),
    controller = new BandwidthController(null, clock);
  await controller.consume(1e9);
  assert.equal(clock.pending, 0);
  assert.equal(controller.snapshot().grantedBytes, 1e9);
  assert.equal(controller.snapshot().pending, 0);
});

for (const rate of [1250, 1250000]) {
  test(`TASK 03: ${rate} bytes/s obeys shared budget and bounded initial burst`, async () => {
    const clock = fakeClock(),
      controller = new BandwidthController(rate, clock);
    const burst = controller.capacity;
    await controller.consume(burst);
    let done = false;
    const next = controller.consume(rate).then(() => {
      done = true;
    });
    clock.tick(900);
    await Promise.resolve();
    assert.equal(done, false);
    clock.tick(110);
    await next;
    assert.equal(controller.snapshot().grantedBytes, rate + burst);
    clock.tick(100000);
    assert.ok(
      controller.tokens <= burst,
      "Idle periods must not build an unlimited burst",
    );
    controller.close();
    assert.equal(clock.pending, 0);
  });
}

test("TASK 03: a small consumer is not starved by a large one", async () => {
  const clock = fakeClock(),
    controller = new BandwidthController(1000, clock);
  const completed = [];
  const large = controller.consume(2000).then(() => completed.push("large"));
  const small = controller.consume(100).then(() => completed.push("small"));
  clock.tick(200);
  await small;
  assert.deepEqual(completed, ["small"]);
  clock.tick(2200);
  await large;
  assert.equal(clock.pending, 0);
});

test("TASK 03: runtime changes wake waiters; abort and close leave no timers", async () => {
  const clock = fakeClock(),
    controller = new BandwidthController(1250, clock);
  const pending = controller.consume(100000);
  controller.setRate(null);
  await pending;
  assert.equal(clock.pending, 0);
  controller.setRate(1000);
  const signal = new AbortController();
  const aborted = assert.rejects(
    controller.consume(100000, { signal: signal.signal }),
    { name: "AbortError" },
  );
  signal.abort();
  await aborted;
  assert.equal(clock.pending, 0);
  const closed = assert.rejects(controller.consume(100000), {
    name: "AbortError",
  });
  controller.close();
  await closed;
  await assert.rejects(controller.consume(1), { name: "AbortError" });
  assert.equal(clock.pending, 0);
});

test("TASK 03: lowering the rate clamps old credits and increasing it wakes a pending consumer", async () => {
  const clock = fakeClock(),
    controller = new BandwidthController(1250000, clock);
  controller.setRate(1250);
  assert.ok(controller.tokens <= 125);
  let done = false;
  const pending = controller.consume(2500).then(() => {
    done = true;
  });
  clock.tick(100);
  await Promise.resolve();
  assert.equal(done, false);
  controller.setRate(1250000);
  clock.tick(10);
  await pending;
  assert.equal(done, true);
});

test("TASK 05: policy separates HTTP and Scrapling and honors explicit limits", () => {
  assert.deepEqual(resolveNetworkPolicy(requireNetworkConfig()), {
    httpConcurrency: Infinity,
    scraplingConcurrency: Infinity,
    heavySpacingMs: [0, 0],
    retryJitterMs: [0, 0],
  });
  const friendly = resolveNetworkPolicy(
    requireNetworkConfig({ networkFriendlyMode: true }),
  );
  assert.equal(friendly.httpConcurrency, 2);
  assert.equal(friendly.scraplingConcurrency, 1);
  const explicit = resolveNetworkPolicy(
    requireNetworkConfig({
      networkFriendlyMode: true,
      maxConcurrentRequests: 4,
      maxConcurrentScraplingRequests: 3,
    }),
  );
  assert.equal(explicit.httpConcurrency, 4);
  assert.equal(explicit.scraplingConcurrency, 3);
});

test("TASK 05: permits are FIFO, abortable, idempotently released and close rejects waiters", async () => {
  const gate = new ConcurrencyGate(1);
  const release = await gate.acquire();
  const signal = new AbortController();
  const aborted = assert.rejects(gate.acquire(signal.signal), {
    name: "AbortError",
  });
  signal.abort();
  await aborted;
  const next = gate.acquire();
  assert.equal(gate.snapshot().waiting, 1);
  release();
  release();
  const finish = await next;
  assert.equal(gate.snapshot().active, 1);
  const closed = assert.rejects(gate.acquire(), { name: "AbortError" });
  gate.close();
  await closed;
  finish();
  assert.equal(gate.snapshot().active, 0);
});

test("TASK 05: increasing concurrency wakes waiters without revoking running permits", async () => {
  const gate = new ConcurrencyGate(1);
  const first = await gate.acquire();
  const next = gate.acquire();
  gate.setLimit(2);
  const second = await next;
  gate.setLimit(1);
  assert.equal(gate.snapshot().active, 2);
  first();
  second();
  assert.equal(gate.snapshot().active, 0);
});

test("TASK 05/07: network shutdown rejects permit, bandwidth and retry waits", async () => {
  const network = new NetworkService();
  network.configure({ bandwidthProfile: "potato", maxConcurrentRequests: 1 });
  const active = network.operation();
  const release = await network.acquire("http", active.signal);
  const permit = assert.rejects(network.acquire("http"), {
    name: "AbortError",
  });
  const bandwidth = assert.rejects(network.download.consume(100000), {
    name: "AbortError",
  });
  const retry = assert.rejects(network.wait(60000), { name: "AbortError" });
  await network.shutdown(0);
  await Promise.all([permit, bandwidth, retry]);
  assert.equal(active.signal.aborted, true);
  release();
  active.finish();
  assert.equal(network.snapshot().http.active, 0);
  assert.equal(network.snapshot().download.pending, 0);
});

test("TASK 13: an immediately granted permit is released if abort wins before admission resumes", async () => {
  const network = new NetworkService();
  const caller = new AbortController();
  const admission = network.acquire("http", caller.signal);
  caller.abort(cancelled());
  await assert.rejects(admission, { name: "AbortError" });
  assert.equal(network.snapshot().http.active, 0);
  assert.equal(network.snapshot().http.waiting, 0);
});

test("TASK 13: operation cancellation preserves caller/context signals and sibling isolation", async () => {
  const network = new NetworkService();
  const caller = new AbortController();
  const channel = new AbortController();
  const sibling = network.operation();
  const local = network.operation();
  const localReason = cancelled("local deadline");
  local.abort(localReason);
  assert.equal(local.signal.reason, localReason);
  assert.equal(sibling.signal.aborted, false);
  local.finish();
  const operation = runContext({ signal: channel.signal }, () =>
    network.operation(caller.signal));
  const reason = cancelled("parent cancelled");
  caller.abort(reason);
  assert.equal(operation.signal.reason, reason);
  assert.equal(sibling.signal.aborted, false);
  operation.finish();
  const contextual = runContext({ signal: channel.signal }, () => network.operation());
  const contextReason = cancelled("channel cancelled");
  channel.abort(contextReason);
  assert.equal(contextual.signal.reason, contextReason);
  contextual.finish();
  assert.throws(() => network.operation(caller.signal), { name: "AbortError" });
  assert.equal(network.snapshot().operations, 1);
  sibling.finish();
  await network.shutdown(0);
});

test("TASK 13: shutdown aborts every active operation even when abort handlers finish operations", async () => {
  const network = new NetworkService();
  const operations = Array.from({ length: 64 }, () => network.operation());
  for (const operation of operations)
    operation.signal.addEventListener("abort", () => operation.finish(), { once: true });
  await network.shutdown(0);
  assert.ok(operations.every((operation) => operation.signal.aborted));
  assert.equal(network.snapshot().operations, 0);
  assert.throws(() => network.operation(), { name: "AbortError" });
});

test("TASK 07: channel deduplication, WAITING state and cancellation do not count as failure", async () => {
  const tasks = new ChannelTasks(),
    entered = deferred(),
    release = deferred();
  const channel = { cacheKey: "same-channel" };
  let calls = 0;
  const run = async () => {
    calls++;
    entered.resolve();
    await waiting(release.promise, "bandwidth");
  };
  const first = tasks.run(0, channel, run),
    duplicate = tasks.run(1, channel, run);
  assert.equal(first, duplicate);
  await entered.promise;
  assert.equal(tasks.snapshot()["same-channel"].status, "waiting");
  assert.equal(tasks.snapshot()["same-channel"].failures, 0);
  release.resolve();
  await first;
  assert.equal(calls, 1);
  assert.equal(tasks.snapshot()["same-channel"].status, "completed");
  await assert.rejects(
    tasks.run(0, channel, async () => {
      throw cancelled();
    }),
  );
  assert.equal(tasks.snapshot()["same-channel"].status, "cancelled");
  assert.equal(tasks.snapshot()["same-channel"].failures, 0);
  await assert.rejects(
    tasks.run(0, channel, async () => {
      context().onFailure(new Error("network failed"));
    }),
  );
  assert.equal(tasks.snapshot()["same-channel"].status, "failed");
  assert.equal(tasks.snapshot()["same-channel"].failures, 1);
  tasks.stop();
  await assert.rejects(tasks.run(0, channel, run), { name: "AbortError" });
});
