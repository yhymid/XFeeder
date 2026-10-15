"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const {
  collectChannelGroupEntries,
  collectConfiguredChannels,
} = require("../core/channel-config");

const { readActivity } = require("./activity");
const { readActivityRuntime } = require("../core/activity-runtime");
const { publicMetrics, readStructuredActivity } = require("./observability");
const { validateConfig } = require("./validation");
const { loadDotEnv } = require("../config-loader");
const { sanitizeText } = require("../core/diagnostics");
const { normalizeNetworkConfig } = require("../network/config");
const { readNetworkSettings, revision } = require("./network");
const { workerReady } = require("./health");

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
  ".mjs": "application/javascript; charset=utf-8",
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

function writeTextAtomic(filePath, content, mode) {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    // Exclusive creation prevents following an attacker-planted temp symlink.
    // Private permissions are applied at creation, before any secret is written.
    fs.writeFileSync(tempPath, content, {
      encoding: "utf8", flag: "wx", ...(mode === undefined ? {} : { mode }),
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
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

function sendText(
  res,
  statusCode,
  body,
  contentType = "text/plain; charset=utf-8",
  extraHeaders = {},
) {
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
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      /* Ignore malformed cookies. */
    }
  }
  return cookies;
}

function isLoopbackHost(host = "") {
  const normalized = String(host || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

function compareSecrets(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildCookie(
  name,
  value,
  { maxAgeSeconds = null, secure = false } = {},
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];

  if (secure) parts.push("Secure");

  if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }

  return parts.join("; ");
}

function buildExpiredCookie(name, secure = false) {
  return buildCookie(name, "", { maxAgeSeconds: 0, secure });
}

function createAuthManager({ host, secure = false, publicOrigin = "" }) {
  const password = String(process.env.XFEEDER_DASHBOARD_PASSWORD || "").trim();
  const loopbackOnly = isLoopbackHost(host);
  // Binding to loopback does not make a public reverse proxy private.
  // A non-loopback public origin can expose the backend through that proxy.
  const publicHost = publicOrigin ? new URL(publicOrigin).hostname.replace(/^\[|\]$/g, "") : "";
  const publiclyExposed = Boolean(publicHost && !isLoopbackHost(publicHost));
  const sessionHours = Number(process.env.XFEEDER_DASHBOARD_SESSION_TTL_HOURS);
  const ttlMs =
    Number.isFinite(sessionHours) && sessionHours > 0
      ? Math.floor(sessionHours * 60 * 60 * 1000)
      : 12 * 60 * 60 * 1000;
  const sessions = new Map();
  let loginWindow = 0, loginAttempts = 0;
  function reserveLogin() {
    const now = Date.now();
    if (now >= loginWindow + 60000) { loginWindow = now; loginAttempts = 0; }
    if (!password) return 0;
    if (loginAttempts >= 10) return Math.max(1, Math.ceil((loginWindow + 60000 - now) / 1000));
    loginAttempts++;
    return 0;
  }

  if (!loopbackOnly && !password) {
    throw new Error(
      "Dashboard is binding to a non-loopback host. Set XFEEDER_DASHBOARD_PASSWORD before exposing it outside localhost.",
    );
  }
  if (publiclyExposed && !password) {
    throw new Error(
      "Dashboard public origin is non-loopback. Set XFEEDER_DASHBOARD_PASSWORD before exposing it through a reverse proxy.",
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

    purgeExpiredSessions();
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      expiresAt: Date.now() + ttlMs,
    });

    return {
      ok: true,
      cookie: buildCookie(SESSION_COOKIE_NAME, sessionId, {
        maxAgeSeconds: Math.floor(ttlMs / 1000),
        secure,
      }),
    };
  }

  function logout(req) {
    const sessionId = getSessionId(req);
    if (sessionId) {
      sessions.delete(sessionId);
    }
    return buildExpiredCookie(SESSION_COOKIE_NAME, secure);
  }

  return {
    reserveLogin,
    required: Boolean(password),
    loopbackOnly,
    getAuthState,
    login,
    logout,
  };
}

function createStatePayload(serverInfo = {}, authState = {}, paths = {}) {
  const {
    configPath = CONFIG_PATH,
    cachePath = CACHE_PATH,
    envPath = ENV_PATH,
  } = paths;
  const config = readJson(configPath, {});
  const cache = readJson(cachePath, {});
  const envValues = loadDotEnv(envPath, { reload: true });
  const channels = collectConfiguredChannels(config);
  const { warnings, errors } = validateConfig(config, envPath);
  const channelGroupEntries = collectChannelGroupEntries(config || {});
  const totalFeeds = channels.reduce((sum, channel) => {
    return sum + (Array.isArray(channel.RSS) ? channel.RSS.length : 0);
  }, 0);

  return {
    config,
    revision: revision(readText(configPath, "")),
    warnings,
    errors,
    envStatus: Object.fromEntries([...new Set([
      ...Object.keys(envValues), ...collectEnvRefs(config),
    ])].map(name => [name, (process.env[name] ?? envValues[name]) ? "configured" : "missing"])),
    envExample: readText(ENV_EXAMPLE_PATH, ""),
    cacheSummary: summarizeCache(cache),
    stats: {
      groups: channelGroupEntries.map(([key, value]) => ({
        key,
        mode: Array.isArray(value) ? "array" : "object",
        count: Array.isArray(value)
          ? value.length
          : value && typeof value === "object"
            ? Object.keys(value).length
            : 0,
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
      configPath,
      envPath,
      cachePath,
      appVersion,
      configReload:
        "worker picks up config and .env changes from disk on the next cycle",
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

  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
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
  if (origin && expectedHost.includes(origin)) return true;

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

function startDashboard({
  host = "127.0.0.1",
  port = 3000,
  dataDir = ROOT_DIR,
  publicOrigin = process.env.XFEEDER_DASHBOARD_PUBLIC_ORIGIN || "",
} = {}) {
  if (publicOrigin) {
    const parsedOrigin = new URL(publicOrigin);
    if (
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.origin !== publicOrigin
    ) {
      throw new Error(
        "XFEEDER_DASHBOARD_PUBLIC_ORIGIN must be an exact http(s) origin without a path or trailing slash.",
      );
    }
  }
  const paths = {
    configPath: path.join(dataDir, "config.json"),
    envPath: path.join(dataDir, ".env"),
    cachePath: path.join(dataDir, "cache.json"),
  };
  const authManager = createAuthManager({
    host,
    publicOrigin,
    secure: publicOrigin.startsWith("https://"),
  });

  const server = http.createServer(async (req, res) => {
    const requestHost = String(req.headers.host || "").toLowerCase();
    const url = new URL(req.url, "http://dashboard.local");
    const serverAddress = server.address();
    const serverInfo = {
      host,
      port:
        serverAddress && typeof serverAddress === "object"
          ? serverAddress.port
          : port,
    };
    // Build authority from server configuration, never an arbitrary Host header.
    const localHosts = isLoopbackHost(host)
      ? ["127.0.0.1", "localhost", "[::1]"] : [host.includes(":") ? `[${host}]` : host];
    const authorities = localHosts.map(value => `${value}:${serverInfo.port}`.toLowerCase());
    if (publicOrigin) authorities.push(new URL(publicOrigin).host.toLowerCase());
    const expectedOrigin = publicOrigin ? [publicOrigin] : authorities.map(value => `http://${value}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );

    try {
      if (!authorities.includes(requestHost)) {
        sendJson(res, 403, { error: "Untrusted Host." }); return;
      }
      if (req.headers.origin && !ensureSameOrigin(req, res, expectedOrigin)) return;
      // Dashboard liveness is independent of its worker and external services.
      if (req.method === "GET" && ["/api/live", "/api/health/live"].includes(url.pathname)) {
        sendJson(res, 200, { ok: true, service: "xfeeder-dashboard", status: "live" });
        return;
      }
      // Readiness depends on fresh, applied worker telemetry and safe state.
      // Only expose a boolean; no config, paths, credentials or worker PID.
      if (req.method === "GET" && ["/api/ready", "/api/health/ready"].includes(url.pathname)) {
        const ready = workerReady(paths.configPath);
        sendJson(res, ready ? 200 : 503, {
          ok: ready, service: "xfeeder-worker", status: ready ? "ready" : "not-ready",
        });
        return;
      }
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
        if (!ensureSameOrigin(req, res, expectedOrigin)) return;
        const retryAfter = authManager.reserveLogin();
        if (retryAfter) {
          sendJson(res, 429, { error: "Too many login attempts. Try again later." }, { "Retry-After": String(retryAfter) });
          return;
        }
        const rawBody = await parseRequestBody(req);
        const parsed = JSON.parse(rawBody || "{}");
        const loginResult = authManager.login(
          typeof parsed?.password === "string" ? parsed.password : "",
        );
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
          loginResult.cookie ? { "Set-Cookie": loginResult.cookie } : {},
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
        sendJson(res, 200, createStatePayload(serverInfo, authState, paths));
        return;
      }

      if (["/api/settings/network", "/api/network/metrics"].includes(url.pathname)) {
        if (!requireDashboardAccess(req, res, authManager)) return;
        if (req.method === "GET") {
          const { payload } = readNetworkSettings(paths.configPath);
          sendJson(res, 200, url.pathname === "/api/network/metrics" ? payload.runtime : payload,
            { ETag: `"${payload.revision}"` });
          return;
        }
        if (req.method === "PUT" && url.pathname === "/api/settings/network") {
          if (!ensureSameOrigin(req, res, expectedOrigin)) return;
          const settings = JSON.parse(await parseRequestBody(req));
          const validation = normalizeNetworkConfig(settings);
          if (!validation.ok) { sendJson(res, 400, { error: "Invalid network settings.", errors: validation.errors }); return; }
          const current = readNetworkSettings(paths.configPath);
          if (!req.headers["if-match"]) { sendJson(res, 428, { error: "Configuration revision required. Reload settings first." }); return; }
          if (req.headers["if-match"] !== `"${current.payload.revision}"`) {
            sendJson(res, 412, { error: "Configuration changed elsewhere. Refresh before saving." }); return;
          }
          current.config.network = settings;
          writeTextAtomic(paths.configPath, `${JSON.stringify(current.config, null, 2)}\n`);
          const { payload } = readNetworkSettings(paths.configPath);
          sendJson(res, 200, payload, { ETag: `"${payload.revision}"` });
          return;
        }
        sendJson(res, 405, { error: "Method not allowed." }); return;
      }

      if (req.method === "GET" && url.pathname === "/api/activity") {
        if (!requireDashboardAccess(req, res, authManager)) return;
        // Prefer first-class events; retain a read-only legacy fallback for
        // older workers which have not yet published structured activity.
        const structured = readStructuredActivity(paths.configPath, {
          limit: url.searchParams.get("limit"),
        });
        sendJson(res, 200, structured || await readActivity(
          path.join(dataDir, "debug/terminal.txt"),
          { limit: url.searchParams.get("limit") },
        ));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/metrics") {
        if (!requireDashboardAccess(req, res, authManager)) return;
        const runtime = readActivityRuntime(paths.configPath);
        // Structured activity may be retained for post-mortem review after
        // worker exit, but counters/rates must never masquerade as live data.
        const age = runtime ? Date.now() - Date.parse(runtime.updatedAt) : Infinity;
        if (!runtime || !Number.isFinite(age) || age < -1000 || age > 6500) {
          sendJson(res, 503, { available: false, error: "Worker metrics unavailable or stale" });
          return;
        }
        sendJson(res, 200, {
          available: true,
          updatedAt: runtime.updatedAt,
          metrics: publicMetrics(runtime.metrics),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/validate") {
        if (!ensureSameOrigin(req, res, expectedOrigin)) return;
        if (!requireDashboardAccess(req, res, authManager)) return;
        const config = JSON.parse(await parseRequestBody(req));
        sendJson(res, 200, validateConfig(config, paths.envPath));
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

        if (!req.headers["if-match"]) { sendJson(res, 428, { error: "Configuration revision required. Reload settings first." }); return; }
        if (req.headers["if-match"] !== `"${revision(readText(paths.configPath, ""))}"`) {
          sendJson(res, 412, { error: "Configuration changed elsewhere. Refresh before saving." }); return;
        }

        const validation = validateConfig(parsed, paths.envPath);
        if (validation.errors.length) {
          sendJson(res, 400, {
            error: "Configuration validation failed.",
            ...validation,
          });
          return;
        }
        if (
          validation.warnings.length &&
          req.headers["x-xfeeder-accept-warnings"] !== "true"
        ) {
          sendJson(res, 422, {
            error: "Review configuration warnings before saving.",
            ...validation,
          });
          return;
        }
        writeTextAtomic(
          paths.configPath,
          `${JSON.stringify(parsed, null, 2)}\n`,
        );
        sendJson(res, 200, createStatePayload(serverInfo, authState, paths));
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/env") {
        if (!ensureSameOrigin(req, res, expectedOrigin)) return;
        const authState = requireDashboardAccess(req, res, authManager);
        if (!authState) return;

        const rawBody = await parseRequestBody(req);
        const parsed = JSON.parse(rawBody || "{}");
        if (typeof parsed?.content !== "string") {
          sendJson(res, 400, {
            error: "Environment content must be a string.",
          });
          return;
        }
        const content = parsed.content;
        writeTextAtomic(
          paths.envPath,
          content.endsWith("\n") ? content : `${content}\n`,
          0o600,
        );
        sendJson(res, 200, createStatePayload(serverInfo, authState, paths));
        return;
      }

      if (req.method === "GET") {
        serveStatic(url.pathname, res);
        return;
      }

      sendJson(res, 405, { error: "Method not allowed." });
    } catch (error) {
      sendJson(res, error instanceof SyntaxError ? 400 : 500, {
        error:
          error instanceof SyntaxError
            ? "Invalid JSON."
            : sanitizeText(error.message || "Unexpected server error."),
      });
    }
  });

  server.listen(port, host, () => {
    const address = server.address();
    const resolvedPort =
      address && typeof address === "object" ? address.port : port;
    const authMode = authManager.required ? "password" : "local-open";
    console.log(
      `[Dashboard] XFeeder dashboard running at http://${host}:${resolvedPort} (${authMode})`,
    );
  });

  return server;
}

module.exports = {
  startDashboard,
};
