"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { startDashboard } = require("../src/dashboard/server");
const { startTestDashboard } = require("./helpers/dashboard.cjs");

const TIMEOUT = { timeout: 10000 };
const LOCKED = { required: true, authenticated: false, mode: "password" };
const AUTHENTICATED = { ...LOCKED, authenticated: true };

function setCookie(response) {
  return response.headers["set-cookie"]?.[0] || null;
}

function sessionCookie(response) {
  assert.equal(response.status, 200, response.text);
  const cookie = setCookie(response);
  assert.ok(cookie, "successful password login must issue a session cookie");
  return cookie.split(";")[0];
}

test("dashboard public health and auth state expose no configuration before login", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t, {
    envContent: "DASHBOARD_TEST_PRIVATE=synthetic-auth-secret\n",
  });
  const health = await dashboard.request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.name, "xfeeder-dashboard");
  assert.equal(health.data.authRequired, true);
  assert.equal(typeof health.data.version, "string");
  const auth = await dashboard.request("/api/auth-state");
  assert.equal(auth.status, 200);
  assert.deepEqual(auth.data, { auth: LOCKED });
  for (const response of [health, auth]) {
    assert.equal(setCookie(response), null);
    assert.ok(!response.text.includes("synthetic-auth-secret"));
    assert.ok(!response.text.includes(dashboard.password));
    assert.equal(response.data.config, undefined);
    assert.equal(response.data.env, undefined);
    assert.equal(response.data.envFile, undefined);
  }
});

test("every protected dashboard API rejects anonymous requests without modifying files", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t);
  const files = ["config.json", ".env", "cache.json"];
  const before = await Promise.all(files.map((file) => fs.readFile(path.join(dashboard.dir, file), "utf8")));
  for (const [method, endpoint, json] of [
    ["GET", "/api/state"],
    ["GET", "/api/activity"],
    ["GET", "/api/settings/network"],
    ["GET", "/api/network/metrics"],
    ["POST", "/api/validate", {}],
    ["PUT", "/api/config", {}],
    ["PUT", "/api/env", { content: "UNAUTHORIZED=must-not-be-written" }],
    ["PUT", "/api/settings/network", {}],
  ]) {
    const response = await dashboard.request(endpoint, {
      method,
      headers: { Origin: dashboard.origin },
      json,
    });
    assert.equal(response.status, 401, `${method} ${endpoint}: ${response.text}`);
    assert.deepEqual(response.data, { error: "Dashboard password required.", auth: LOCKED });
    assert.equal(setCookie(response), null);
  }
  assert.deepEqual(await Promise.all(files.map((file) => fs.readFile(path.join(dashboard.dir, file), "utf8"))), before);
});

test("dashboard login rejects wrong, missing and non-string passwords without issuing sessions", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t);
  for (const json of [
    { password: "incorrect" },
    { password: `${dashboard.password} ` },
    {},
    { password: null },
    { password: 123 },
    { password: { value: dashboard.password } },
    null,
  ]) {
    const response = await dashboard.request("/api/login", {
      method: "POST", headers: { Origin: dashboard.origin }, json,
    });
    assert.equal(response.status, 401, response.text);
    assert.deepEqual(response.data, { error: "Invalid dashboard password.", auth: LOCKED });
    assert.equal(setCookie(response), null);
  }
  const state = await dashboard.request("/api/auth-state");
  assert.deepEqual(state.data.auth, LOCKED);
});

test("dashboard login malformed JSON returns 400 and leaves subsequent login available", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t);
  const invalid = await dashboard.request("/api/login", {
    method: "POST", headers: { Origin: dashboard.origin }, body: "{broken",
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.data, { error: "Invalid JSON." });
  assert.equal(setCookie(invalid), null);
  const cookie = sessionCookie(await dashboard.login());
  assert.deepEqual((await dashboard.request("/api/auth-state", { headers: { Cookie: cookie } })).data.auth, AUTHENTICATED);
});

test("dashboard password login issues a scoped opaque HTTP cookie and unlocks state", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t);
  const login = await dashboard.login();
  const cookie = sessionCookie(login);
  assert.deepEqual(login.data, { ok: true, auth: AUTHENTICATED });
  assert.match(cookie, /^xfeeder_session=[0-9a-f-]{36}$/);
  assert.notEqual(cookie.split("=")[1], dashboard.password);
  const attributes = setCookie(login).split("; ").slice(1);
  assert.deepEqual(new Set(attributes), new Set(["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=43200"]));
  const state = await dashboard.request("/api/state", { headers: { Cookie: cookie } });
  assert.equal(state.status, 200);
  assert.deepEqual(state.data.auth, AUTHENTICATED);
  assert.equal(setCookie(state), null);
});

test("dashboard custom session TTL is reflected in the initial cookie", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t, { sessionTtlHours: 1.5 });
  const login = await dashboard.login();
  sessionCookie(login);
  assert.ok(setCookie(login).split("; ").includes("Max-Age=5400"));
});

test("dashboard invalid session TTL falls back to twelve hours", TIMEOUT, async (t) => {
  for (const sessionTtlHours of ["not-a-number", "Infinity", 0, -1]) {
    const dashboard = await startTestDashboard(t, { sessionTtlHours });
    const login = await dashboard.login();
    sessionCookie(login);
    assert.ok(setCookie(login).split("; ").includes("Max-Age=43200"), String(sessionTtlHours));
  }
});

