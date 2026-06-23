"use strict";

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HTTP_EXTRACT_MODES = new Set(["get", "post", "put", "delete"]);
const BROWSER_EXTRACT_MODES = new Set(["fetch", "stealthy-fetch"]);

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(String(stdout || ""));
      }
    );
  });
}

function normalizeMode(value) {
  const mode = String(value || "get").trim().toLowerCase().replace(/_/g, "-");
  if (mode === "stealthy") return "stealthy-fetch";
  if (mode === "dynamic") return "fetch";
  if (HTTP_EXTRACT_MODES.has(mode) || BROWSER_EXTRACT_MODES.has(mode)) return mode;
  return "get";
}

function ensureArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function toHeaderList(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof input === "object") {
    return Object.entries(input)
      .filter(([k, v]) => k && v !== undefined && v !== null)
      .map(([k, v]) => `${String(k).trim()}: ${String(v).trim()}`)
      .filter(Boolean);
  }
  const s = String(input).trim();
  return s ? [s] : [];
}

function toParamList(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof input === "object") {
    return Object.entries(input)
      .filter(([k, v]) => k && v !== undefined && v !== null)
      .map(([k, v]) => `${String(k).trim()}=${String(v).trim()}`)
      .filter(Boolean);
  }
  const s = String(input).trim();
  return s ? [s] : [];
}

function toCookiesString(input) {
  if (!input) return "";
  if (typeof input === "string") return input.trim();
  if (typeof input === "object") {
    return Object.entries(input)
      .filter(([k, v]) => k && v !== undefined && v !== null)
      .map(([k, v]) => `${String(k).trim()}=${String(v).trim()}`)
      .join("; ");
  }
  return String(input).trim();
}

function toJsonString(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toDataString(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      p.set(String(k), String(v));
    }
    return p.toString();
  }
  return String(value);
}

function pushIf(args, key, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(key, String(value));
}

function pushRepeated(args, key, values) {
  for (const value of ensureArray(values)) {
    if (value === undefined || value === null || value === "") continue;
    args.push(key, String(value));
  }
}

function pushFlag(args, enabledFlag, disabledFlag, value, defaultValue) {
  if (value === undefined || value === null) return;
  if (value === defaultValue) return;
  args.push(value ? enabledFlag : disabledFlag);
}

function applyHttpOptions(args, options) {
  const headers = toHeaderList(options.headers);
  const params = toParamList(options.params);
  const cookies = toCookiesString(options.cookies);

  pushRepeated(args, "--headers", headers);
  pushIf(args, "--cookies", cookies);
  pushIf(args, "--timeout", options.timeoutSeconds ?? options.timeout ?? 30);
  pushIf(args, "--proxy", options.proxy);
  pushIf(args, "--css-selector", options.cssSelector);
  pushRepeated(args, "--params", params);

  pushFlag(args, "--follow-redirects", "--no-follow-redirects", options.followRedirects, true);
  pushFlag(args, "--verify", "--no-verify", options.verify, true);
  pushIf(args, "--impersonate", options.impersonate);
  pushFlag(args, "--stealthy-headers", "--no-stealthy-headers", options.stealthyHeaders, true);

  if (options.aiTargeted === true) args.push("--ai-targeted");
}

