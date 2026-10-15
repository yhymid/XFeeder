"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const REQUIRED_DOCS = [
  "README.md", "ARCHITECTURE.md", "SECURITY.md", "CONTRIBUTING.md",
  "docs/configuration.md", "docs/troubleshooting.md",
];
const FORBIDDEN_ARCHIVE = [
  /(^|\/)(?:\.venv|node_modules|\.git|__pycache__|\.env)(?:\/|$)/,
  /(^|\/)(?:cache(?:\.feeds)?\.json|debug\/terminal\.txt)$/,
  /\.network-runtime\.json$/,
  /\.activity-runtime\.json$/,
  /\.corrupt-/,
];

function invoke(command, args, cwd, timeout = 30000) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout,
    env: { ...process.env, XFEEDER_DRY_RUN: "1" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(command + " " + args.join(" ") + " failed: " +
      String(result.error?.message || result.stderr || result.stdout).slice(-1800));
  }
  return result.stdout;
}

function checkAlphaReadiness(root = ROOT) {
  for (const name of REQUIRED_DOCS) {
    if (!fs.statSync(path.join(root, name), { throwIfNoEntry: false })?.isFile())
      throw new Error("Missing alpha-readiness document: " + name);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xfeeder-alpha-"));
  const results = [];
  try {
    const config = path.join(tmp, "config.json");
    const cache = path.join(tmp, "cache.json");
    fs.writeFileSync(config, JSON.stringify({ channels: {} }) + "\n", { mode: 0o600 });
    for (const args of [
      ["--check-config", "--config", config, "--cache", cache],
      ["--dry-run", "--once", "--config", config, "--cache", cache],
    ]) {
      invoke(process.execPath, [path.join(root, "main.js"), ...args], tmp);
      if (fs.existsSync(cache)) {
        throw new Error("Alpha CLI smoke unexpectedly persisted delivery history");
      }
      results.push("CLI " + args.slice(0, 2).join(" "));
    }
    const archive = path.join(tmp, "xfeeder-runtime.tar.gz");
    invoke(process.execPath, [path.join(root, "scripts/package-release.cjs"), "HEAD", archive], root);
    const files = invoke("tar", ["-tzf", archive], tmp).trim().split("\n");
    if (!files.some(name => /\/main\.js$/.test(name)) ||
        !files.some(name => /\/config\.json$/.test(name)) ||
        !files.some(name => /\/package-lock\.json$/.test(name))) {
      throw new Error("Runtime archive is missing worker, starter config, or npm lock");
    }
    if (files.some(name => FORBIDDEN_ARCHIVE.some(pattern => pattern.test(name)))) {
      throw new Error("Runtime archive contains private/build files");
    }
    results.push("release archive: " + files.length + " entries, private data excluded");
    return { ok: true, checks: results };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const result = checkAlphaReadiness();
    for (const line of result.checks) console.log("[Alpha Gate] " + line);
  } catch (error) {
    console.error("[Alpha Gate] " + error.message);
    process.exitCode = 1;
  }
}
module.exports = { checkAlphaReadiness, REQUIRED_DOCS, FORBIDDEN_ARCHIVE };
