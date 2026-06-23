"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const {
  collectChannelGroupEntries,
  collectConfiguredChannels,
  validateChannels,
} = require("../core/channel-config");

const { version: appVersion } = require("../../package.json");

const ROOT_DIR = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const CACHE_PATH = path.join(ROOT_DIR, "cache.json");
const ENV_PATH = path.join(ROOT_DIR, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, ".env.example");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SESSION_COOKIE_NAME = "xfeeder_session";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function readText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeTextAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      received += Buffer.byteLength(chunk);
      if (received > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function collectEnvRefs(value, bucket = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      bucket.add(match[1]);
    }
    return bucket;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectEnvRefs(entry, bucket);
    return bucket;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectEnvRefs(entry, bucket);
  }

  return bucket;
}

function summarizeCache(cache) {
  const preview = [];
  let totalBuckets = 0;
  let totalItems = 0;

  for (const [channelKey, channelBucket] of Object.entries(cache || {})) {
    if (!channelBucket || typeof channelBucket !== "object") continue;

    for (const [bucketKey, values] of Object.entries(channelBucket)) {
      if (!Array.isArray(values)) continue;
      totalBuckets += 1;
      totalItems += values.length;
      preview.push({
        channel: channelKey,
        bucket: bucketKey,
        count: values.length,
      });
    }
  }

  preview.sort((left, right) => right.count - left.count);

  return {
    channelBuckets: Object.keys(cache || {}).length,
    totalBuckets,
    totalItems,
    preview: preview.slice(0, 24),
  };
}

function parseCookies(header = "") {
  const cookies = {};
  for (const chunk of String(header || "").split(";")) {
    const separatorIndex = chunk.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = chunk.slice(0, separatorIndex).trim();
    const value = chunk.slice(separatorIndex + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function isLoopbackHost(host = "") {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function compareSecrets(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildCookie(name, value, { maxAgeSeconds = null } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];

  if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }

  return parts.join("; ");
}

function buildExpiredCookie(name) {
  return buildCookie(name, "", { maxAgeSeconds: 0 });
}

function createAuthManager({ host }) {
  const password = String(process.env.XFEEDER_DASHBOARD_PASSWORD || "").trim();
  const loopbackOnly = isLoopbackHost(host);
  const sessionHours = Number(process.env.XFEEDER_DASHBOARD_SESSION_TTL_HOURS);
  const ttlMs = Number.isFinite(sessionHours) && sessionHours > 0
    ? Math.floor(sessionHours * 60 * 60 * 1000)
    : 12 * 60 * 60 * 1000;
  const sessions = new Map();

  if (!loopbackOnly && !password) {
    throw new Error(
      "Dashboard is binding to a non-loopback host. Set XFEEDER_DASHBOARD_PASSWORD before exposing it outside localhost."
    );
  }

  function purgeExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, record] of sessions.entries()) {
      if (!record || record.expiresAt <= now) {
        sessions.delete(sessionId);
      }
    }
  }

  function getSessionId(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    return cookies[SESSION_COOKIE_NAME] || "";
  }

  function getAuthState(req) {
    purgeExpiredSessions();

    if (!password) {
      return {
        required: false,
        authenticated: true,
        mode: "local-open",
      };
    }

    const sessionId = getSessionId(req);
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        required: true,
        authenticated: false,
        mode: "password",
      };
    }

    session.expiresAt = Date.now() + ttlMs;
    sessions.set(sessionId, session);
    return {
      required: true,
      authenticated: true,
      mode: "password",
    };
  }

  function login(candidatePassword) {
    if (!password) {
      return {
        ok: true,
        cookie: null,
      };
    }

    if (!compareSecrets(candidatePassword, password)) {
      return {
        ok: false,
      };
    }

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      expiresAt: Date.now() + ttlMs,
    });

    return {
      ok: true,
      cookie: buildCookie(SESSION_COOKIE_NAME, sessionId, {
        maxAgeSeconds: Math.floor(ttlMs / 1000),
      }),
    };
  }

  function logout(req) {
    const sessionId = getSessionId(req);
    if (sessionId) {
      sessions.delete(sessionId);
    }
    return buildExpiredCookie(SESSION_COOKIE_NAME);
  }

  return {
    required: Boolean(password),
    loopbackOnly,
    getAuthState,
    login,
    logout,
  };
}

