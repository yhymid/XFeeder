"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { XFeederError, ERROR_CATEGORIES, classifyError, errorRecord } = require("../src/core/errors");
const { cancelled } = require("../src/network/abort");

test("X3-13: taxonomy is closed and an opt-in wrapper preserves its original cause", () => {
  assert.ok(ERROR_CATEGORIES.includes("delivery"));
  assert.ok(ERROR_CATEGORIES.includes("state"));
  const original = Object.assign(new Error("connect failed"), { code: "ECONNRESET" });
  const wrapped = new XFeederError("delivery failed", {
    category: "delivery", code: "DELIVERY_FAILED", cause: original,
    metadata: { destination: "webhook" },
  });
  assert.equal(wrapped.cause, original);
  assert.equal(wrapped.code, "DELIVERY_FAILED");
  assert.equal(wrapped.category, "delivery");
  assert.equal(classifyError(wrapped), "delivery");
  assert.throws(() => new XFeederError("invalid", { category: "typo" }), /Unknown XFeeder error category/);
});

test("X3-13: cancellation and timeout take precedence over contextual classification", () => {
  assert.equal(classifyError(cancelled(), { context: "delivery" }), "cancellation");
  assert.equal(classifyError({ name: "AbortError" }, { context: "network" }), "cancellation");
  assert.equal(classifyError({ code: "ECONNABORTED" }, { context: "delivery" }), "timeout");
  assert.equal(classifyError({ code: "UND_ERR_CONNECT_TIMEOUT" }), "timeout");
  assert.equal(classifyError({ code: "ECONNRESET" }, { context: "parser" }), "network");
});

test("X3-13: known persistence/configuration/state errors retain their domains", () => {
  assert.equal(classifyError({ code: "CACHE_UNSAFE" }), "state");
  assert.equal(classifyError({ code: "INVALID_NETWORK_CONFIG" }), "configuration");
  assert.equal(classifyError({ code: "ENOSPC" }), "persistence");
  assert.equal(classifyError(new Error("source failed"), { context: "source" }), "source");
  assert.equal(classifyError(new Error("invalid XML"), { context: "parser" }), "parser");
  assert.equal(classifyError({ response: { status: 403 } }), "network");
  assert.equal(classifyError({ message: "authorization" }), "unknown");
  assert.equal(classifyError(null), "unknown");
});

test("X3-13: telemetry record is bounded, redacted and never contains raw cause or request body", () => {
  const secret = "synthetic-secrettoken";
  const cause = new Error("Bearer " + secret);
  const error = new XFeederError("Failed request https://user:pass@example.invalid/path?token=" + secret, {
    category: "delivery", code: "DELIVERY_FAILED", cause,
    metadata: { password: secret },
  });
  error.response = { status: 429, headers: { authorization: secret }, data: { credential: secret } };
  const record = errorRecord(error);
  assert.deepEqual(Object.keys(record), ["category", "code", "httpStatus", "message"]);
  assert.equal(record.category, "delivery");
  assert.equal(record.httpStatus, 429);
  assert.equal(record.code, "DELIVERY_FAILED");
  assert.ok(!JSON.stringify(record).includes(secret));
  assert.ok(!JSON.stringify(record).includes("user:pass"));
  assert.equal(error.cause, cause);
  assert.equal(error.response.data.credential, secret);

  const oversized = errorRecord(new Error("x".repeat(2000)));
  assert.equal(oversized.message.length, 500);
  assert.equal(oversized.code, null);
  assert.equal(oversized.httpStatus, null);
});

test("X3-13: raw Axios-like error stays intact for Retry-After and destination handling", () => {
  const error = Object.assign(new Error("provider request failed"), {
    code: "ERR_BAD_RESPONSE",
    response: { status: 429, headers: { "retry-after": "30" } },
  });
  const record = errorRecord(error, { context: "delivery" });
  assert.equal(record.category, "network");
  assert.equal(record.httpStatus, 429);
  assert.equal(error.response.headers["retry-after"], "30");
  assert.equal(error.code, "ERR_BAD_RESPONSE");
});
