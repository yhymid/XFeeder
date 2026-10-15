"use strict";

// Lightweight structured logging boundary. Keep the existing console transport
// for compatibility; sanitize values before they ever reach terminal capture.
const { sanitize, sanitizeText, isExpertDebugEnabled } = require("./diagnostics");

const CONSOLE_METHOD = Object.freeze({
  info: "log",
  warn: "warn",
  error: "error",
  debug: "log",
});

function formatRecord(scope, level, message, details) {
  const safeScope = sanitizeText(scope).replace(/[\r\n]/g, " ");
  const safeMessage = sanitizeText(message instanceof Error ? message.message : message)
    .replace(/[\r\n]/g, " ");
  const metadata = details === undefined ? "" : ` ${JSON.stringify(sanitize(details))}`;
  return `[${safeScope}][${level}] ${safeMessage}${metadata}`;
}

function createLogger(scope) {
  const name = String(scope || "XFeeder");
  const write = (level, message, details) => {
    if (level === "debug" && !isExpertDebugEnabled()) return;
    console[CONSOLE_METHOD[level]](formatRecord(name, level, message, details));
  };
  return Object.freeze({
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
    debug: (message, details) => write("debug", message, details),
  });
}

module.exports = { createLogger, formatRecord };