function createStatePayload(serverInfo = {}, authState = {}) {
  const config = readJson(CONFIG_PATH, {});
  const cache = readJson(CACHE_PATH, {});
  const channels = collectConfiguredChannels(config);
  const warnings = validateChannels(channels);
  const channelGroupEntries = collectChannelGroupEntries(config || {});
  const totalFeeds = channels.reduce((sum, channel) => {
    return sum + (Array.isArray(channel.RSS) ? channel.RSS.length : 0);
  }, 0);

  return {
    config,
    warnings,
    envFile: readText(ENV_PATH, ""),
    envExample: readText(ENV_EXAMPLE_PATH, ""),
    cacheSummary: summarizeCache(cache),
    stats: {
      groups: channelGroupEntries.map(([key, value]) => ({
        key,
        mode: Array.isArray(value) ? "array" : "object",
        count: Array.isArray(value)
          ? value.length
          : (value && typeof value === "object" ? Object.keys(value).length : 0),
      })),
      totalChannelGroups: channelGroupEntries.length,
      totalChannels: channels.length,
      totalFeeds,
      envRefs: Array.from(collectEnvRefs(config)).sort(),
    },
    auth: authState,
    meta: {
      host: serverInfo.host || "127.0.0.1",
      port: serverInfo.port || 3000,
      configPath: CONFIG_PATH,
      envPath: ENV_PATH,
      cachePath: CACHE_PATH,
      appVersion,
      configReload: "worker picks up config and .env changes from disk on the next cycle",
      security: {
        authMode: authState.mode || "local-open",
        passwordRequired: authState.required === true,
      },
    },
  };
}

function serveStatic(reqPath, res) {
  const normalized = reqPath === "/" ? "/index.html" : reqPath;
  const safePath = path.normalize(normalized).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
  });
  res.end(body);
}

function ensureSameOrigin(req, res, expectedHost) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  if (origin === expectedHost) return true;

  sendJson(res, 403, {
    error: "Origin mismatch.",
  });
  return false;
}

function requireDashboardAccess(req, res, authManager) {
  const authState = authManager.getAuthState(req);
  if (authState.required && !authState.authenticated) {
    sendJson(res, 401, {
      error: "Dashboard password required.",
      auth: authState,
    });
    return null;
  }
  return authState;
}

function startDashboard({ host = "127.0.0.1", port = 3000 } = {}) {
  const authManager = createAuthManager({ host });

  const server = http.createServer(async (req, res) => {
    const requestHost = req.headers.host || `${host}:${port}`;
    const url = new URL(req.url, `http://${requestHost}`);
    const serverAddress = server.address();
    const serverInfo = {
      host,
      port: serverAddress && typeof serverAddress === "object" ? serverAddress.port : port,
    };
    const expectedOrigin = `http://${requestHost}`;

    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          name: "xfeeder-dashboard",
          version: appVersion,
          authRequired: authManager.required,
          time: new Date().toISOString(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/auth-state") {
        sendJson(res, 200, {
          auth: authManager.getAuthState(req),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        const rawBody = await parseRequestBody(req);
        const parsed = JSON.parse(rawBody || "{}");
        const loginResult = authManager.login(typeof parsed?.password === "string" ? parsed.password : "");
        if (!loginResult.ok) {
          sendJson(res, 401, {
            error: "Invalid dashboard password.",
            auth: authManager.getAuthState(req),
          });
          return;
        }

        sendJson(
          res,
          200,
          {
            ok: true,
            auth: {
              required: authManager.required,
              authenticated: true,
              mode: authManager.required ? "password" : "local-open",
            },
          },
          loginResult.cookie ? { "Set-Cookie": loginResult.cookie } : {}
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        if (!ensureSameOrigin(req, res, expectedOrigin)) return;
        const expiredCookie = authManager.logout(req);
        sendJson(res, 200, { ok: true }, { "Set-Cookie": expiredCookie });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const authState = requireDashboardAccess(req, res, authManager);
        if (!authState) return;
        sendJson(res, 200, createStatePayload(serverInfo, authState));
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/config") {
        if (!ensureSameOrigin(req, res, expectedOrigin)) return;
        const authState = requireDashboardAccess(req, res, authManager);
        if (!authState) return;

        const rawBody = await parseRequestBody(req);
        const parsed = JSON.parse(rawBody || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          sendJson(res, 400, { error: "Config root must be a JSON object." });
          return;
        }

        writeTextAtomic(CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
        sendJson(res, 200, createStatePayload(serverInfo, authState));
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/env") {
        if (!ensureSameOrigin(req, res, expectedOrigin)) return;
        const authState = requireDashboardAccess(req, res, authManager);
        if (!authState) return;

        const rawBody = await parseRequestBody(req);
        const parsed = JSON.parse(rawBody || "{}");
        const content = typeof parsed?.content === "string" ? parsed.content : "";
        writeTextAtomic(ENV_PATH, content.endsWith("\n") ? content : `${content}\n`);
        sendJson(res, 200, createStatePayload(serverInfo, authState));
        return;
      }

      if (req.method === "GET") {
        serveStatic(url.pathname, res);
        return;
      }

      sendJson(res, 405, { error: "Method not allowed." });
    } catch (error) {
      sendJson(res, 500, {
        error: error.message || "Unexpected server error.",
      });
    }
  });

  server.listen(port, host, () => {
    const address = server.address();
    const resolvedPort = address && typeof address === "object" ? address.port : port;
    const authMode = authManager.required ? "password" : "local-open";
    console.log(`[Dashboard] XFeeder dashboard running at http://${host}:${resolvedPort} (${authMode})`);
  });

  return server;
}

module.exports = {
  startDashboard,
};
