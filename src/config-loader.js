"use strict";

const fs = require("fs");
const path = require("path");

let envLoaded = false;

function stripWrappedQuotes(value) {
  if (!value) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function loadDotEnv(filePath = path.join(process.cwd(), ".env")) {
  if (envLoaded) return;
  envLoaded = true;

  if (!fs.existsSync(filePath)) return;

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const value = stripWrappedQuotes(match[2].trim());
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveEnv(value) {
  if (typeof value === "string") {
    const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (match) {
      return process.env[match[1]] ?? "";
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(resolveEnv);
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveEnv(v);
    }
    return out;
  }

  return value;
}

function loadConfig(configPath = "./config.json") {
  loadDotEnv();
  const raw = fs.readFileSync(configPath, "utf8");
  return resolveEnv(JSON.parse(raw));
}

module.exports = {
  loadConfig,
  loadDotEnv,
};
