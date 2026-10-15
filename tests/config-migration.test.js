"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { migrateConfig, toLegacyRuntime, ConfigMigrationError } = require("../src/core/config-migration");
const { collectConfiguredChannels } = require("../src/core/channel-config");
const { validateConfigSchema, assertRuntimeConfigSchema } = require("../src/core/config-schema");
const { migrateFile, parseArgs } = require("../scripts/migrate-config.cjs");
const { loadConfig } = require("../src/config-loader");
const { validateConfig } = require("../src/dashboard/validation");
const { tempDir } = require("./helpers/temp-dir.cjs");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/config", name), "utf8"));
const shape = config => collectConfiguredChannels(config).map(c => ({
  id: c.cacheKey, feeds: c.RSS, webhook: c.Webhook,
  interval: c.TimeChecker, burst: c.RequestSend,
}));

test("X3-30: named groups migrate deterministically without changing cache IDs", () => {
  const legacy = fixture("migration-legacy.json"), before = structuredClone(legacy);
  const v2 = migrateConfig(legacy);
  assert.deepEqual(legacy, before);
  assert.deepEqual(migrateConfig(legacy), v2);
  assert.deepEqual(migrateConfig(v2), v2);
  assert.deepEqual(validateConfigSchema(v2).errors, []);
  assert.deepEqual(shape(toLegacyRuntime(v2)), shape(legacy));
  assert.deepEqual(shape(assertRuntimeConfigSchema(v2)), shape(legacy));
  assert.deepEqual(Object.values(v2.channels).map(c => c.id), ["channels:news", "channels2:alerts"]);
  assert.equal(v2.channels.news.sources.length, 3);
  assert.equal(v2.channels.news.destinations.length, 2);
  assert.match(v2.channels.news.destinations[1].chatId, /TELEGRAM_CHAT_NEWS/);
});

test("X3-30: unnamed channel groups retain their original hashed delivery identities", () => {
  const old = fixture("migration-anonymous.json");
  const v2 = migrateConfig(old);
  assert.deepEqual(shape(toLegacyRuntime(v2)), shape(old));
  assert.equal(Object.keys(v2.channels).length, 2);
  assert.deepEqual(Object.values(v2.channels).map(c => c.id),
    collectConfiguredChannels(old).map(c => c.cacheKey));
});

test("X3-30: worker can read a v2 configuration with equivalent runtime channels", t => {
  const dir = tempDir(t), file = path.join(dir, "config.json");
  const v2 = migrateConfig(fixture("migration-anonymous.json"));
  fs.writeFileSync(file, JSON.stringify(v2));
  assert.deepEqual(shape(loadConfig(file)), shape(toLegacyRuntime(v2)));
  const validated = validateConfig(v2, path.join(dir, ".env"));
  assert.equal(validated.schemaVersion, 2);
  assert.equal(validated.runtimeSupported, true);
  assert.deepEqual(validated.errors, []);
});

test("X3-30: advanced legacy settings are never silently dropped", () => {
  const old = fixture("migration-legacy.json");
  for(const [edit, expected] of [
    [c => { c.network = { outboundPolicy: "public-only" }; }, /network/],
    [c => { c.Scrapling.DefaultOptions = { stealthyHeaders: true }; }, /Scrapling.DefaultOptions/],
    [c => { c.channels.news.ExtraPlugin = { secret: "hidden" }; }, /ExtraPlugin/],
    [c => { c.channels.news.Discord.UnknownHeader = "hidden"; }, /Discord.UnknownHeader/],
    [c => { c.ChannelDefaults.Header = "hidden"; }, /ChannelDefaults.Header/],
  ]){
    const copy = structuredClone(old);
    edit(copy);
    const before = structuredClone(copy);
    assert.throws(() => migrateConfig(copy), e =>
      e instanceof ConfigMigrationError &&
      e.errors.some(issue => expected.test(issue.path)) &&
      !JSON.stringify(e.errors).includes("hidden"));
    assert.deepEqual(copy, before);
  }
});

test("X3-30: unsupported v2 multi-destination and disabled channels fail closed", () => {
  const v2 = migrateConfig(fixture("migration-anonymous.json"));
  const key = Object.keys(v2.channels)[0];
  v2.channels[key].destinations.push({ type: "webhook", url: "https://example.invalid/second" });
  assert.throws(() => toLegacyRuntime(v2), { code: "CONFIG_MIGRATION_UNSAFE" });
  v2.channels[key].destinations.pop();
  v2.channels[key].enabled = false;
  assert.throws(() => toLegacyRuntime(v2), e =>
    e.code === "CONFIG_MIGRATION_UNSAFE" &&
    e.errors.some(issue => issue.path.endsWith(".enabled")));
});

test("X3-30: no-write preview, exclusive output, and backed-up in-place migration", t => {
  const dir = tempDir(t), file = path.join(dir, "config.json");
  const original = fs.readFileSync(path.join(__dirname,
    "fixtures/config/migration-anonymous.json"), "utf8");
  fs.writeFileSync(file, original);
  assert.equal(migrateFile({ configPath: file }).written, false);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(file + ".v2.json"), false);
  assert.equal(migrateFile({ configPath: file, write: true }).written, true);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(shape(loadConfig(file + ".v2.json")), shape(JSON.parse(original)));
  assert.throws(() => migrateFile({ configPath: file, write: true }), /already exists/);
  assert.equal(migrateFile({ configPath: file, write: true, inPlace: true }).written, true);
  assert.equal(fs.readFileSync(file + ".legacy.bak", "utf8"), original);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 2);
  assert.throws(() => migrateFile({ configPath: file, write: true, inPlace: true }), /already exists/);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file + ".legacy.bak").mode & 0o777, 0o600);
});

test("X3-30: CLI requires explicit write, no shell interpolation", () => {
  assert.deepEqual(parseArgs(["--config", "fixture.json", "--write"]),
    { configPath: "fixture.json", write: true, inPlace: false });
  for (const args of [["--in-place"], ["--unknown"], ["--config"]])
    assert.throws(() => parseArgs(args));
});

test("X3-30: anonymous channels with env placeholders refuse unsafe identity conversion", () => {
  const input = { channels: [{ Feeds: ["https://feeds.example.invalid/rss"],
    Webhook: "$" + "{WEBHOOK_SECRET}" }] };
  assert.throws(() => migrateConfig(input), e =>
    e.code === "CONFIG_MIGRATION_UNSAFE" &&
    e.errors.some(issue => issue.code === "dynamic_identity"));
});
