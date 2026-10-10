"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { venvPaths, probePython, compatiblePython } = require("../src/extensions/Scrapling/runtime-paths");
const DEFAULT_BASE = path.resolve(__dirname, "../src/extensions/Scrapling");
const VERIFY_IMPORT = `
from importlib.metadata import version
from scrapling import Selector
from scrapling.fetchers import Fetcher, DynamicSession, StealthySession
assert version("scrapling") == "0.4.15", "Expected pinned Scrapling 0.4.15"
assert Selector('<p id="ready">XFeeder</p>').css('#ready::text').get() == 'XFeeder'
`;
const VERIFY_BROWSER = `
from playwright.sync_api import sync_playwright
from patchright.sync_api import sync_playwright as sync_patchright
for engine in (sync_playwright, sync_patchright):
    with engine() as runtime:
        browser = runtime.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.set_content('<title>XFeeder local browser check</title>')
            assert page.title() == 'XFeeder local browser check'
        finally:
            browser.close()
`;
function prepare({ check = false, baseDir = DEFAULT_BASE, platform = process.platform,
  run = spawnSync, exists = fs.existsSync, log = console.log } = {}) {
  const local = venvPaths(baseDir, platform);
  const fixVenv = `Close XFeeder, rename ${local.directory} to a backup outside the repository, then rerun npm run scrapling:install. No environment was deleted.`;
  function step(label, command, args, remediation, timeout = 120000) {
    log(`[Scrapling] ${label}`);
    const result = run(command, args, { stdio: "inherit", shell: false, windowsHide: true, timeout });
    if (result.error || result.status !== 0) {
      throw new Error(`${label} failed (${result.error?.message || result.signal || `exit ${result.status}`}). ${remediation}`);
    }
  }
  let info;
  if (exists(local.directory)) {
    info = exists(local.python) ? probePython(local.python, run) : null;
    const normalize = value => platform === "win32" ? path.win32.resolve(value).toLowerCase() : path.resolve(value);
    if (!compatiblePython(info) || !info.prefix || info.prefix === info.basePrefix ||
        normalize(info.prefix) !== normalize(local.directory)) {
      throw new Error(`Existing virtualenv is broken or incompatible (requires Python 3.11+). ${fixVenv}`);
    }
    log(`[Scrapling] Python: OK (${info.version.join(".")}); reusing ${local.directory}`);
  } else {
    if (check) throw new Error("Virtualenv: MISSING. Run npm run scrapling:install; ordinary feeds work without Scrapling.");
    let python, found = false;
    for (const command of ["python3", "python"]) {
      const candidate = probePython(command, run);
      if (candidate) found = true;
      if (compatiblePython(candidate)) { python = command; info = candidate; break; }
    }
    if (!python) throw new Error(found ?
      "Python is incompatible. Install Python 3.11+ on PATH (the pinned IPython requires 3.11), then retry." :
      "Python not found or not executable. Install Python 3.11+ and put python3 or python on PATH, then retry.");
    step("Create virtualenv", python, ["-m", "venv", local.directory],
      `Install your Python distribution's venv/ensurepip support (e.g. python3-venv on Debian/Ubuntu). If a partial environment remains: ${fixVenv}`);
    info = probePython(local.python, run);
    if (!compatiblePython(info) || info.prefix === info.basePrefix) throw new Error(`Virtualenv verification failed. ${fixVenv}`);
    log(`[Scrapling] Python: OK (${info.version.join(".")}); Virtualenv: OK`);
  }
  log(`[Scrapling] Virtualenv: OK (${local.directory})`);
  step("Virtualenv pip check", local.python, ["-m", "pip", "--version"],
    `Restore pip with the virtualenv Python's -m ensurepip, then retry. ${fixVenv}`);
  if (!check) {
    step("Install pinned requirements", local.python,
      ["-m", "pip", "install", "--disable-pip-version-check", "--no-deps", "-r", path.join(baseDir, "requirements.lock.txt")],
      "Review pip's error above: check network/index access and wheel support for your Python/OS. Retry the installer after fixing it; no unpinned fallback is used.", 1800000);
  }
  step("Verify dependency consistency", local.python, ["-m", "pip", "check"], "Run npm run scrapling:install to restore the pinned environment.");
  step("Verify Scrapling import and parser", local.python, ["-c", VERIFY_IMPORT], "Run npm run scrapling:install and check the dependency errors above.");
  step("Verify Scrapling CLI", local.scrapling, ["--help"], "Restore the pinned Scrapling installation with npm run scrapling:install.");
  log("[Scrapling] Scrapling: OK (0.4.15)");
  if (!check) {
    for (const engine of ["playwright", "patchright"]) {
      step(`Install ${engine} Chromium`, local.python, ["-m", engine, "install", "chromium"],
        "Check network access, free disk space and permissions for the browser cache; rerun npm run scrapling:install.", 1800000);
    }
  }
  step("Verify browser launch (local page, no website requests)", local.python, ["-c", VERIFY_BROWSER],
    "Run npm run scrapling:install for missing binaries. For missing Linux libraries, ask your administrator to install the dependencies reported above (Playwright install-deps chromium). No sudo is run automatically.");
  log("[Scrapling] Browser: OK; optional runtime ready. Restart a running XFeeder worker to detect it.");
  return local;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--check")) { console.error("Usage: npm run scrapling:install OR npm run scrapling:check"); process.exitCode = 1; }
  else try { prepare({ check: args.includes("--check") }); }
  catch (error) { console.error(`[Scrapling] ${error.message}`); process.exitCode = 1; }
}
module.exports = { prepare, VERIFY_IMPORT, VERIFY_BROWSER };
