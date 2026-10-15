"use strict";

const { isCancelled } = require("../network/abort");
const { sanitizeText } = require("./diagnostics");

// Categories describe *where/what* failed; they are not a retry policy.
const ERROR_CATEGORIES = Object.freeze([
  "configuration", "validation", "network", "timeout", "cancellation",
  "source", "parser", "challenge", "scrapling", "delivery",
  "state", "persistence", "security", "unknown",
]);
const CATEGORY_SET = new Set(ERROR_CATEGORIES);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ERR_NETWORK", "UND_ERR_SOCKET", "ERR_BAD_RESPONSE"]);
const CONFIG_CODES = new Set(["INVALID_NETWORK_CONFIG", "INVALID_CONFIG", "CONFIG_INVALID"]);
const STATE_CODES = new Set(["CACHE_UNSAFE", "STATE_CORRUPT"]);
const PERSISTENCE_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS"]);

function validCategory(category) {
  return typeof category === "string" && CATEGORY_SET.has(category);
}

// Opt-in wrapper for module boundaries. Do not replace/erase underlying
// network errors: callers currently rely on Axios status and ERR_CANCELED.
class XFeederError extends Error {
  constructor(message, { category = "unknown", code = "XFEEDER_ERROR", cause, metadata } = {}) {
    if (!validCategory(category)) throw new TypeError("Unknown XFeeder error category");
    super(String(message), { cause });
    this.name = "XFeederError";
    this.category = category;
    this.code = code;
    if (metadata !== undefined) this.metadata = metadata;
  }
}

function classifyError(error, { context = "unknown" } = {}) {
  if (isCancelled(error)) return "cancellation";
  if (!error || typeof error !== "object") return "unknown";
  if (error instanceof XFeederError) return error.category;

  const code = typeof error.code === "string" ? error.code : "";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (CONFIG_CODES.has(code) || error.name === "NetworkConfigError") return "configuration";
  if (STATE_CODES.has(code)) return "state";
  if (PERSISTENCE_CODES.has(code)) return "persistence";
  if (NETWORK_CODES.has(code)) return "network";

  // An explicit boundary is stronger evidence than the wording of an error.
  // Do not guess "security" from a provider 403 or "parser" from a message.
  if (validCategory(context) && context !== "unknown") return context;
  if (Number.isInteger(error.response?.status) && error.response.status >= 400)
    return "network";
  return "unknown";
}

// Safe, bounded metadata for metrics/diagnostics. Never embed config, request,
// response bodies, headers, credentials or raw error objects in event data.
function errorRecord(error, options) {
  const status = error?.response?.status ?? error?.status;
  const code = typeof error?.code === "string" ? sanitizeText(error.code).slice(0, 80) : null;
  return {
    category: classifyError(error, options),
    code,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    message: sanitizeText(error instanceof Error ? error.message : String(error ?? "Unknown error")).slice(0, 500),
  };
}

module.exports = {
  ERROR_CATEGORIES,
  XFeederError,
  classifyError,
  errorRecord,
};
