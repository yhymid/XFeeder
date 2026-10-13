"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { startDashboard } = require("../src/dashboard/server");
const { startTestDashboard } = require("./helpers/dashboard.cjs");

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function snapshotFiles(dir) {
  return Object.fromEntries(["config.json", ".env", "cache.json"].map((file) => [
    file, fs.readFileSync(path.join(dir, file), "utf8"),
  ]));
}

async function authenticatedHeaders(dashboard) {
  const login = await dashboard.login();
  assert.equal(login.status, 200);
  return { Cookie: login.headers["set-cookie"][0].split(";")[0], Origin: dashboard.origin };
}

function envPayload(bytes, glyph = "x") {
  const prefix = "XFEEDER_TEST_PADDING=";
  const overhead = Buffer.byteLength(JSON.stringify({ content: `${prefix}\n` }));
  const available = bytes - overhead;
  const width = Buffer.byteLength(glyph);
  const content = prefix + glyph.repeat(Math.floor(available / width)) + "x".repeat(available % width) + "\n";
  const body = JSON.stringify({ content });
  assert.equal(Buffer.byteLength(body), bytes);
  return { content, body };
}

// Keep the HTTP framing separate from body size: a chunked sender supplies no
// Content-Length, and one chunk ends halfway through a UTF-8 character.
function chunkedRequest(dashboard, body, headers) {
  const payload = Buffer.from(body);
  const split = payload.indexOf(Buffer.from("é")) + 1;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: dashboard.server.address().port,
      path: "/api/env", method: "PUT", agent: false,
      headers: { ...headers, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(Object.assign(new Error("Chunked request timed out"), { code: "ETIMEDOUT" })));
    req.write(payload.subarray(0, split));
    req.write(payload.subarray(split, 1024 * 1024));
    req.end(payload.subarray(1024 * 1024));
  });
}

test("raw traversal paths cannot expose server code, configuration or environment files", async (t) => {
  const dashboard = await startTestDashboard(t);
  const seen = [];
  dashboard.server.on("request", (req) => seen.push(req.url));
  const attempts = [
    "/../server.js", "/../../core/config-loader.js", "/../../../config.json",
    "/../../../../.env", "/%2e%2e/server.js", "/%2e%2e/%2e%2e/config.json",
    "/..%2fserver.js", "/%2e%2e%2fserver.js", "/..%5cserver.js",
    "/%252e%252e%252fserver.js", "/.env", "/config.json", "/cache.json",
    "/debug/terminal.txt", "/.git/config",
  ];
  for (const attemptedPath of attempts) {
    const response = await dashboard.request(attemptedPath);
    assert.equal(response.status, 404, attemptedPath);
    assert.equal(response.text, "Not found", attemptedPath);
  }
  assert.deepEqual(seen, attempts, "The client must send traversal probes without normalizing them first");
});

test("dot segments normalize to public assets without escaping the public directory", async (t) => {
  const dashboard = await startTestDashboard(t);
  const index = await dashboard.request("/");
  assert.equal(index.status, 200);
  for (const attemptedPath of ["/../index.html", "/../../index.html", "/%2e%2e/index.html"]) {
    const response = await dashboard.request(attemptedPath);
    assert.equal(response.status, 200, attemptedPath);
    assert.equal(response.text, index.text, attemptedPath);
  }
});

test("unsupported write methods return 405 without changing dashboard files", async (t) => {
  const dashboard = await startTestDashboard(t);
  const headers = await authenticatedHeaders(dashboard);
  const before = snapshotFiles(dashboard.dir);
  for (const [method, route] of [
    ["POST", "/api/state"], ["PATCH", "/api/config"], ["DELETE", "/api/env"],
    ["PUT", "/api/login"], ["POST", "/api/health"], ["OPTIONS", "/api/config"],
    ["POST", "/api/settings/network"], ["PUT", "/api/network/metrics"],
    ["DELETE", "/index.html"],
  ]) {
    const response = await dashboard.request(route, { method, headers, json: { ignored: true } });
    assert.equal(response.status, 405, `${method} ${route}`);
    assert.equal(response.data.error, "Method not allowed.");
  }
  assert.deepEqual(snapshotFiles(dashboard.dir), before);
});

