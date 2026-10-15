"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTestDashboard } = require("./helpers/dashboard.cjs");
const { projectChannels, projectOverview, projectSettings } = require("../src/dashboard/api-projections");

const secret = "synthetic-long-webhook-secret";
const envSecret = "synthetic-private-env-value";
const legacy = {
  Settings: { Logs: true, DebugExpert: false, MaxConcurrentChannels: 2 },
  Auth: { Token: "synthetic-discord-source-token" },
  Proxy: { Enabled: false, Url: "http://user:password@proxy.example.invalid" },
  Telegram: { Enabled: false },
  channels: { news: {
    CacheKey: "news", Feeds: ["https://user:pass@rss.example.invalid/feed?token=" + secret],
    Webhook: "https://discord.com/api/webhooks/1/" + secret,
    TimeChecker: 15, RequestSend: 4,
  } },
};
const version2 = {
  schemaVersion: 2,
  settings: { logs: true, maxConcurrentChannels: 2 },
  integrations: { discord: { token: "${DISCORD_TOKEN}" } },
  channels: { news: {
    id: "news", timeChecker: 15, requestSend: 4,
    sources: [{ type: "feed", url: "https://rss.example.invalid/feed" }],
    destinations: [{ type: "webhook", url: "https://discord.com/api/webhooks/1/" + secret }],
  } },
};
async function authed(t, config) {
  const dashboard = await startTestDashboard(t, {
    config, envContent: "DISCORD_TOKEN=" + envSecret + "\n",
  });
  const login = await dashboard.login();
  assert.equal(login.status, 200);
  const set = login.headers["set-cookie"];
  const cookie = (Array.isArray(set) ? set[0] : set).split(";")[0];
  return { ...dashboard, headers: { Cookie: cookie },
    originHeaders: { Cookie: cookie, Origin: dashboard.origin } };
}

test("X3-32: default read endpoints never disclose inline credentials or source URLs", async t => {
  const d = await authed(t, legacy);
  for (const route of ["/api/overview", "/api/channels", "/api/settings", "/api/system/info"]) {
    assert.equal((await d.request(route)).status, 401, route);
    const res = await d.request(route, { headers: d.headers });
    assert.equal(res.status, 200, route);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(res.headers.etag, /^"[a-f0-9]{64}"$/);
    for (const value of [secret, envSecret, "synthetic-discord-source-token",
      "user:pass", "user:password@", "rss.example.invalid", "discord.com/api/webhooks"])
      assert.equal(res.text.includes(value), false, route + " leaked " + value);
  }
  const overview = (await d.request("/api/overview", { headers: d.headers })).data;
  assert.equal(overview.totalChannels, 1);
  assert.equal(overview.totalFeeds, 1);
  assert.equal(overview.destinations.webhook, 1);
  assert.equal(overview.workerReady, false);
  const listing = (await d.request("/api/channels", { headers: d.headers })).data;
  assert.equal(listing.channels.length, 1);
  assert.equal(listing.channels[0].maxEntriesPerCycle, 4);
  const id = listing.channels[0].id;
  const detail = await d.request("/api/channels/" + id, { headers: d.headers });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.channel, listing.channels[0]);
  assert.equal((await d.request("/api/channels/" + "f".repeat(24), { headers: d.headers })).status, 404);
  assert.equal((await d.request("/api/channels/not-an-id", { headers: d.headers })).status, 400);
  assert.equal((await d.request("/api/channels", { method: "POST", headers: d.originHeaders })).status, 405);
  assert.equal((await d.request("/api/state", { headers: d.headers })).headers.deprecation, "true");
});

test("X3-32: v2 config is supported by the safe read-only API", async t => {
  const d = await authed(t, version2);
  const ch = await d.request("/api/channels", { headers: d.headers });
  assert.equal(ch.status, 200);
  assert.equal(ch.data.channels.length, 1);
  const settings = await d.request("/api/settings", { headers: d.headers });
  assert.equal(settings.status, 200);
  assert.equal(settings.data.schemaVersion, 2);
  assert.equal(settings.data.general.logs, true);
  assert.equal(settings.data.general.maxConcurrentChannels, 2);
  const info = await d.request("/api/system/info", { headers: d.headers });
  assert.equal(info.status, 200);
  assert.equal(info.data.schemaVersion, 2);
  for (const res of [ch, settings, info]) {
    assert.equal(res.text.includes(secret), false);
    assert.equal(res.text.includes("${DISCORD_TOKEN}"), false);
  }
});

test("X3-32: advanced editor is authenticated and enforces CSRF and If-Match on v2 saves", async t => {
  const d = await authed(t, version2);
  assert.equal((await d.request("/api/advanced/config")).status, 401);
  const advanced = await d.request("/api/advanced/config", { headers: d.headers });
  assert.equal(advanced.status, 200);
  assert.deepEqual(advanced.data.config, version2);
  assert.match(advanced.headers.etag, /^"[a-f0-9]{64}"$/);
  const change = structuredClone(version2);
  change.settings.maxConcurrentChannels = 3;
  const put = (headers = {}, json = change) => d.request("/api/advanced/config", {
    method: "PUT", headers: { ...d.originHeaders, ...headers }, json,
  });
  assert.equal((await put()).status, 428);
  assert.equal((await put({ "If-Match": '"stale"' })).status, 412);
  assert.equal((await d.request("/api/advanced/config", {
    method: "PUT", headers: { ...d.headers, Origin: "https://attacker.example.invalid",
      "If-Match": advanced.headers.etag }, json: change,
  })).status, 403);
  const saved = await put({ "If-Match": advanced.headers.etag });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.ok, true);
  assert.equal(saved.text.includes(secret), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d.dir, "config.json"), "utf8")), change);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(path.join(d.dir, "config.json")).mode & 0o777, 0o600);
  assert.equal((await put({ "If-Match": advanced.headers.etag })).status, 412);
  const invalid = structuredClone(change);
  invalid.channels.news.destinations = [];
  const failed = await put({ "If-Match": '"' + saved.data.revision + '"' }, invalid);
  assert.equal(failed.status, 400);
  assert.equal(failed.text.includes(secret), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d.dir, "config.json"), "utf8")), change);
});

test("X3-32: direct projection helpers do not include raw token or webhook fields", () => {
  assert.equal(projectOverview(legacy, false).totalChannels, 1);
  assert.equal(projectSettings(legacy).integrations.proxyEnabled, false);
  const projected = projectChannels(legacy)[0];
  assert.equal(projected.destinations.webhook, true);
  assert.equal(JSON.stringify(projected).includes(secret), false);
  assert.throws(() => projectChannels({
    schemaVersion: 2, settings: {}, integrations: {}, channels: {
      bad: { sources: [], destinations: [] },
    },
  }), /./);
});
