"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { startTestDashboard } = require("./helpers/dashboard.cjs");

const bounded = { timeout: 10000 };
const initial = {
  channels: { news: {
    Feeds: ["https://feeds.example.invalid/rss"],
    Webhook: "https://delivery.example.invalid/test-hook",
    RequestSend: 2,
  } },
  network: { bandwidthProfile: "unlimited" },
  note: "retained custom setting",
};

function files(fixture) {
  return Object.fromEntries(["config.json", ".env", "cache.json"].map((name) =>
    [name, fs.readFileSync(path.join(fixture.dir, name), "utf8")]));
}

function noChanges(fixture, before) {
  assert.deepEqual(files(fixture), before);
  assert.ok(!fs.readdirSync(fixture.dir).some((name) => name.endsWith(".tmp")));
}

async function authenticated(t, options = {}) {
  const fixture = await startTestDashboard(t, { config: initial, ...options });
  const login = await fixture.login();
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers["set-cookie"][0].split(";")[0], Origin: fixture.origin };
  return { ...fixture, headers };
}

test("config validation returns errors and warnings without writing any state", bounded, async (t) => {
  const f = await authenticated(t);
  const before = files(f);
  const response = await f.request("/api/validate", { method: "POST", headers: f.headers, json: {
    channels: [{ Feeds: ["https://feeds.example.invalid/rss"], TimeChecker: 0 }],
  } });
  assert.equal(response.status, 200);
  assert.equal(response.data.errors.length, 1);
  assert.match(response.data.errors[0], /Check interval/);
  assert.equal(response.data.warnings.length, 1);
  assert.match(response.data.warnings[0], /missing delivery target/);
  noChanges(f, before);
});

test("config mutation preserves raw env references, options and unrelated files", bounded, async (t) => {
  const f = await authenticated(t, { envContent: "XFEEDER_X3_TEST_BOT=synthetic-bot-token\n", cache: { existing: { feed: ["delivered"] } } });
  const before = files(f);
  const state = await f.request("/api/state", { headers: f.headers });
  assert.equal(state.status, 200);
  const next = {
    ...initial,
    channels: { news: {
      ...initial.channels.news, TimeChecker: 90, customLabel: "preserved",
      Telegram: { BotToken: "${XFEEDER_X3_TEST_BOT}", ChatID: "synthetic-chat", MessageThreadID: 12 },
    } },
  };
  const saved = await f.request("/api/config", { method: "PUT",
    headers: { ...f.headers, "If-Match": `"${state.data.revision}"` }, json: next });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.config, next);
  assert.deepEqual(saved.data.errors, []);
  assert.deepEqual(saved.data.warnings, []);
  assert.notEqual(saved.data.revision, state.data.revision);
  assert.equal(fs.readFileSync(path.join(f.dir, "config.json"), "utf8"), `${JSON.stringify(next, null, 2)}\n`);
  assert.equal(files(f)[".env"], before[".env"]);
  assert.equal(files(f)["cache.json"], before["cache.json"]);
  assert.ok(!fs.existsSync(path.join(f.dir, "config.json.tmp")));
  const reloaded = await f.request("/api/state", { headers: f.headers });
  assert.deepEqual(reloaded.data.config, next);
  assert.equal(reloaded.data.revision, saved.data.revision);
});

test("full config writes reject a stale revision but retain the optional If-Match behavior", bounded, async (t) => {
  const f = await authenticated(t);
  const state = await f.request("/api/state", { headers: f.headers });
  const headers = { ...f.headers, "If-Match": `"${state.data.revision}"` };
  const first = await f.request("/api/config", { method: "PUT", headers, json: { ...initial, note: "first update" } });
  assert.equal(first.status, 200);
  const beforeStale = files(f);
  const stale = await f.request("/api/config", { method: "PUT", headers, json: initial });
  assert.equal(stale.status, 412);
  assert.match(stale.data.error, /Configuration changed/);
  noChanges(f, beforeStale);
  // Existing full editor compatibility: revision checking is optional here.
  const unconditional = await f.request("/api/config", { method: "PUT", headers: f.headers, json: initial });
  assert.equal(unconditional.status, 200);
  assert.deepEqual(JSON.parse(files(f)["config.json"]), initial);
});

test("malformed JSON is rejected by every JSON mutation/validation endpoint without side effects", bounded, async (t) => {
  const f = await authenticated(t);
  const before = files(f);
  for (const [method, route] of [["PUT", "/api/config"], ["PUT", "/api/env"],
    ["PUT", "/api/settings/network"], ["POST", "/api/validate"]]) {
    const response = await f.request(route, { method, headers: f.headers, body: '{"broken":' });
    assert.equal(response.status, 400, route);
    assert.deepEqual(response.data, { error: "Invalid JSON." });
    noChanges(f, before);
  }
});