function applyBrowserOptions(args, options, { stealthy = false } = {}) {
  pushFlag(args, "--block-ads", "--no-block-ads", options.blockAds, false);
  pushFlag(args, "--dns-over-https", "--no-dns-over-https", options.dnsOverHttps, false);
  pushFlag(args, "--headless", "--no-headless", options.headless, true);
  pushFlag(args, "--disable-resources", "--enable-resources", options.disableResources, false);
  pushFlag(args, "--network-idle", "--no-network-idle", options.networkIdle, false);

  pushIf(args, "--timeout", options.timeoutMs ?? options.timeout ?? 30000);
  pushIf(args, "--wait", options.wait);
  pushIf(args, "--css-selector", options.cssSelector);
  pushIf(args, "--wait-selector", options.waitSelector);
  pushIf(args, "--locale", options.locale);

  pushFlag(args, "--real-chrome", "--no-real-chrome", options.realChrome, false);
  pushIf(args, "--proxy", options.proxy);

  const extraHeaders = toHeaderList(options.extraHeaders || options.headers);
  pushRepeated(args, "--extra-headers", extraHeaders);

  if (options.aiTargeted === true) args.push("--ai-targeted");

  if (stealthy) {
    pushFlag(args, "--block-webrtc", "--allow-webrtc", options.blockWebrtc, false);
    pushFlag(args, "--solve-cloudflare", "--no-solve-cloudflare", options.solveCloudflare ?? options.solveCaptcha, false);
    pushFlag(args, "--allow-webgl", "--block-webgl", options.allowWebgl, true);
    pushFlag(args, "--hide-canvas", "--show-canvas", options.hideCanvas, false);
  }
}

async function extract(scraplingCmd, {
  mode = "get",
  url,
  output = "-",
  timeout = 60,
  ...options
} = {}) {
  if (!url) throw new Error("Scrapling extract requires URL");

  const normalizedMode = normalizeMode(mode);
  const shouldUseTmpOutput = !output || output === "-";
  const ext =
    normalizedMode === "get" ||
    normalizedMode === "post" ||
    normalizedMode === "put" ||
    normalizedMode === "delete"
      ? ".html"
      : ".html";
  const outputPath = shouldUseTmpOutput
    ? path.join(os.tmpdir(), `xfeeder-scrapling-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
    : String(output);

  const args = ["extract", normalizedMode, url, outputPath];

  if (HTTP_EXTRACT_MODES.has(normalizedMode)) {
    applyHttpOptions(args, options);
    if (normalizedMode === "post" || normalizedMode === "put") {
      const data = toDataString(options.data);
      const jsonData = toJsonString(options.jsonData ?? options.json);
      pushIf(args, "--data", data);
      pushIf(args, "--json", jsonData);
    }
  } else if (BROWSER_EXTRACT_MODES.has(normalizedMode)) {
    applyBrowserOptions(args, options, { stealthy: normalizedMode === "stealthy-fetch" });
  }

  const passthroughArgs = ensureArray(options.rawCliArgs || options.cliArgs || options.extraCliArgs)
    .map(String)
    .map((v) => v.trim())
    .filter(Boolean);
  if (passthroughArgs.length) {
    args.push(...passthroughArgs);
  }

  await run(scraplingCmd, args, Math.max(5000, Number(timeout) * 1000));

  let content = "";
  try {
    content = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  } finally {
    if (shouldUseTmpOutput) {
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch {}
    }
  }

  return {
    html: content,
    status: 200,
    headers: {},
    fetchMode: normalizedMode,
    runtime: "cli",
    elapsed: null,
    args,
    outputPath,
  };
}

async function install(scraplingCmd, { force = false, timeout = 1800 } = {}) {
  const args = ["install"];
  if (force) args.push("--force");
  return run(scraplingCmd, args, Math.max(10000, Number(timeout) * 1000));
}

function startMcp(scraplingCmd, { http = false, host = "0.0.0.0", port = 8000, extraArgs = [] } = {}) {
  const args = ["mcp"];
  if (http) args.push("--http", "--host", String(host), "--port", String(port));
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs.map(String));
  return spawn(scraplingCmd, args, { stdio: "pipe" });
}

async function runShell(scraplingCmd, { code = "", loglevel = "debug", timeout = 120 } = {}) {
  const args = ["shell"];
  if (code) args.push("--code", String(code));
  if (loglevel) args.push("--loglevel", String(loglevel));
  return run(scraplingCmd, args, Math.max(5000, Number(timeout) * 1000));
}

module.exports = {
  extract,
  install,
  startMcp,
  runShell,
  normalizeMode,
};
