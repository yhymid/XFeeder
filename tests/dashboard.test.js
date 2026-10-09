"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const {
  parseActivity,
  readActivity,
  MAX_BYTES,
  MAX_EVENTS,
} = require("../src/dashboard/activity");
const { validateConfig } = require("../src/dashboard/validation");
const { collectConfiguredChannels } = require("../src/core/channel-config");
const { startDashboard } = require("../src/dashboard/server");
const now = Date.now();
const log = (event, details = {}, offset = 0) =>
  `[${new Date(now + offset).toISOString()}][worker][stdout] [Expert] ${JSON.stringify({ time: new Date(now + offset).toISOString(), event, ...details })}\n`;

test("activity normalizes deliveries, failures, fallback and parse events", () => {
  const result = parseActivity(
    log("channel.process.begin", { channel: "Blogs#1" }) +
      log("delivery.begin", {
        channel: "Blogs#1",
        source: "https://feed.example/rss",
        target: "webhook",
      }) +
      log("delivery.complete", {
        channel: "Blogs#1",
        target: "webhook",
        durationMs: 517,
      }) +
      log("feed.parsed", {
        url: "https://feed.example/rss",
        itemCount: 5,
        parser: "rss-parser",
      }) +
      log("http.request.failed", { status: 403 }) +
      log("scrapling.attempt.begin") +
      log("queue.channel.complete", { channel: "Blogs#1" }),
    { now },
  );
  assert.equal(result.summary.deliveries24h, 1);
  assert.equal(result.summary.errors24h, 1);
  assert.equal(result.summary.health, "warning");
  assert.equal(result.channels["Blogs#1"].status, "error");
  assert.equal(
    result.items.find((e) => e.event === "delivery.complete").source,
    "https://feed.example/rss",
  );
  assert.equal(
    result.items.find((e) => e.type === "parse").message,
    "5 entries parsed",
  );
});
test("activity never returns arbitrary payloads, headers, error messages or URL credentials", () => {
  const result = parseActivity(
    log("http.request.failed", {
      url: "https://user:PASS@example.com/api?key=QUERY&other=OPAQUE#FRAGMENT",
      error: {
        message: "UNSAFE MESSAGE",
        headers: { cookie: "COOKIE" },
        response: { data: "BODY" },
      },
      Token: "TOKEN",
      "x-super-properties": "PROPS",
    }) +
      log("delivery.complete", {
        source: "https://discord.com/api/webhooks/123/WEBHOOKSECRET",
        target: "webhook",
        channel: "Test",
      }) +
      log("feed.download.complete", {
        url: "https://api.telegram.org/bot123:TOKEN/sendMessage",
        ok: true,
      }),
    { now },
  );
  const json = JSON.stringify(result);
  for (const secret of [
    "PASS",
    "QUERY",
    "OPAQUE",
    "FRAGMENT",
    "UNSAFE MESSAGE",
    "COOKIE",
    "BODY",
    "PROPS",
    "WEBHOOKSECRET",
    "123:TOKEN",
  ])
    assert.ok(!json.includes(secret), secret);
  assert.ok(json.includes("REDACTED"));
});
test("empty, missing, malformed, future and old logs cannot report healthy", async () => {
  assert.equal(parseActivity("").summary.health, "unknown");
  assert.equal(parseActivity("").summary.deliveries24h, null);
  assert.equal(
    parseActivity("[Expert] {broken\n[Expert] null\n").items.length,
    0,
  );
  assert.equal(
    parseActivity(log("queue.channel.complete", {}, -86400000), { now }).summary
      .health,
    "unknown",
  );
  assert.equal(
    parseActivity(log("queue.channel.complete", {}, 3600000), { now }).items
      .length,
    0,
  );
  assert.equal(
    (await readActivity("/tmp/does-not-exist-xfeeder-log")).available,
    false,
  );
});
test("dry runs do not imply live worker health or actual deliveries", () => {
  const result = parseActivity(
    log("channel.process.begin", { channel: "Test", dryRun: true }) +
      log("delivery.simulated", { channel: "Test", target: "telegram" }) +
      log("channel.process.complete", { channel: "Test" }) +
      log("channel.complete", { channel: "Test" }),
    { now },
  );
  assert.equal(result.summary.health, "unknown");
  assert.equal(result.summary.deliveries24h, 0);
  assert.ok(result.items.every((e) => e.dryRun));
});
test("log parser caps event history, ignores dashboard messages and indicates partial counts", () => {
  const result = parseActivity(
    Array.from({ length: MAX_EVENTS + 20 }, () =>
      log("delivery.complete"),
    ).join("") +
      log("queue.channel.complete").replace("[worker]", "[dashboard]"),
    { now, limit: 2000 },
  );
  assert.equal(result.items.length, MAX_EVENTS);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.summary.partialWindow, true);
  assert.equal(result.summary.health, "unknown");
});
test("tail reader handles a large file and interrupted final line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xfeeder-tail-"));
  try {
    const file = path.join(dir, "terminal.txt");
    await fs.writeFile(
      file,
      "x".repeat(MAX_BYTES + 100) +
        "\n" +
        log("queue.channel.complete", { channel: "Test" }) +
        "[Expert] {unfinished",
    );
    const result = await readActivity(file, { now });
    assert.equal(result.items.length, 1);
    assert.equal(result.summary.truncated, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("model round-trips array, object and shorthand groups without changing any fields", async () => {
  const m = await import("../src/dashboard/public/model.mjs");
  const fixture = {
    ChannelDefaults: { TimeChecker: 60, Feeds: ["https://default/feed"] },
    Telegram: { Enabled: true, BotToken: "${TOKEN}", ChatID: "chat" },
    Blogs: [
      {
        RSS: "https://rss",
        Feeds: ["https://other"],
        URLs: ["https://url"],
        Sources: ["https://source"],
        Extra: { keep: true },
      },
      "https://short",
      ["https://list"],
    ],
    Named: {
      First: {
        Feeds: ["https://named"],
        Telegram: { BotToken: "", ChatID: "" },
      },
    },
    Unknown: { metadata: true },
    channelsEmpty: [],
  };
  const before = JSON.stringify(fixture);
  const rows = m.channels(fixture);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].feeds.length, 4);
  assert.equal(rows[1].feeds[0], "https://short");
  assert.equal(rows[2].feeds[0], "https://list");
  assert.equal(rows[3].data.Telegram.BotToken, "${TOKEN}");
  const core = collectConfiguredChannels(fixture);
  assert.deepEqual(
    rows.map((c) => c.feeds),
    core.map((c) => c.RSS),
  );
  assert.deepEqual(
    rows.map((c) => c.label),
    core.map((c) => c.name || `${c.sourceKey}#${c.index + 1}`),
  );
  const value = m.toData(rows[0].raw);
  value.TimeChecker = 15;
  m.putChannel(fixture, rows[0], value);
  assert.equal(fixture.Blogs[0].RSS, "https://rss");
  assert.deepEqual(fixture.Blogs[0].Sources, ["https://source"]);
  assert.deepEqual(fixture.Blogs[0].Extra, { keep: true });
  assert.equal(fixture.Blogs[1], "https://short");
});
test("model supports create, rename, move, duplicate and delete while retaining unknown fields", async () => {
  const m = await import("../src/dashboard/public/model.mjs");
  const c = {
    Named: { First: { RSS: ["https://a"], CacheKey: "unique", custom: 42 } },
    Blogs: [{ Feeds: ["https://b"] }],
  };
  m.duplicateChannel(c, m.channels(c)[0]);
  assert.equal(c.Named["First copy"].custom, 42);
  assert.notEqual(c.Named["First copy"].CacheKey, "unique");
  assert.throws(() =>
    m.putChannel(c, null, { RSS: [] }, { group: "Settings" }),
  );
  assert.throws(() =>
    m.putChannel(c, null, { RSS: [] }, { group: "Named", name: "First" }),
  );
  m.putChannel(c, m.channels(c)[0], c.Named.First, {
    group: "Named",
    name: "Renamed",
  });
  assert.equal(c.Named.Renamed.custom, 42);
  assert.ok(!c.Named.First);
  m.removeChannel(
    c,
    m.channels(c).find((c) => c.group === "Blogs"),
  );
  assert.ok(!c.Blogs);
});
test("Telegram inheritance matches the worker, including channel defaults and blank overrides", async () => {
  const m = await import("../src/dashboard/public/model.mjs");
  const c = {
    Telegram: {
      Enabled: true,
      BotToken: "root",
      ChatID: "root-chat",
      TimeoutMs: 15000,
    },
    ChannelDefaults: {
      Telegram: { MessageThreadID: 13, ChatID: "default-chat" },
    },
    channels: [
      { RSS: ["https://a"] },
      {
        RSS: ["https://b"],
        Telegram: { ChatID: "", BotToken: "", Enabled: false },
      },
    ],
  };
  const ui = m.channels(c),
    core = collectConfiguredChannels(c);
  for (let i = 0; i < ui.length; i++)
    for (const key of ["Enabled", "BotToken", "ChatID", "MessageThreadID"])
      assert.equal(ui[i].data.Telegram[key], core[i].Telegram[key], key);
  assert.equal(m.hasTelegram(ui[1].data.Telegram), false);
});
test("distributed example configuration remains unchanged after loading through the UI model", async () => {
  const m = await import("../src/dashboard/public/model.mjs");
  const text = await fs.readFile(
    path.join(__dirname, "../config.json.example"),
    "utf8",
  );
  const c = JSON.parse(text),
    before = JSON.stringify(c);
  assert.equal(m.channels(c).length, collectConfiguredChannels(c).length);
  assert.equal(JSON.stringify(c), before);
});
test("validation resolves environment refs and rejects invalid schedule values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xfeeder-validation-"));
  try {
    const env = path.join(dir, ".env");
    await fs.writeFile(env, "TEST_TELEGRAM_TOKEN=fixture-token\n");
    const c = {
      Telegram: { BotToken: "${TEST_TELEGRAM_TOKEN}", ChatID: "chat" },
      channels: [{ RSS: ["https://example/feed"], TimeChecker: -1 }],
    };
    assert.equal(validateConfig(c, env).errors.length, 1);
    assert.equal(validateConfig(c, env).warnings.length, 0);
    c.Telegram.BotToken = "${XFEEDER_TEST_MISSING}";
    assert.ok(validateConfig(c, env).warnings.length > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("API protects password auth, origin, Secure cookies, saves and validation warnings", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xfeeder-api-"));
  const config = {
    channels: {
      first: { RSS: ["https://example.com/feed"], Webhook: "fixture-webhook" },
    },
  };
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(config));
  await fs.writeFile(path.join(dir, ".env"), "FIXTURE=secret\n");
  const old = process.env.XFEEDER_DASHBOARD_PASSWORD;
  process.env.XFEEDER_DASHBOARD_PASSWORD = "fixture-password";
  let server;
  try {
    server = startDashboard({
      port: 0,
      dataDir: dir,
      publicOrigin: "https://feeds.example",
    });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    let response = await fetch(`${base}/api/activity`);
    assert.equal(response.status, 401);
    response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: JSON.stringify({ password: "fixture-password" }),
    });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { Origin: "https://feeds.example" },
      body: JSON.stringify({ password: "wrong" }),
    });
    assert.equal(response.status, 401);
    response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { Origin: "https://feeds.example" },
      body: JSON.stringify({ password: "fixture-password" }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    for (const flag of ["Secure", "HttpOnly", "SameSite=Strict"])
      assert.ok(cookie.includes(flag));
    const headers = {
      Cookie: cookie.split(";")[0],
      Origin: "https://feeds.example",
      "Content-Type": "application/json",
    };
    assert.equal((await fetch(`${base}/api/state`, { headers })).status, 200);
    response = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: {
        ...headers,
        Origin: "https://evil.example",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify(config),
    });
    assert.equal(response.status, 403);
    const bad = {
      channels: [{ RSS: ["https://example/feed"], TimeChecker: 0 }],
    };
    response = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify(bad),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")),
      config,
    );
    delete bad.channels[0].TimeChecker;
    response = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify(bad),
    });
    assert.equal(response.status, 422);
    assert.ok((await response.json()).warnings.length);
    response = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { ...headers, "X-XFeeder-Accept-Warnings": "true" },
      body: JSON.stringify(bad),
    });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).warnings.length);
    response = await fetch(`${base}/api/env`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ content: "UPDATED=fixture" }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      await fs.readFile(path.join(dir, ".env"), "utf8"),
      "UPDATED=fixture\n",
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")),
      bad,
    );
    assert.equal(
      (await fetch(`${base}/model.mjs`)).headers.get("content-type"),
      "application/javascript; charset=utf-8",
    );
    response = await fetch(`${base}/api/logout`, { method: "POST", headers });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("set-cookie").includes("Secure"));
    assert.equal((await fetch(`${base}/api/state`, { headers })).status, 401);
  } finally {
    if (old === undefined) delete process.env.XFEEDER_DASHBOARD_PASSWORD;
    else process.env.XFEEDER_DASHBOARD_PASSWORD = old;
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a truncated dry run and an unstarted queue cannot report healthy", () => {
  const dry = parseActivity(
    log("delivery.simulated", { channel: "Test" }) +
      log("channel.process.complete", { channel: "Test" }),
    { now, truncated: true },
  );
  assert.equal(dry.summary.health, "unknown");
  assert.ok(dry.items.every((item) => item.dryRun));
  assert.equal(
    parseActivity(log("channel.process.complete", { channel: "Test" }), { now })
      .summary.health,
    "unknown",
  );
  assert.equal(
    parseActivity(log("queue.not_started"), { now }).summary.health,
    "warning",
  );
});

test("channel summary keys are sanitized and cannot mutate object prototypes", () => {
  const result = parseActivity(
    log("channel.process.begin", { channel: "password=LABELSECRET" }) +
      log("queue.channel.complete", { channel: "password=LABELSECRET" }) +
      log("queue.channel.complete", { channel: "__proto__" }),
    { now },
  );
  assert.ok(!JSON.stringify(result).includes("LABELSECRET"));
  assert.equal(Object.getPrototypeOf(result.channels), null);
  assert.equal({}.status, undefined);
});
