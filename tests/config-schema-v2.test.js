"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CONFIG_SCHEMA_V2, validateConfigSchema, assertRuntimeConfigSchema,
} = require("../src/core/config-schema");
const { loadConfig } = require("../src/config-loader");
const { validateConfig } = require("../src/dashboard/validation");
const { startTestDashboard } = require("./helpers/dashboard.cjs");
const { tempDir } = require("./helpers/temp-dir.cjs");

function example() {
  return {
    schemaVersion: 2,
    settings: { logs: false, maxConcurrentChannels: 2 },
    integrations: {
      discord: { token: "${DISCORD_TOKEN}" },
      telegram: { botToken: "${TELEGRAM_TOKEN}", chatId: "${CHAT_ID}" },
      proxy: { enabled: false },
    },
    channels: {
      news: {
        id: "stable-id",
        sources: [
          { type: "feed", url: "https://example.invalid/rss" },
          { type: "discord", channelIds: ["synthetic-channel-id"] },
        ],
        destinations: [
          { type: "webhook", url: "${DISCORD_WEBHOOK}" },
          { type: "telegram", chatId: "${CHAT_ID}" },
        ],
        timeChecker: 30,
        requestSend: 5,
      },
    },
  };
}

test("X3-29: schema is serializable draft 2020-12 and valid v2 drafts are accepted", () => {
  assert.equal(CONFIG_SCHEMA_V2.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(JSON.parse(JSON.stringify(CONFIG_SCHEMA_V2)).properties.schemaVersion.const, 2);
  assert.deepEqual(validateConfigSchema(example()), { ok: true, schemaVersion: 2, errors: [] });
  assert.equal(validateConfigSchema({ schemaVersion: 2, settings: {}, integrations: {}, channels: {} }).ok, true);
  assert.equal(validateConfigSchema({ channels: [] }).legacy, true);
});

test("X3-29: channel source URL error includes stable JSON path and no user input", () => {
  const input = example();
  input.channels.news.sources[1] = { type: "feed", url: "file:///private/path?token=secret" };
  const issues = validateConfigSchema(input).errors;
  assert.deepEqual(issues, [{
    path: "channels.news.sources[1].url",
    code: "invalid_url",
    message: "Expected an http or https URL",
  }]);
  assert.ok(!JSON.stringify(issues).includes("secret"));
});

test("X3-29: precise missing/unknown/range/type errors and closed schema", () => {
  const input = example();
  input.settings.maxConcurrentChannels = 9;
  input.integrations.discord.extraToken = "super-secret";
  input.channels.news.sources.push({ type: "ftp", url: "https://example.invalid" });
  input.channels.news.destinations = [];
  delete input.channels.news.id;
  delete input.channels.news.sources[0].url;
  const issues = validateConfigSchema(input).errors;
  for (const [p, code] of [
    ["settings.maxConcurrentChannels", "out_of_range"],
    ["integrations.discord.extraToken", "unknown_field"],
    ["channels.news.sources[0].url", "required"],
    ["channels.news.sources[2].type", "invalid_enum"],
    ["channels.news.destinations", "too_few_items"],
  ]) assert.ok(issues.some(x => x.path === p && x.code === code), p + ": " + code);
  assert.equal(issues.some(x => JSON.stringify(x).includes("super-secret")), false);
});

test("X3-29: unknown versions and malformed config root fail safely", () => {
  assert.deepEqual(validateConfigSchema(null).errors, [{
    path: "$", code: "invalid_type", message: "Config root must be a JSON object",
  }]);
  assert.equal(validateConfigSchema({ schemaVersion: "2" }).errors[0].code, "unsupported_version");
  assert.equal(validateConfigSchema({ schemaVersion: 3 }).errors[0].path, "schemaVersion");
  const errors = validateConfigSchema({ schemaVersion: 2, channels: {} }).errors;
  assert.deepEqual(errors.map(e => e.path).sort(), ["integrations", "settings"]);
  const unknown = example();
  unknown.channels["bad channel"] = unknown.channels.news;
  assert.ok(validateConfigSchema(unknown).errors.some(e => e.code === "invalid_name"));
});

test("X3-30: worker accepts supported v2 configs but rejects malformed URLs", t => {
  const directory = tempDir(t), configPath = path.join(directory, "config.json");
  const config = example();
  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.equal(loadConfig(configPath).channels.news.CacheKey, "stable-id");
  assert.equal(assertRuntimeConfigSchema(config).channels.news.CacheKey, "stable-id");
  config.channels.news.sources[0].url = "ssh://example.invalid/feed";
  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => loadConfig(configPath), error =>
    error.code === "INVALID_CONFIG_SCHEMA" &&
    error.errors.some(issue => issue.path === "channels.news.sources[0].url"));
});

test("X3-29: legacy loader and dashboard validation keep original config semantics", t => {
  const directory = tempDir(t), configPath = path.join(directory, "config.json");
  const legacy = { Settings: { MaxConcurrentChannels: 1 },
    channels: { news: { Feeds: ["https://example.invalid/rss"], Webhook: "https://example.invalid/webhook" } } };
  fs.writeFileSync(configPath, JSON.stringify(legacy));
  assert.deepEqual(loadConfig(configPath), legacy);
  const original = validateConfig(legacy, path.join(directory, ".env"));
  assert.deepEqual(original.errors, []);
  assert.deepEqual(original.warnings, []);
  const v2 = validateConfig(example(), path.join(directory, ".env"));
  assert.deepEqual(v2.errors, []);
  assert.deepEqual(v2.issues, []);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.runtimeSupported, true);
});

test("X3-29: dashboard validates v2 draft but refuses to save it as active worker config", async t => {
  const fixture = await startTestDashboard(t);
  const login = await fixture.login();
  assert.equal(login.status, 200);
  const cookies = login.headers["set-cookie"];
  const session = (Array.isArray(cookies) ? cookies[0] : cookies).split(";")[0];
  const headers = { Cookie: session, Origin: fixture.origin };
  const draft = example();
  const validated = await fixture.request("/api/validate", {
    method: "POST", headers, json: draft,
  });
  assert.equal(validated.status, 200);
  assert.deepEqual(validated.data.errors, []);
  const state = await fixture.request("/api/state", { headers });
  assert.equal(state.status, 200);
  assert.ok(state.data.revision);
  const before = fs.readFileSync(path.join(fixture.dir, "config.json"), "utf8");
  const saving = await fixture.request("/api/config", {
    method: "PUT",
    headers: { ...headers, "If-Match": '"' + state.data.revision + '"' },
    json: draft,
  });
  assert.equal(saving.status, 409);
  assert.equal(saving.data.code, "CONFIG_MIGRATION_REQUIRED");
  assert.equal(fs.readFileSync(path.join(fixture.dir, "config.json"), "utf8"), before);
});