test("dashboard ignores forged and malformed session cookies without crashing", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t);
  for (const Cookie of [
    "xfeeder_session=00000000-0000-4000-8000-000000000000",
    "xfeeder_session=%E0%A4%A",
    "xfeeder_session=",
    "xfeeder_session",
    "unrelated=anything; =invalid; xfeeder_session=%",
    "xfeeder_session=__proto__",
  ]) {
    const response = await dashboard.request("/api/state", { headers: { Cookie } });
    assert.equal(response.status, 401, Cookie);
    assert.deepEqual(response.data.auth, LOCKED);
  }
  const cookie = sessionCookie(await dashboard.login());
  const response = await dashboard.request("/api/auth-state", {
    headers: { Cookie: `broken=%; unrelated=one=two; ${cookie}; ignored` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.auth, AUTHENTICATED);
});

test("dashboard logout invalidates only its session and expires the browser cookie", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t);
  const first = sessionCookie(await dashboard.login());
  const second = sessionCookie(await dashboard.login());
  assert.notEqual(first, second);
  const logout = await dashboard.request("/api/logout", {
    method: "POST", headers: { Origin: dashboard.origin, Cookie: first },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.data, { ok: true });
  assert.equal(setCookie(logout), "xfeeder_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  assert.equal((await dashboard.request("/api/state", { headers: { Cookie: first } })).status, 401);
  assert.equal((await dashboard.request("/api/state", { headers: { Cookie: second } })).status, 200);
  const replay = await dashboard.request("/api/logout", {
    method: "POST", headers: { Origin: dashboard.origin, Cookie: first },
  });
  assert.equal(replay.status, 200);
  assert.equal((await dashboard.request("/api/state", { headers: { Cookie: second } })).status, 200);
});

test("dashboard sessions are isolated between server instances using the same password", TIMEOUT, async (t) => {
  const first = await startTestDashboard(t);
  const second = await startTestDashboard(t);
  const cookie = sessionCookie(await first.login());
  assert.equal((await first.request("/api/state", { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await second.request("/api/state", { headers: { Cookie: cookie } })).status, 401);
  const secondCookie = sessionCookie(await second.login());
  assert.notEqual(secondCookie, cookie);
  assert.equal((await second.request("/api/state", { headers: { Cookie: secondCookie } })).status, 200);
  assert.equal((await first.request("/api/state", { headers: { Cookie: secondCookie } })).status, 401);
});

test("dashboard session expires at its exact TTL without a real-time wait", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t, { sessionTtlHours: 1 });
  let now = 1800000000000;
  t.mock.method(Date, "now", () => now);
  const cookie = sessionCookie(await dashboard.login());
  now += 60 * 60 * 1000;
  const expired = await dashboard.request("/api/auth-state", { headers: { Cookie: cookie } });
  assert.deepEqual(expired.data.auth, LOCKED);
  assert.equal((await dashboard.request("/api/state", { headers: { Cookie: cookie } })).status, 401);
  const fresh = sessionCookie(await dashboard.login());
  assert.notEqual(fresh, cookie);
  assert.equal((await dashboard.request("/api/state", { headers: { Cookie: fresh } })).status, 200);
});

test("dashboard authenticated reads extend server session TTL without reissuing the cookie", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t, { sessionTtlHours: 1 });
  let now = 1800000000000;
  t.mock.method(Date, "now", () => now);
  const cookie = sessionCookie(await dashboard.login());
  now += 45 * 60 * 1000;
  const read = await dashboard.request("/api/auth-state", { headers: { Cookie: cookie } });
  assert.deepEqual(read.data.auth, AUTHENTICATED);
  assert.equal(setCookie(read), null);
  now += 45 * 60 * 1000;
  const afterOriginalExpiry = await dashboard.request("/api/state", { headers: { Cookie: cookie } });
  assert.equal(afterOriginalExpiry.status, 200);
  assert.equal(setCookie(afterOriginalExpiry), null);
  now += 60 * 60 * 1000;
  assert.equal((await dashboard.request("/api/state", { headers: { Cookie: cookie } })).status, 401);
});

test("dashboard passwordless loopback mode needs no login or session cookie", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t, { password: "" });
  const auth = { required: false, authenticated: true, mode: "local-open" };
  const health = await dashboard.request("/api/health");
  assert.equal(health.data.authRequired, false);
  assert.deepEqual((await dashboard.request("/api/auth-state")).data.auth, auth);
  const state = await dashboard.request("/api/state");
  assert.equal(state.status, 200);
  assert.deepEqual(state.data.auth, auth);
  const login = await dashboard.login("unused");
  assert.equal(login.status, 200);
  assert.deepEqual(login.data, { ok: true, auth });
  assert.equal(setCookie(login), null);
});

test("dashboard refuses a passwordless non-loopback bind before opening a listener", TIMEOUT, async (t) => {
  const dashboard = await startTestDashboard(t, { password: "" });
  const previous = process.env.XFEEDER_DASHBOARD_PASSWORD;
  try {
    process.env.XFEEDER_DASHBOARD_PASSWORD = "   ";
    for (const host of ["0.0.0.0", "::", "192.0.2.1"]) {
      assert.throws(
        () => startDashboard({ host, port: 0, dataDir: dashboard.dir, publicOrigin: "" }),
        /non-loopback host.*XFEEDER_DASHBOARD_PASSWORD/,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.XFEEDER_DASHBOARD_PASSWORD;
    else process.env.XFEEDER_DASHBOARD_PASSWORD = previous;
  }
  assert.equal((await dashboard.request("/api/health")).status, 200);
});
