"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempDir } = require("./helpers/temp-dir.cjs");

const root = path.resolve(__dirname, "..");
const mainPath = path.join(root, "main.js");

test("X3-10: a failed --once pass flushes shutdown before reporting exit code 1", (t) => {
  const dir = tempDir(t);
  const preloader = path.join(dir, "stub.cjs");
  const marker = path.join(dir, "shutdown.json");
  // Replace only the bootstrap dependency in this isolated child process.
  // This tests real CLI error handling without reaching external services.
  fs.writeFileSync(preloader, `
    const Module = require("node:module");
    const fs = require("node:fs");
    const original = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "./src/app/bootstrap" && parent?.filename === ${JSON.stringify(mainPath)}) {
        return { createApp() {
          return {
            allChannels: [], dryRun: false,
            async runOnce() { throw Error("SYNTHETIC_ONCE_FAILURE"); },
            async shutdown(options) {
              fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(options));
            },
          };
        } };
      }
      return original.apply(this, arguments);
    };
  `);
  const result = spawnSync(process.execPath,
    ["--require", preloader, mainPath, "--once"],
    { cwd: dir, encoding: "utf8", timeout: 10000, env: process.env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /SYNTHETIC_ONCE_FAILURE/);
  assert.equal(fs.existsSync(marker), true, "CLI must call shutdown on failure");
  const shutdown = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(shutdown.exit, false);
  assert.equal(shutdown.exitCode, 1);
});

test("X3-10: browser cleanup failure does not skip delivery-state flush", async (t) => {
  const extension = require("../src/extensions/Scrapling");
  const originalClose = extension.closeBrowserSessions;
  const bootstrapPath = require.resolve("../src/app/bootstrap");
  const previouslyLoaded = require.cache[bootstrapPath];
  const dir = tempDir(t);
  const configPath = path.join(dir, "config.json");
  const cachePath = path.join(dir, "cache.json");
  fs.writeFileSync(configPath, JSON.stringify({
    Proxy: { Enabled: false },
    Scrapling: { Enabled: false },
    network: {},
    Channels: [{ ID: "fixture", RSS: ["http://127.0.0.1/unused"] }],
  }));

  extension.closeBrowserSessions = async () => {
    throw new Error("SYNTHETIC_BROWSER_CLOSE_FAILURE");
  };
  delete require.cache[bootstrapPath];
  t.after(() => {
    extension.closeBrowserSessions = originalClose;
    delete require.cache[bootstrapPath];
    if (previouslyLoaded) require.cache[bootstrapPath] = previouslyLoaded;
  });

  const { createApp } = require("../src/app/bootstrap");
  const app = createApp({ configPath, cachePath, autostart: false });
  await assert.rejects(app.shutdown({ exit: false }), /SYNTHETIC_BROWSER_CLOSE_FAILURE/);
  assert.ok(fs.existsSync(cachePath), "successful destination state must still be flushed");
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")), {});
  assert.equal(app.network.stopping, true);
  assert.equal(app.startQueue(), null, "shutdown must reject new scheduler starts");
  await assert.rejects(app.shutdown({ exit: false }), /SYNTHETIC_BROWSER_CLOSE_FAILURE/,
    "repeated shutdown must share the failed cleanup result");
});

test("X3-10: network shutdown failure does not skip browser cleanup or cache persistence", async (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, "config.json");
  const cachePath = path.join(dir, "cache.json");
  fs.writeFileSync(configPath, JSON.stringify({
    Proxy: { Enabled: false },
    Scrapling: { Enabled: false },
    network: {},
    Channels: [{ ID: "fixture", RSS: ["http://127.0.0.1/unused"] }],
  }));
  const { createApp } = require("../src/app/bootstrap");
  const app = createApp({ configPath, cachePath, autostart: false });
  t.mock.method(app.network, "shutdown", async () => {
    throw new Error("SYNTHETIC_NETWORK_CLOSE_FAILURE");
  });
  await assert.rejects(app.shutdown({ exit: false }), /SYNTHETIC_NETWORK_CLOSE_FAILURE/);
  assert.equal(fs.existsSync(cachePath), true);
  assert.equal(app.startQueue(), null);
});
