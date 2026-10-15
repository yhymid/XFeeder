"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDestinationAdapters } = require("../src/core/destination-adapters");

test("X3-16: adapters preserve provider-specific signatures and the original entry object", async () => {
  const calls = [];
  const entry = { title: "News", link: "https://example.invalid/post", discordData: { messageId: "42" } };
  const targets = {
    webhookUrl: "https://discord.example.invalid/webhook",
    threadId: "thread-123",
    telegramConfig: { BotToken: "synthetic-token", ChatID: "chat-fixture" },
  };
  const result = { ok: true };
  const adapters = createDestinationAdapters({
    sendMessage: async (...args) => { calls.push(["webhook", ...args]); return result; },
    sendTelegramMessage: async (...args) => { calls.push(["telegram", ...args]); return result; },
  });
  assert.strictEqual(await adapters.webhook.send(targets, entry), result);
  assert.strictEqual(await adapters.telegram.send(targets, entry), result);
  assert.deepEqual(calls, [
    ["webhook", targets.webhookUrl, targets.threadId, entry],
    ["telegram", targets.telegramConfig, entry],
  ]);
  assert.strictEqual(calls[0][3], entry);
  assert.strictEqual(calls[1][2], entry);
  assert.ok(Object.isFrozen(adapters));
  assert.ok(Object.isFrozen(adapters.webhook));
  assert.ok(Object.isFrozen(adapters.telegram));
});

test("X3-16: adapters propagate provider errors unchanged for cancellation and Retry-After", async () => {
  const failure = Object.assign(new Error("synthetic provider error"), {
    code: "ERR_BAD_RESPONSE",
    response: { status: 429, headers: { "retry-after": "15" } },
  });
  const adapters = createDestinationAdapters({
    sendMessage: async () => { throw failure; },
    sendTelegramMessage: async () => { throw failure; },
  });
  for (const adapter of [adapters.webhook, adapters.telegram]) {
    await assert.rejects(adapter.send({}, {}), error => error === failure);
  }
  assert.equal(failure.response.headers["retry-after"], "15");
});

test("X3-16: unsupported sender is isolated to its own configured destination", async () => {
  const calls = [];
  const adapters = createDestinationAdapters({
    sendMessage: async () => { calls.push("webhook"); },
  });
  await adapters.webhook.send({ webhookUrl: "https://example.invalid/hook" }, { title: "entry" });
  assert.deepEqual(calls, ["webhook"]);
  await assert.rejects(adapters.telegram.send({ telegramConfig: {} }, {}), /Telegram sender is not available/);
  assert.equal(adapters.missing, undefined);
});
