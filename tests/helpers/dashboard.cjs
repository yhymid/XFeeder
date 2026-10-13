"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { startDashboard } = require("../../src/dashboard/server");
const { tempDir } = require("./temp-dir.cjs");

async function startTestDashboard(t, {
  password = "synthetic-dashboard-password",
  sessionTtlHours,
  publicOrigin = "",
  config = { channels: [] },
  envContent = "XFEEDER_TEST_SECRET=synthetic-env-value\n",
  cache = {},
} = {}) {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, ".env"), envContent);
  fs.writeFileSync(path.join(dir, "cache.json"), `${JSON.stringify(cache)}\n`);

  // The server captures these at creation. Restore immediately, so independent
  // server instances never share a fixture's password or TTL through the env.
  const overrides = {
    XFEEDER_DASHBOARD_PASSWORD: password,
    XFEEDER_DASHBOARD_SESSION_TTL_HOURS: sessionTtlHours,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  let server;
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = String(value);
    }
    server = startDashboard({ host: "127.0.0.1", port: 0, dataDir: dir, publicOrigin });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, "listening");
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const origin = publicOrigin || base;

  function request(requestPath, { method = "GET", headers = {}, json, body } = {}) {
    const payload = json === undefined ? body : JSON.stringify(json);
    return new Promise((resolve, reject) => {
      // A raw path is intentional: URL resolution in fetch/new URL can normalize
      // traversal probes before they reach the server under test.
      const req = http.request({
        hostname: "127.0.0.1", port, path: requestPath, method, agent: false,
        headers: { ...(json === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            const data = text && String(res.headers["content-type"]).startsWith("application/json")
              ? JSON.parse(text) : undefined;
            resolve({ status: res.statusCode, headers: res.headers, text, data });
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(5000, () => req.destroy(Object.assign(new Error("Dashboard fixture request timed out"), { code: "ETIMEDOUT" })));
      req.on("error", reject);
      req.end(payload);
    });
  }

  return {
    server, dir, base, origin, password, request,
    login: (candidate = password, headers = {}) => request("/api/login", {
      method: "POST", headers: { Origin: origin, ...headers }, json: { password: candidate },
    }),
  };
}

module.exports = { startTestDashboard };
