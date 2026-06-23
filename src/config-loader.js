"use strict";

const fs = require("fs");
const path = require("path");

let envCache = {
  filePath: null,
  mtimeMs: null,
  values: {},
};

function stripWrappedQuotes(value) {
  if (!value) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseDotEnv(content = "") {
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const value = stripWrappedQuotes(match[2].trim());
    values[key] = value;
  }

  return values;
}

function loadDotEnv(filePath = path.join(process.cwd(), ".env"), { reload = false } = {}) {
  const resolvedPath = path.resolve(filePath);

  let stat = null;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    envCache = {
      filePath: resolvedPath,
      mtimeMs: null,
      values: {},
    };
    return {};
  }

  if (
    !reload &&
    envCache.filePath === resolvedPath &&
    envCache.mtimeMs === stat.mtimeMs
  ) {
    return { ...envCache.values };
  }

  let content = "";
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch {
    return {};
  }

  const values = parseDotEnv(content);
  envCache = {
    filePath: resolvedPath,
    mtimeMs: stat.mtimeMs,
    values,
  };

  return { ...values };
}

function resolveEnv(value, envMap = process.env) {
  if (typeof value === "string") {
    const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (match) {
      return envMap[match[1]] ?? "";
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveEnv(entry, envMap));
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveEnv(v, envMap);
    }
    return out;
  }

  return value;
}

function loadConfig(configPath = "./config.json") {
  const resolvedConfigPath = path.resolve(configPath);
  const envPath = path.join(path.dirname(resolvedConfigPath), ".env");
  const envFromFile = loadDotEnv(envPath, { reload: true });
  const envMap = {
    ...envFromFile,
    ...process.env,
  };
  const raw = fs.readFileSync(resolvedConfigPath, "utf8");
  return resolveEnv(JSON.parse(raw), envMap);
}

module.exports = {
  loadConfig,
  loadDotEnv,
};