test("config root and invalid channel settings cannot overwrite a valid config", bounded, async (t) => {
  const f = await authenticated(t);
  const before = files(f);
  for (const json of [null, [], "string", 42, false]) {
    const response = await f.request("/api/config", { method: "PUT", headers: f.headers, json });
    assert.equal(response.status, 400);
    assert.deepEqual(response.data, { error: "Config root must be a JSON object." });
    noChanges(f, before);
  }
  const invalid = await f.request("/api/config", { method: "PUT", headers: f.headers, json: {
    ...initial, channels: { news: { ...initial.channels.news, RequestSend: -1 } },
  } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.errors.length, 1);
  assert.match(invalid.data.errors[0], /Maximum entries/);
  noChanges(f, before);
});

test("configuration warnings require the explicit true acknowledgement before a write", bounded, async (t) => {
  const f = await authenticated(t);
  const before = files(f);
  const next = { channels: [{ Feeds: ["https://feeds.example.invalid/rss"] }] };
  for (const value of [undefined, "false", "TRUE"]) {
    const response = await f.request("/api/config", { method: "PUT", json: next,
      headers: { ...f.headers, ...(value === undefined ? {} : { "X-XFeeder-Accept-Warnings": value }) } });
    assert.equal(response.status, 422);
    assert.deepEqual(response.data.errors, []);
    assert.equal(response.data.warnings.length, 1);
    noChanges(f, before);
  }
  const response = await f.request("/api/config", { method: "PUT", json: next,
    headers: { ...f.headers, "X-XFeeder-Accept-Warnings": "true" } });
  assert.equal(response.status, 200);
  assert.equal(response.data.warnings.length, 1);
  assert.deepEqual(JSON.parse(files(f)["config.json"]), next);
});

test("environment mutation adds a final newline without modifying config or delivery cache", bounded, async (t) => {
  const f = await authenticated(t);
  const before = files(f);
  for (const content of ["X3_FIXTURE=synthetic\nEMPTY=", "X3_FIXTURE=synthetic\nEMPTY=\n"]) {
    const response = await f.request("/api/env", { method: "PUT", headers: f.headers, json: { content } });
    assert.equal(response.status, 200);
    assert.equal(files(f)[".env"], "X3_FIXTURE=synthetic\nEMPTY=\n");
    assert.equal(response.data.envFile, "X3_FIXTURE=synthetic\nEMPTY=\n");
    assert.equal(files(f)["config.json"], before["config.json"]);
    assert.equal(files(f)["cache.json"], before["cache.json"]);
    assert.ok(!fs.existsSync(path.join(f.dir, ".env.tmp")));
  }
});

test("non-string environment content leaves all fixture files unchanged", bounded, async (t) => {
  const f = await authenticated(t);
  const before = files(f);
  for (const content of [undefined, null, false, 42, [], {}]) {
    const response = await f.request("/api/env", { method: "PUT", headers: f.headers, json: { content } });
    assert.equal(response.status, 400);
    assert.deepEqual(response.data, { error: "Environment content must be a string." });
    noChanges(f, before);
  }
});

test("mismatched and null origins block all state-changing routes without changing files or the session", bounded, async (t) => {
  const f = await authenticated(t);
  const before = files(f);
  const routes = [
    ["POST", "/api/login", { password: f.password }], ["POST", "/api/logout", {}],
    ["POST", "/api/validate", initial], ["PUT", "/api/config", initial],
    ["PUT", "/api/env", { content: "CHANGED=unexpected" }],
    ["PUT", "/api/settings/network", { bandwidthProfile: "medium" }],
  ];
  for (const origin of ["https://outside.example.invalid", "null", `${f.origin}/path`, "http://127.0.0.1:1"]) {
    for (const [method, route, json] of routes) {
      const response = await f.request(route, { method, json, headers: { ...f.headers, Origin: origin } });
      assert.equal(response.status, 403, `${method} ${route} ${origin}`);
      assert.deepEqual(response.data, { error: "Origin mismatch." });
      assert.equal(response.headers["set-cookie"], undefined);
      noChanges(f, before);
    }
  }
  assert.equal((await f.request("/api/state", { headers: f.headers })).status, 200);
});

test("legacy origin policy permits missing Origin for login and authenticated writes", bounded, async (t) => {
  const f = await startTestDashboard(t, { config: initial });
  const login = await f.request("/api/login", { method: "POST", json: { password: f.password } });
  assert.equal(login.status, 200);
  const Cookie = login.headers["set-cookie"][0].split(";")[0];
  const saved = await f.request("/api/env", { method: "PUT", headers: { Cookie }, json: { content: "NO_ORIGIN=fixture" } });
  assert.equal(saved.status, 200);
  assert.equal(files(f)[".env"], "NO_ORIGIN=fixture\n");
});

test("legacy origin policy without publicOrigin derives its allowed origin from Host", bounded, async (t) => {
  const f = await authenticated(t);
  const response = await f.request("/api/env", {
    method: "PUT", json: { content: "HOST_POLICY=fixture" },
    headers: { ...f.headers, Host: "fixture-proxy.example.invalid", Origin: "http://fixture-proxy.example.invalid" },
  });
  assert.equal(response.status, 200);
  assert.equal(files(f)[".env"], "HOST_POLICY=fixture\n");
});
