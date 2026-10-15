"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  getRetryAfterMs,
  getRetryDelayMs,
  getDiscordRetryDelayMs,
  isRetryableRequestError,
} = require("../src/network/retry-policy");
const { getRetryAfterMs: legacyGetRetryAfterMs } = require("../src/client");
const { cancelled } = require("../src/network/abort");

test("X3-18: original GET limits and public Retry-After export retain exact semantics", () => {
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
  assert.equal(DEFAULT_RETRY_BASE_DELAY_MS, 500);
  assert.equal(DEFAULT_RETRY_MAX_DELAY_MS, 8000);
  assert.strictEqual(getRetryAfterMs, legacyGetRetryAfterMs);
  const now = Date.parse("2026-01-01T00:00:00Z");
  for (const [header, expected] of [
    [{ "Retry-After": "0" }, 0],
    [{ "Retry-After": "0.125" }, 125],
    [{ "Retry-After": "42" }, 42000],
    [{ "Retry-After": "Thu, 01 Jan 2026 00:00:03 GMT" }, 3000],
    [{ "Retry-After": "Wed, 31 Dec 2025 00:00:00 GMT" }, 0],
    [{ "Retry-After": "invalid" }, null],
    [{}, null],
  ]) assert.equal(getRetryAfterMs(header, now), expected);
  assert.equal(getRetryAfterMs({ get: () => "1.5" }, now), 1500);
});

test("X3-18: bounded retry applies only to existing transient GET errors", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504])
    assert.equal(isRetryableRequestError({ response: { status } }), true, `HTTP ${status}`);
  for (const status of [200, 304, 400, 401, 403, 404, 422])
    assert.equal(isRetryableRequestError({ response: { status } }), false, `HTTP ${status}`);
  for (const code of ["ECONNABORTED", "ECONNRESET", "EAI_AGAIN", "ETIMEDOUT", "ERR_NETWORK"])
    assert.equal(isRetryableRequestError({ code }), true, code);
  for (const error of [cancelled(), { name: "AbortError" }, { code: "ECONNABORTED", phase: "deadline" }])
    assert.equal(isRetryableRequestError(error), false, "cancellation and hard deadline never retry");
});

test("X3-18: GET retry delay preserves unbounded Retry-After minimum", t => {
  t.mock.method(Math, "random", () => 0.5);
  const err429 = { response: { status: 429, headers: { "Retry-After": "20" } } };
  assert.equal(getRetryDelayMs(err429, 0, 500, 8000), 20000);
  const err503 = { response: { status: 503, headers: { "retry-after": "0.2" } } };
  assert.equal(getRetryDelayMs(err503, 2, 500, 8000), 200);
  const other = { response: { status: 500 } };
  assert.equal(getRetryDelayMs(other, 0, 500, 8000), 500);
  assert.equal(getRetryDelayMs(other, 2, 500, 8000), 2000);
  assert.equal(getRetryDelayMs(other, 10, 500, 8000), 8000);
});

test("X3-18: Discord 429 policy retains provider-specific fields and legacy numeric units", () => {
  const response = { data: { retry_after: 1.25 }, headers: {
    "x-ratelimit-reset-after": "2.5", "retry-after": "3",
  } };
  assert.equal(getDiscordRetryDelayMs(response, 0), 1250, "Discord response body wins");
  assert.equal(getDiscordRetryDelayMs({ data: {}, headers: response.headers }, 0), 2500);
  assert.equal(getDiscordRetryDelayMs({ headers: { "retry-after": "2.5" } }, 0), 2500);
  assert.equal(getDiscordRetryDelayMs({ headers: { "retry-after": "1500" } }, 0), 1500);
  assert.equal(getDiscordRetryDelayMs({ headers: { "retry-after": "Fri, 01 Jan 2100 00:00:00 GMT" } }, 0), 500);
  assert.equal(getDiscordRetryDelayMs({ data: { retry_after: 0.01 } }, 0), 500);
  assert.equal(getDiscordRetryDelayMs({ data: { retry_after: 60 } }, 0), 15000);
  assert.equal(getDiscordRetryDelayMs({}, 2), 2000);
});
