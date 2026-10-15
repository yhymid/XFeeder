"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLogger, formatRecord } = require("../src/core/logger");
const { setExpertDebug } = require("../src/core/diagnostics");

test("X3-12: structured logger redacts sensitive keys, tokens, URLs and errors", t => {
  const captured = [];
  t.mock.method(console, "error", (...values) => captured.push(values.join(" ")));
  const logger = createLogger("Delivery");
  logger.error("POST https://discord.com/api/webhooks/123456789/synthetic-credential failed", {
    authorization: "Bearer synthetic-secret-value",
    nested: {
      BotToken: "fixture-telegram-token",
      password: "fixture-password",
      url: "https://user:pass@example.invalid/path?token=fixture-query",
    },
    error: new Error("Bearer fixture-error-secret"),
  });

  assert.equal(captured.length, 1);
  const result = captured[0];
  for (const secret of [
    "synthetic-credential", "synthetic-secret-value", "fixture-telegram-token",
    "fixture-password", "fixture-query", "fixture-error-secret", "user:pass",
  ]) assert.ok(!result.includes(secret), `logger leaked ${secret}`);
  assert.match(result, /\[Delivery\]\[error\]/);
  assert.match(result, /\[REDACTED\]/);
});

test("X3-12: debug logs are gated while ordinary logs remain available", t => {
  setExpertDebug(false);
  t.after(() => setExpertDebug(false));
  const captured = [];
  t.mock.method(console, "log", value => captured.push(value));
  const logger = createLogger("Runtime");
  logger.debug("disabled detail", { value: 1 });
  assert.equal(captured.length, 0);
  logger.info("ready", { activeTasks: 2 });
  assert.match(captured[0], /activeTasks":2/);
  setExpertDebug(true);
  logger.debug("diagnostic", { authorization: "secret-value" });
  assert.equal(captured.length, 2);
  assert.ok(!captured[1].includes("secret-value"));
});

test("X3-12: logging does not mutate source metadata", () => {
  const value = {
    authorization: "Bearer synthetic-token",
    nested: { url: "https://user:pass@example.invalid/?key=abc" },
  };
  const snapshot = structuredClone(value);
  const output = formatRecord("Network", "warn", "request failed", value);
  assert.deepEqual(value, snapshot);
  assert.ok(!output.includes("synthetic-token"));
  assert.ok(!output.includes("user:pass"));
  assert.ok(!output.includes("key=abc"));
  assert.match(output, /request failed/);
});


test("X3-12: scheduler error output never emits untrusted credential text", async t => {
  const { runChannelsOnce } = require("../src/app/runtime");
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  t.mock.method(console, "log", () => {});
  const secret = "synthetic-refresh-secret";
  await assert.rejects(
    runChannelsOnce({
      getChannels: () => [{ ID: "testing" }],
      checkFeedsForChannel: async () => {},
      beforeRun: () => { throw new Error(`Bearer ${secret}`); },
    }),
    /synthetic-refresh-secret/,
  );
  // A preflight exception does not get separately logged here. Verify the
  // logger itself handles the untrusted error from the scheduler boundary.
  createLogger("Scheduler").error("Configuration refresh failed", { error: new Error(`Bearer ${secret}`) });
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes(secret));
  assert.match(logged[0], /\[REDACTED\]/);
});

test("X3-12: Discord source failure is redacted without changing the thrown failure", async t => {
  const { parseDiscord } = require("../src/parsers/discord");
  const secret = "synthetic-discord-source-secret";
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  t.mock.method(console, "log", () => {});
  const entries = await parseDiscord(
    { Token: "fixture-token", ChannelIDs: ["123456789"] },
    { get: async () => { throw new Error(`Bearer ${secret}`); } },
  );
  assert.deepEqual(entries, []);
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes(secret));
  assert.match(logged[0], /\[REDACTED\]/);
});
