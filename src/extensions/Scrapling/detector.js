"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function hasCmd(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

class ScraplingDetector {
  constructor(baseDir = __dirname) {
    this.baseDir = baseDir;
    this.available = false;
    this.version = null;
    this.hasShell = false;
    this.hasExtract = false;
    this.hasMcp = false;
    this.hasSessions = false;

    this.pythonCmd = this.resolvePython();
    this.scraplingCmd = this.resolveScrapling();
    this.detect();
  }

  resolvePython() {
    const local = path.resolve(this.baseDir, ".venv/bin/python");
    if (fs.existsSync(local)) return local;
    if (hasCmd("python3")) return "python3";
    if (hasCmd("python")) return "python";
    return null;
  }

  resolveScrapling() {
    const local = path.resolve(this.baseDir, ".venv/bin/scrapling");
    if (fs.existsSync(local)) return local;
    if (hasCmd("scrapling")) return "scrapling";
    return null;
  }

  detect() {
    if (!this.pythonCmd || !this.scraplingCmd) return;

    try {
      execSync(`${this.scraplingCmd} --help`, { stdio: "ignore" });
      this.available = true;
    } catch {
      this.available = false;
      return;
    }

    try {
      this.version = execSync(
        `${this.pythonCmd} -c "import scrapling; print(getattr(scrapling, '__version__', 'unknown'))"`,
        { encoding: "utf8" }
      ).trim();
    } catch {
      this.version = "unknown";
    }

    try {
      execSync(`${this.scraplingCmd} shell --help`, { stdio: "ignore" });
      this.hasShell = true;
    } catch {}

    try {
      execSync(`${this.scraplingCmd} extract --help`, { stdio: "ignore" });
      this.hasExtract = true;
    } catch {}

    try {
      execSync(`${this.scraplingCmd} mcp --help`, { stdio: "ignore" });
      this.hasMcp = true;
    } catch {}

    try {
      execSync(
        `${this.pythonCmd} -c "from scrapling.fetchers import DynamicSession, StealthySession"`,
        { stdio: "ignore" }
      );
      this.hasSessions = true;
    } catch {}
  }
}

module.exports = { ScraplingDetector };
