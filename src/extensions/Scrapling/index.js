"use strict";

const { ScraplingDetector } = require("./detector");
const { ScraplingConfig } = require("./config");
const cli = require("./cli");
const shell = require("./shell");
const browserWorker = require("./browser-worker");
const utils = require("./utils");
const { resolveResourcePolicy } = require("./resource-policy");
const { getNetwork } = require("../../network/service");
const { context } = require("../../network/context");

async function closeBrowserSessions() {
  getNetwork().scrapling.cancelWaiting();
  await browserWorker.close();
}

const EXTRACT_MODES = new Set(["get", "post", "put", "delete", "fetch", "stealthy-fetch"]);
const HTTP_EXTRACT_MODES = new Set(["get", "post", "put", "delete"]);
const BROWSER_EXTRACT_MODES = new Set(["fetch", "stealthy-fetch"]);
const RUNTIME_MODES = new Set(["cli", "shell"]);

const SHELL_ONLY_SHARED_KEYS = new Set([
  "selectorConfig",
  "selector_config",
  "retries",
  "retryDelay",
  "retry_delay",
  "proxyRotator",
  "proxy_rotator",
]);

const SHELL_ONLY_HTTP_KEYS = new Set([
  "useragent",
  "userAgent",
  "proxyAuth",
  "proxy_auth",
  "proxies",
  "http3",
  "maxRedirects",
  "max_redirects",
  "cert",
  "auth",
]);

const SHELL_ONLY_BROWSER_KEYS = new Set([
  "cookies",
  "useragent",
  "userAgent",
  "loadDom",
  "load_dom",
  "waitSelectorState",
  "wait_selector_state",
  "googleSearch",
  "google_search",
  "timezoneId",
  "timezone_id",
  "cdpUrl",
  "cdp_url",
  "userDataDir",
  "user_data_dir",
  "extraFlags",
  "extra_flags",
  "additionalArgs",
  "additional_args",
  "captureXhr",
  "capture_xhr",
  "executablePath",
  "executable_path",
  "blockedDomains",
  "blocked_domains",
  "initScript",
  "init_script",
  "maxPages",
  "max_pages",
  "pageAction",
  "page_action",
  "pageSetup",
  "page_setup",
]);

function normalizeExtractMode(value, fallback = "get") {
  const mode = String(value || fallback).trim().toLowerCase().replace(/_/g, "-");
  if (mode === "stealthy") return "stealthy-fetch";
  return EXTRACT_MODES.has(mode) ? mode : fallback;
}

function resolveRuntimeAndMode(config, merged) {
  const preferred = String(config?.preferredMode || "cli").trim().toLowerCase().replace(/_/g, "-");
  let runtimeMode = "cli";
  let extractMode = "get";

  if (RUNTIME_MODES.has(preferred)) {
    runtimeMode = preferred;
  } else if (EXTRACT_MODES.has(preferred)) {
    extractMode = preferred;
  }

  const explicitRuntime = String(merged.runtimeMode || merged.transport || "").trim().toLowerCase().replace(/_/g, "-");
  if (RUNTIME_MODES.has(explicitRuntime)) {
    runtimeMode = explicitRuntime;
  }

  const rawMode = String(merged.mode || "").trim().toLowerCase().replace(/_/g, "-");
  if (RUNTIME_MODES.has(rawMode)) {
    runtimeMode = rawMode;
  }
  if (EXTRACT_MODES.has(rawMode)) {
    extractMode = rawMode;
  }

  const explicitExtract = String(merged.extractMode || merged.fetchMode || "").trim().toLowerCase().replace(/_/g, "-");
  if (EXTRACT_MODES.has(explicitExtract)) {
    extractMode = explicitExtract;
  }

  extractMode = normalizeExtractMode(extractMode, "get");

  return { runtimeMode, extractMode };
}

function requiresShellRuntime(merged = {}, extractMode = "get") {
  if (merged.includeResponseMetadata === true) return true;

  const hasValue = (value) => {
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  };

  const mode = normalizeExtractMode(extractMode, "get");
  const shellKeys = new Set(SHELL_ONLY_SHARED_KEYS);
  const modeSpecific = HTTP_EXTRACT_MODES.has(mode)
    ? SHELL_ONLY_HTTP_KEYS
    : (BROWSER_EXTRACT_MODES.has(mode) ? SHELL_ONLY_BROWSER_KEYS : SHELL_ONLY_HTTP_KEYS);

  for (const key of modeSpecific) shellKeys.add(key);
  return [...shellKeys].some((key) => hasValue(merged[key]));
}

