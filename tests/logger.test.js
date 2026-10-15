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
