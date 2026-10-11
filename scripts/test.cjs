"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function testFiles(root) {
  return fs.readdirSync(path.join(root, "tests"), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".test.js"))
    .map(entry => path.join(root, "tests", entry.name)).sort();
}

function testEnvironment(source) {
  // Keep OS executable/temp paths, not user credentials, proxies, NODE_OPTIONS or
  // GIT_DIR/GIT_INDEX_FILE. Tests provide their own synthetic application env.
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_.*|TZ|TERM|COLORTERM|CI|NO_COLOR|FORCE_COLOR)$/i;
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function run({ root = path.resolve(__dirname, ".."), args = process.argv.slice(2), env = process.env } = {}) {
  const files = testFiles(root);
  if (!files.length) throw Error("No tests/*.test.js files found");
  const options = ["--require", path.resolve(__dirname, "../tests/helpers/setup.cjs"), "--test"];
  if (args.includes("--coverage")) {
    const coverage = path.join(root, "coverage");
    fs.mkdirSync(coverage, { recursive: true });
    options.push("--experimental-test-coverage",
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      "--test-reporter=lcov", `--test-reporter-destination=${path.join(coverage, "lcov.info")}`);
    if (process.allowedNodeEnvironmentFlags.has("--test-coverage-include")) {
      options.push(`--test-coverage-include=${path.join(root, "src", "**").replace(/\\/g, "/")}`);
    } else {
      console.log("This Node version reports coverage for all loaded project files (including tests); source-only filtering is unavailable.");
    }
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "xfeeder-tests-"));
  try {
    const result = spawnSync(process.execPath, [...options, ...args.filter(arg => arg !== "--coverage"), ...files], {
      cwd: root,
      env: { ...testEnvironment(env), XFEEDER_TEST_ROOT: temporary },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (require.main === module) {
  try { process.exitCode = run(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { run, testFiles, testEnvironment };
