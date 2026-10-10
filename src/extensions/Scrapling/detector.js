"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { venvPaths, probePython, compatiblePython } = require("./runtime-paths");

class ScraplingDetector {
  constructor(baseDir = __dirname, { platform = process.platform, run = spawnSync, exists = fs.existsSync } = {}) {
    Object.assign(this, { baseDir, platform, run, exists, available: false, version: null,
      hasShell: false, hasExtract: false, hasMcp: false, hasSessions: false });
    this.pythonCmd = this.resolvePython();
    this.scraplingCmd = this.resolveScrapling();
    this.detect();
  }
  resolvePython() {
    const local = venvPaths(this.baseDir, this.platform);
    const candidates = [...(this.exists(local.python) ? [local.python] : []), "python3", "python"];
    let fallback;
    for (const command of candidates) {
      const info = probePython(command, this.run);
      if (!compatiblePython(info, 10)) continue;
      fallback ||= { command, info };
      if (info.scrapling) {
        this.runtime = info;
        return command;
      }
    }
    this.runtime = fallback?.info;
    return fallback?.command || null;
  }
  resolveScrapling() {
    if (!this.runtime?.scrapling) return null;
    const paths = this.platform === "win32" ? path.win32 : path;
    // Pair the CLI with the selected Python, never an unrelated PATH executable.
    return (this.runtime.scripts || []).map(dir => paths.join(dir,
      this.platform === "win32" ? "scrapling.exe" : "scrapling")).find(file => this.exists(file)) || null;
  }
  succeeds(command, args) {
    const result = this.run(command, args, { stdio: "ignore", timeout: 15000, windowsHide: true, shell: false });
    return !result.error && result.status === 0;
  }
  detect() {
    if (!this.pythonCmd || !this.scraplingCmd) return;
    if (!this.succeeds(this.pythonCmd, ["-c", "import scrapling"]) ||
        !this.succeeds(this.scraplingCmd, ["--help"])) return;
    this.available = true;
    this.version = this.runtime?.scrapling || "unknown";
    this.hasShell = this.succeeds(this.scraplingCmd, ["shell", "--help"]);
    this.hasExtract = this.succeeds(this.scraplingCmd, ["extract", "--help"]);
    this.hasMcp = this.succeeds(this.scraplingCmd, ["mcp", "--help"]);
    this.hasSessions = this.succeeds(this.pythonCmd, ["-c", "from scrapling.fetchers import DynamicSession, StealthySession"]);
  }
}
module.exports = { ScraplingDetector };