test("GET on write-only or unknown API routes uses the current static 404 fallback", async (t) => {
  const dashboard = await startTestDashboard(t);
  const headers = await authenticatedHeaders(dashboard);
  for (const route of ["/api/config", "/api/env", "/api/login", "/api/validate", "/api/unknown"]) {
    const response = await dashboard.request(route, { headers });
    assert.equal(response.status, 404, route);
    assert.equal(response.text, "Not found");
  }
});

test("HEAD is unsupported and returns no response body", async (t) => {
  const dashboard = await startTestDashboard(t);
  for (const route of ["/", "/api/health"]) {
    const response = await dashboard.request(route, { method: "HEAD" });
    assert.equal(response.status, 405, route);
    assert.equal(response.text, "");
  }
});

test("security headers apply to public assets, API responses and rejected requests", async (t) => {
  const dashboard = await startTestDashboard(t);
  for (const [route, options, status] of [
    ["/", {}, 200], ["/model.mjs", {}, 200], ["/api/health", {}, 200],
    ["/api/state", {}, 401], ["/api/login", { method: "POST", headers: { Origin: "https://untrusted.example.invalid" } }, 403],
    ["/not-a-public-file", {}, 404], ["/api/config", { method: "PATCH" }, 405],
  ]) {
    const response = await dashboard.request(route, options);
    assert.equal(response.status, status, route);
    assert.equal(response.headers["x-content-type-options"], "nosniff", route);
    assert.equal(response.headers["referrer-policy"], "no-referrer", route);
    const csp = response.headers["content-security-policy"].split("; ");
    for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"]) {
      assert.ok(csp.includes(directive), `${route}: ${directive}`);
    }
    assert.equal(response.headers["access-control-allow-origin"], undefined, route);
  }
});

test("HTML and API responses are non-cacheable while static modules retain their short cache policy", async (t) => {
  const dashboard = await startTestDashboard(t);
  for (const route of ["/", "/index.html", "/api/health", "/api/auth-state", "/api/state", "/missing"]) {
    assert.equal((await dashboard.request(route)).headers["cache-control"], "no-store", route);
  }
  const moduleResponse = await dashboard.request("/model.mjs");
  assert.equal(moduleResponse.headers["cache-control"], "public, max-age=300");
  assert.equal(moduleResponse.headers["content-type"], "application/javascript; charset=utf-8");
});

for (const [label, glyph, chunked] of [["ASCII", "x", false], ["multibyte UTF-8", "é", false], ["chunked UTF-8", "é", true]]) {
  test(`body limit accepts exactly 2 MiB of ${label} JSON`, async (t) => {
    const dashboard = await startTestDashboard(t);
    const headers = await authenticatedHeaders(dashboard);
    const { body, content } = envPayload(MAX_BODY_BYTES, glyph);
    let receivedHeaders;
    dashboard.server.on("request", (req) => { receivedHeaders = req.headers; });
    const response = chunked
      ? await chunkedRequest(dashboard, body, headers)
      : await dashboard.request("/api/env", { method: "PUT", headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, body });
    assert.equal(response.status, 200);
    if (chunked) {
      assert.equal(receivedHeaders["transfer-encoding"], "chunked");
      assert.equal(receivedHeaders["content-length"], undefined);
    } else {
      assert.equal(receivedHeaders["content-length"], String(MAX_BODY_BYTES));
    }
    assert.equal(fs.readFileSync(path.join(dashboard.dir, ".env"), "utf8"), content);
  });

  test(`body limit rejects 2 MiB plus one byte of ${label} JSON without saving`, async (t) => {
    const dashboard = await startTestDashboard(t);
    const headers = await authenticatedHeaders(dashboard);
    const before = snapshotFiles(dashboard.dir);
    const { body } = envPayload(MAX_BODY_BYTES + 1, glyph);
    if (glyph !== "x") assert.ok(body.length < MAX_BODY_BYTES, "Byte count, not string length, must enforce the limit");
    // Current server destroys the request instead of sending an HTTP 413.
    // A timeout or arbitrary application error is not an acceptable rejection.
    await assert.rejects(chunked
      ? chunkedRequest(dashboard, body, headers)
      : dashboard.request("/api/env", { method: "PUT", headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, body }),
    (error) => ["ECONNRESET", "EPIPE"].includes(error.code));
    assert.deepEqual(snapshotFiles(dashboard.dir), before);
    assert.equal((await dashboard.request("/api/health")).status, 200);
    assert.equal((await dashboard.request("/api/state", { headers })).status, 200);
  });
}

