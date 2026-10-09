"use strict";

const SENSITIVE_KEY = /(token|secret|password|cookie|authorization|credential|api[_-]?key|webhook)/i;
const SENSITIVE_QUERY_KEY = /(token|secret|password|auth|key|signature|sig|credential|cookie)/i;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

let expertDebugEnabled = false;

function sanitizeUrl(input) {
  const value = String(input ?? "");
  const trailing = value.match(/[),.;]+$/)?.[0] || "";
  const candidate = trailing ? value.slice(0, -trailing.length) : value;

  try {
    const parsed = new URL(candidate);
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    parsed.pathname = parsed.pathname
      .replace(/\/bot[^/]+(?=\/)/i, "/bot[REDACTED]")
      .replace(/(\/webhooks\/\d+\/)[^/]+/i, "$1[REDACTED]");
    return `${parsed.toString()}${trailing}`;
  } catch {
    return value
      .replace(/(bot\d+:)[A-Za-z0-9_-]{20,}/gi, "$1[REDACTED]")
      .replace(/(\/webhooks\/\d+\/)[^/?\s]+/gi, "$1[REDACTED]");
  }
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(URL_PATTERN, (url) => sanitizeUrl(url))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(bot\d+:)[A-Za-z0-9_-]{20,}/gi, "$1[REDACTED]")
    .replace(/\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/g, "[REDACTED TELEGRAM TOKEN]")
    .replace(/((?:token|secret|password|cookie|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function sanitize(value, key = "", seen = new WeakSet(), depth = 0) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return /url|uri|href/i.test(key) ? sanitizeUrl(value) : sanitizeText(value);
  }
  if (typeof value !== "object") return String(value);
  if (Buffer.isBuffer(value)) return `[Buffer: ${value.length} bytes]`;
  if (depth >= 6) return "[Max depth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    const details = {
      name: value.name,
      message: sanitizeText(value.message),
    };
    if (value.code !== undefined) details.code = sanitize(value.code, "code", seen, depth + 1);
    if (value.response?.status !== undefined) details.status = value.response.status;
    return details;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitize(entry, "", seen, depth + 1));
  }

  const output = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
    output[childKey] = sanitize(childValue, childKey, seen, depth + 1);
  }
  return output;
}

function setExpertDebug(enabled) {
  expertDebugEnabled = enabled === true;
}

function isExpertDebugEnabled() {
  return expertDebugEnabled;
}

function expert(event, details = {}) {
  if (!expertDebugEnabled) return;
  const payload = sanitize(details);
  console.log(`[Expert] ${JSON.stringify({ time: new Date().toISOString(), event, ...payload })}`);
}

module.exports = {
  expert,
  isExpertDebugEnabled,
  sanitize,
  sanitizeText,
  sanitizeUrl,
  setExpertDebug,
};