function hasValue(value) {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function validateOptionsForMode(merged = {}, extractMode = "get") {
  const mode = normalizeExtractMode(extractMode, "get");
  const hasProxyRotator = hasValue(merged.proxyRotator) || hasValue(merged.proxy_rotator);
  if (!hasProxyRotator) return;

  const hasProxy = hasValue(merged.proxy);
  const hasProxies = hasValue(merged.proxies);
  if (!hasProxy && !hasProxies) return;

  if (HTTP_EXTRACT_MODES.has(mode)) {
    throw new Error("Scrapling options conflict for HTTP mode: `proxyRotator` cannot be combined with `proxy` or `proxies`.");
  }
  if (BROWSER_EXTRACT_MODES.has(mode)) {
    throw new Error("Scrapling options conflict for browser mode: `proxyRotator` cannot be combined with `proxy`.");
  }
}

class Scrapling {
  constructor(rootConfig = {}) {
    this.detector = new ScraplingDetector(__dirname);
    this.config = new ScraplingConfig(rootConfig);
    this.utils = utils;
  }

  get available() {
    return this.detector.available;
  }

  get enabled() {
    return this.available && this.config.enabled;
  }

  capabilities() {
    return {
      available: this.available,
      enabled: this.enabled,
      version: this.detector.version,
      hasShell: this.detector.hasShell,
      hasExtract: this.detector.hasExtract,
      hasMcp: this.detector.hasMcp,
      hasSessions: this.detector.hasSessions,
      pythonCmd: this.detector.pythonCmd,
      scraplingCmd: this.detector.scraplingCmd,
      extractModes: Array.from(EXTRACT_MODES),
      runtimeModes: Array.from(RUNTIME_MODES),
    };
  }

  async fetch(url, options = {}) {
    if (!this.enabled) throw new Error("Scrapling not enabled or not available");

    let merged = {
      ...this.config.defaultOptions,
      ...this.config.getUrlConfig(url),
      ...options,
      url,
    };

    let { runtimeMode, extractMode } = resolveRuntimeAndMode(this.config, merged);
    if (BROWSER_EXTRACT_MODES.has(extractMode)) {
      merged = { ...resolveResourcePolicy(this.config.network,
        this.config.defaultOptions, this.config.getUrlConfig(url), options), url };
    }
    const config = this.config;
    const network = getNetwork({ network: config.network });
    return network.run("scrapling", merged.signal || context().signal, (signal) =>
      this.fetchResolved(url, { ...merged, signal }, runtimeMode, extractMode, config));
  }

  async fetchResolved(url, merged, runtimeMode, extractMode, config) {
    const requestedRuntime = runtimeMode;
    validateOptionsForMode(merged, extractMode);

    const needsMetadataShell = merged.includeResponseMetadata === true;
    const needsAdvancedShell = config.autoUseShellForAdvancedOptions &&
      requiresShellRuntime(merged, extractMode);
    if (runtimeMode !== "shell" && this.detector.hasShell && (needsMetadataShell || needsAdvancedShell)) {
      runtimeMode = "shell";
    }

    const withRuntimeMeta = (response, runtime) => {
      const resolvedRuntime = runtime || response?.runtime || runtimeMode;
      return {
        ...(response || {}),
        runtime: resolvedRuntime,
        resolvedRuntime,
        requestedRuntime,
        runtimeAutoSwitched: requestedRuntime !== resolvedRuntime,
      };
    };

    const hasRawCliArguments = [merged.rawCliArgs, merged.cliArgs, merged.extraCliArgs]
      .some((value) => hasValue(value));

    if (
      BROWSER_EXTRACT_MODES.has(extractMode) &&
      config.persistentBrowserSessions &&
      this.detector.hasSessions &&
      !hasRawCliArguments
    ) {
      const response = await browserWorker.fetch(
        this.detector.pythonCmd,
        url,
        extractMode,
        merged
      );
      if (merged.cssSelector) {
        response.html = shell.applyCssSelector(response.html, merged.cssSelector);
      }
      return withRuntimeMeta(response, "session");
    }

    // Preferred path: CLI extract mode supports all Scrapling options directly.
    if (runtimeMode !== "shell" && this.detector.hasExtract) {
      const response = await cli.extract(this.detector.scraplingCmd, { ...merged, mode: extractMode });
      return withRuntimeMeta(response, "cli");
    }

    if (this.detector.hasShell) {
      const response = await shell.fetch(this.detector.pythonCmd, { ...merged, mode: extractMode });
      return withRuntimeMeta(response, "shell");
    }

    if (this.detector.hasExtract) {
      const response = await cli.extract(this.detector.scraplingCmd, { ...merged, mode: extractMode });
      return withRuntimeMeta(response, "cli");
    }

    throw new Error("No Scrapling runtime available");
  }

  async installDependencies(opts = {}) {
    if (!this.detector.scraplingCmd) throw new Error("Scrapling CLI not found");
    return cli.install(this.detector.scraplingCmd, opts);
  }

  startMcpServer(opts = {}) {
    if (!this.detector.hasMcp) throw new Error("Scrapling MCP not available");
    return cli.startMcp(this.detector.scraplingCmd, opts);
  }

  async runShell(opts = {}) {
    if (!this.detector.hasShell) throw new Error("Scrapling shell not available");
    return cli.runShell(this.detector.scraplingCmd, opts);
  }

  async closeBrowserSessions() {
    await closeBrowserSessions();
  }

  parseHtmlToFeed(html, options = {}) {
    return utils.htmlToFeedItems(html, options);
  }
}

let singleton = null;

function getScrapling(rootConfig = {}) {
  if (!singleton) {
    singleton = new Scrapling(rootConfig);
  } else if (rootConfig && typeof rootConfig === "object") {
    singleton.config = new ScraplingConfig(rootConfig);
  }
  return singleton;
}

module.exports = {
  Scrapling,
  getScrapling,
  closeBrowserSessions,
  requiresShellRuntime,
  ...utils,
};
