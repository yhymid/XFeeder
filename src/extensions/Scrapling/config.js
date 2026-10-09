"use strict";

const EXTRACT_MODES = new Set(["get", "post", "put", "delete", "fetch", "stealthy-fetch"]);

function ensureArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (mode === "stealthy") return "stealthy-fetch";
  return EXTRACT_MODES.has(mode) ? mode : null;
}

function sanitizeModeOrder(value, fallback = ["get", "fetch", "stealthy-fetch"]) {
  const out = [];
  for (const raw of ensureArray(value)) {
    const mode = normalizeMode(raw);
    if (!mode) continue;
    if (!out.includes(mode)) out.push(mode);
  }
  if (!out.length) return [...fallback];
  return out;
}

class ScraplingConfig {
  constructor(rootConfig = {}) {
    this.raw = rootConfig?.Scrapling || {};
    this.network = rootConfig?.network || {};
  }
  get enabled() { return this.raw.Enabled !== false; }
  get autoFallback() { return this.raw.AutoFallback !== false; }
  get autoUseShellForAdvancedOptions() { return this.raw.AutoUseShellForAdvancedOptions !== false; }
  get persistentBrowserSessions() { return this.raw.PersistentBrowserSessions !== false; }
  get preferredMode() { return this.raw.PreferredMode || "cli"; }
  get fallbackStatusCodes() { return Array.isArray(this.raw.FallbackStatusCodes) ? this.raw.FallbackStatusCodes : [403, 429, 503]; }
  get defaultOptions() { return (this.raw.DefaultOptions && typeof this.raw.DefaultOptions === "object") ? this.raw.DefaultOptions : {}; }
  get antiBotGlobalConfig() {
    const base = (this.raw.AntiBot && typeof this.raw.AntiBot === "object") ? this.raw.AntiBot : {};
    const modeOrder = sanitizeModeOrder(base.ModeOrder, ["get", "fetch", "stealthy-fetch"]);
    const statusCodes = ensureArray(base.StatusCodes).map((n) => Number(n)).filter((n) => Number.isFinite(n));
    const headerKeys = ensureArray(base.HeaderKeys).map((v) => String(v || "").trim()).filter(Boolean);
    const bodySignatures = ensureArray(base.BodySignatures).map((v) => String(v || "").trim()).filter(Boolean);
    const titleSignatures = ensureArray(base.TitleSignatures).map((v) => String(v || "").trim()).filter(Boolean);
    const maxAttempts = Number(base.MaxAttempts);
    const minBodyBytes = Number(base.MinBodyBytes);
    const minConfidence = Number(base.MinConfidence);
    return {
      enabled: base.Enabled !== false,
      logDecisions: base.LogDecisions === true,
      preferStealthOnSignals: base.PreferStealthOnSignals !== false,
      modeOrder,
      statusCodes: statusCodes.length ? statusCodes : [403, 429, 503],
      headerKeys,
      bodySignatures,
      titleSignatures,
      maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 3,
      minBodyBytes: Number.isFinite(minBodyBytes) && minBodyBytes > 0 ? Math.floor(minBodyBytes) : 0,
      minConfidence: Number.isFinite(minConfidence)
        ? Math.max(0, Math.min(100, Math.floor(minConfidence)))
        : 40,
      treatCloudflareAsSignal: base.TreatCloudflareAsSignal !== false,
    };
  }
  getUrlConfig(url) {
    const map = this.raw.PerUrlConfig || {};
    return map[url] && typeof map[url] === "object" ? map[url] : {};
  }
  getAntiBotConfig(url, overrides = {}) {
    const per = this.getUrlConfig(url);
    const perAnti = (per.antiBot && typeof per.antiBot === "object") ? per.antiBot : {};
    const own = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);
    const pick = (camel, pascal, fallback) => {
      if (own(overrides, camel)) return overrides[camel];
      if (own(overrides, pascal)) return overrides[pascal];
      if (own(perAnti, camel)) return perAnti[camel];
      if (own(perAnti, pascal)) return perAnti[pascal];
      return fallback;
    };