test("login, validation, configuration and network writes share the same body limit", async (t) => {
  const dashboard = await startTestDashboard(t);
  const headers = await authenticatedHeaders(dashboard);
  const before = snapshotFiles(dashboard.dir);
  const body = "{}" + " ".repeat(MAX_BODY_BYTES - 1);
  for (const [method, route] of [
    ["POST", "/api/login"], ["POST", "/api/validate"], ["PUT", "/api/config"], ["PUT", "/api/settings/network"],
  ]) {
    await assert.rejects(dashboard.request(route, {
      method, headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, body,
    }), (error) => ["ECONNRESET", "EPIPE"].includes(error.code), route);
    assert.deepEqual(snapshotFiles(dashboard.dir), before, route);
    assert.equal((await dashboard.request("/api/health")).status, 200, route);
  }
});

test("configured HTTPS origin works over loopback HTTP and issues Secure session cookies", async (t) => {
  const dashboard = await startTestDashboard(t, { publicOrigin: "https://feeds.example.invalid:8443" });
  const response = await dashboard.login(undefined, {
    Host: "internal-service.invalid:3000", "X-Forwarded-Proto": "http", "X-Forwarded-Host": "wrong.example.invalid",
  });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"][0];
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) {
    assert.ok(cookie.split("; ").includes(attribute), attribute);
  }
  const logout = await dashboard.request("/api/logout", {
    method: "POST", headers: { Origin: dashboard.origin, Cookie: cookie.split(";")[0] },
  });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers["set-cookie"][0].includes("; Secure"));
  assert.ok(logout.headers["set-cookie"][0].includes("Max-Age=0"));
});

test("Host and forwarded headers cannot replace an explicitly configured HTTPS origin", async (t) => {
  const dashboard = await startTestDashboard(t, { publicOrigin: "https://feeds.example.invalid" });
  for (const origin of ["http://feeds.example.invalid", "https://feeds.example.invalid:444", "https://forged.example.invalid", dashboard.base]) {
    const response = await dashboard.login(undefined, {
      Origin: origin, Host: "forged.example.invalid", "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "forged.example.invalid", Forwarded: "proto=https;host=forged.example.invalid",
    });
    assert.equal(response.status, 403, origin);
    assert.equal(response.data.error, "Origin mismatch.");
    assert.equal(response.headers["set-cookie"], undefined);
  }
});

test("forwarded HTTPS headers alone cannot enable HTTPS origin matching or Secure cookies", async (t) => {
  const dashboard = await startTestDashboard(t);
  const forwarded = { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "feeds.example.invalid", Forwarded: "proto=https;host=feeds.example.invalid" };
  const rejected = await dashboard.login(undefined, { ...forwarded, Origin: "https://feeds.example.invalid" });
  assert.equal(rejected.status, 403);
  const accepted = await dashboard.login(undefined, forwarded);
  assert.equal(accepted.status, 200);
  assert.ok(!accepted.headers["set-cookie"][0].split("; ").includes("Secure"));
});

test("public origin configuration rejects paths, credentials and unsupported schemes before binding", () => {
  for (const publicOrigin of [
    "https://feeds.example.invalid/", "https://feeds.example.invalid/dashboard", "https://feeds.example.invalid?query=yes",
    "https://feeds.example.invalid#fragment", "https://user:password@feeds.example.invalid",
    "ftp://feeds.example.invalid", "file:///tmp/dashboard", "not an origin",
  ]) {
    assert.throws(
      () => startDashboard({ port: 0, publicOrigin }),
      (error) => error.code === "ERR_INVALID_URL" || error.message.includes("XFEEDER_DASHBOARD_PUBLIC_ORIGIN"),
      publicOrigin,
    );
  }
});
