// main.js - XFeeder 2.2.0 Main Application
"use strict";

const { installTerminalLog, setTerminalLogEnabled } = require("./src/core/terminal-log");
installTerminalLog({
  enabled: true,
  label: "worker",
});

const { createApp } = require("./src/app/bootstrap");
const { validateChannels } = require("./src/core/channel-config");
const { sanitize, setExpertDebug } = require("./src/core/diagnostics");

function parseArgs(argv = []) {
  const options = {
    configPath: "./config.json",
    cachePath: "./cache.json",
    dryRun: process.env.XFEEDER_DRY_RUN === "1",
    once: process.env.XFEEDER_RUN_ONCE === "1",
    checkConfig: false,
    debugExpert: process.env.XFEEDER_DEBUG_EXPERT === "1",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--check-config") {
      options.checkConfig = true;
      continue;
    }
    if (arg === "--debug-expert") {
      options.debugExpert = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--config" && argv[index + 1]) {
      options.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--cache" && argv[index + 1]) {
      options.cachePath = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

function printHelp() {
  console.log([
    "Usage: node main.js [options]",
    "",
    "Options:",
    "  --dry-run       Simulate deliveries without persisting cache changes.",
    "  --once          Run one pass over all channels and exit.",
    "  --check-config  Validate config and print summary without starting the queue.",
    "  --debug-expert  Print detailed diagnostics with secrets redacted.",
    "  --config PATH   Use a custom config.json path.",
    "  --cache PATH    Use a custom cache.json path.",
    "  --help          Show this help.",
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.debugExpert) {
    setTerminalLogEnabled(true);
  }
  setExpertDebug(options.debugExpert);
  if (options.help) {
    printHelp();
    return;
  }

  const autostart = !options.once && !options.checkConfig;
  const app = createApp({
    configPath: options.configPath,
    cachePath: options.cachePath,
    dryRun: options.dryRun,
    debugExpert: options.debugExpert,
    autostart,
  });

  const stop = () => {
    console.log("\n[Shutdown] Saving state and exiting...");
    void app.shutdown({ exit: true, exitCode: 0 });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  process.on("uncaughtException", (error) => {
    console.error("[Critical Error]", error);
    app.shutdown({ exit: true, exitCode: 1 });
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[Unhandled Rejection]", reason);
    app.shutdown({ exit: true, exitCode: 1 });
  });

  const version = require("./package.json").version;
  const modes = [
    options.dryRun ? "dry-run" : null,
    options.once ? "once" : null,
    options.checkConfig ? "check-config" : null,
    options.debugExpert ? "debug-expert" : null,
  ].filter(Boolean);
  console.log(`XFeeder v${version} started${modes.length ? ` (${modes.join(", ")})` : ""}.`);

  if (options.checkConfig) {
    console.log(JSON.stringify({
      channels: app.allChannels.length,
      warnings: validateChannels(app.allChannels),
      dryRun: app.dryRun,
      configPath: options.configPath,
      cachePath: options.cachePath,
    }, null, 2));
    await app.shutdown({ exit: true, persistCache: false });
    return;
  }

  if (options.once) {
    const result = await app.runOnce();
    console.log(`[Once] Completed ${result.checkedChannels}/${result.totalChannels} channels.`);
    await app.shutdown({ exit: true });
  }
}

main().catch((error) => {
  console.error("[Startup Error]", JSON.stringify(sanitize(error)));
  process.exit(1);
});