    const merged = {
      ...this.antiBotGlobalConfig,
      ...perAnti,
      ...(overrides && typeof overrides === "object" ? overrides : {}),
    };

    const rawModeOrder = pick("modeOrder", "ModeOrder", merged.modeOrder);
    merged.modeOrder = sanitizeModeOrder(
      rawModeOrder,
      this.antiBotGlobalConfig.modeOrder
    );

    const statusCodes = ensureArray(pick("statusCodes", "StatusCodes", merged.statusCodes))
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n));
    merged.statusCodes = statusCodes.length ? statusCodes : this.antiBotGlobalConfig.statusCodes;

    merged.headerKeys = ensureArray(pick("headerKeys", "HeaderKeys", merged.headerKeys))
      .map((v) => String(v || "").trim())
      .filter(Boolean);
    merged.bodySignatures = ensureArray(pick("bodySignatures", "BodySignatures", merged.bodySignatures))
      .map((v) => String(v || "").trim())
      .filter(Boolean);
    merged.titleSignatures = ensureArray(pick("titleSignatures", "TitleSignatures", merged.titleSignatures))
      .map((v) => String(v || "").trim())
      .filter(Boolean);

    const maxAttempts = Number(pick("maxAttempts", "MaxAttempts", merged.maxAttempts));
    merged.maxAttempts = Number.isFinite(maxAttempts) && maxAttempts > 0
      ? Math.floor(maxAttempts)
      : this.antiBotGlobalConfig.maxAttempts;

    const minBodyBytes = Number(pick("minBodyBytes", "MinBodyBytes", merged.minBodyBytes));
    merged.minBodyBytes = Number.isFinite(minBodyBytes) && minBodyBytes > 0
      ? Math.floor(minBodyBytes)
      : this.antiBotGlobalConfig.minBodyBytes;

    const minConfidence = Number(pick("minConfidence", "MinConfidence", merged.minConfidence));
    merged.minConfidence = Number.isFinite(minConfidence)
      ? Math.max(0, Math.min(100, Math.floor(minConfidence)))
      : this.antiBotGlobalConfig.minConfidence;

    const treatCloudflareAsSignal = pick(
      "treatCloudflareAsSignal",
      "TreatCloudflareAsSignal",
      merged.treatCloudflareAsSignal
    );
    merged.treatCloudflareAsSignal = treatCloudflareAsSignal !== false;

    merged.enabled = pick("enabled", "Enabled", merged.enabled) !== false;
    merged.logDecisions = pick("logDecisions", "LogDecisions", merged.logDecisions) === true;
    merged.preferStealthOnSignals = pick(
      "preferStealthOnSignals",
      "PreferStealthOnSignals",
      merged.preferStealthOnSignals
    ) !== false;
    return merged;
  }

  buildModeSequence(url, options = {}) {
    const anti = this.getAntiBotConfig(url, options?.antiBot || {});
    const explicit = normalizeMode(options.extractMode || options.fetchMode || options.mode);
    const defaultMode = normalizeMode(this.defaultOptions.extractMode || this.defaultOptions.mode);
    const perMode = normalizeMode(this.getUrlConfig(url)?.extractMode || this.getUrlConfig(url)?.mode);
    const resolved = [];
    if (explicit) resolved.push(explicit);
    if (perMode && !resolved.includes(perMode)) resolved.push(perMode);
    for (const mode of anti.modeOrder) {
      if (!resolved.includes(mode)) resolved.push(mode);
    }
    if (defaultMode && !resolved.includes(defaultMode)) resolved.push(defaultMode);
    if (!resolved.length) resolved.push("get");
    return resolved;
  }

  shouldUseScrapling(url, statusCode = null) {
    if (!this.enabled) return false;
    const per = this.getUrlConfig(url);
    if (per.enabled === false) return false;
    if (this.raw.ForceGlobal) return true;
    if (per.enabled === true) return true;
    if (!this.autoFallback) return false;
    if (statusCode != null && this.fallbackStatusCodes.includes(Number(statusCode))) return true;
    return false;
  }
}

module.exports = { ScraplingConfig };
