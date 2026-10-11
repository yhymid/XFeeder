"use strict";

// Loaded before each node:test process imports the application. This is a guard
// against accidental I/O in trusted tests, not a sandbox for untrusted code.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

// Keep the reporter process in the repo so LCOV paths resolve from the repo root.
// Node sets NODE_TEST_CONTEXT in its isolated test workers (verified on 20/26).
if (process.env.NODE_TEST_CONTEXT) {
  const previousDirectory = process.cwd();
  const directory = fs.mkdtempSync(path.join(process.env.XFEEDER_TEST_ROOT || os.tmpdir(), "xfeeder-test-process-"));
  process.chdir(directory);
  process.on("exit", () => {
    process.chdir(previousDirectory);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect may pass its normalized argument array to Socket.connect.
  const parameters = Array.isArray(args[0]) ? args[0] : args;
  const first = parameters[0];
  const options = first && typeof first === "object" ? first :
    { host: typeof parameters[1] === "string" ? parameters[1] : "localhost", path: typeof first === "string" ? first : undefined };
  const host = options.host || options.hostname || "localhost";
  if (options.path || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    const error = new Error("Test network guard: only loopback TCP connections are allowed");
    error.code = "XFEEDER_TEST_NETWORK_BLOCKED";
    throw error;
  }
  return connect.apply(this, args);
};
