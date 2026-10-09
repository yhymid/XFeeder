"use strict";

const http = require("node:http");
const https = require("node:https");
const assert = require("node:assert/strict");

const config = { Proxy: { Enabled: false }, Scrapling: { Enabled: false } };
const requestOptions = { config, proxy: false, maxAttempts: 1 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Restore environment and mocks after each test; never inherit the user's proxy.
function offline(t) {
  for (const key of Object.keys(process.env).filter((key) =>
    /^(?:npm_config_)?(?:(?:https?|all|no)_proxy|proxy)$/i.test(key),
  )) {
    const value = process.env[key];
    delete process.env[key];
    t.after(() => {
      process.env[key] = value;
    });
  }
  for (const transport of [http, https]) {
    const original = transport.request;
    t.mock.method(transport, "request", function (input, ...args) {
      const options = typeof input === "string" ? new URL(input) : input;
      const host = options.hostname || options.host;
      assert.ok(
        ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host),
        `Non-loopback HTTP request blocked: ${host}`,
      );
      return original.call(this, input, ...args);
    });
  }
}

async function serve(t, handler, tls) {
  const requests = [];
  const sockets = new Set();
  const failures = [];
  const listener = (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    Promise.resolve()
      .then(() => handler(req, res, requests))
      .catch((error) => {
        failures.push(error);
        res.destroy();
      });
  };
  const server = tls ? https.createServer(tls, listener) : http.createServer(listener);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
    assert.deepEqual(failures, [], "Local server handlers must succeed");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, requests, url: `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}` };
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Intercept only the application delay under test. Real socket/deadline timers
// keep running, and the test explicitly releases the retry without wall time.
function holdDelay(t, milliseconds) {
  const scheduled = deferred();
  const callbacks = [];
  const original = global.setTimeout;
  t.mock.method(global, "setTimeout", (callback, delay, ...args) => {
    if (delay !== milliseconds) return original(callback, delay, ...args);
    callbacks.push(() => callback(...args));
    scheduled.resolve(delay);
    return {
      ref() {
        return this;
      },
      unref() {
        return this;
      },
    };
  });
  const release = () => callbacks.splice(0).forEach((callback) => callback());
  t.after(release);
  return { scheduled: scheduled.promise, release };
}

function mockScraplingDetector(t, available = false) {
  const {
    ScraplingDetector,
  } = require("../../src/extensions/Scrapling/detector");
  t.mock.method(
    ScraplingDetector.prototype,
    "resolvePython",
    () => "fixture-python",
  );
  t.mock.method(
    ScraplingDetector.prototype,
    "resolveScrapling",
    () => "fixture-scrapling",
  );
  t.mock.method(ScraplingDetector.prototype, "detect", function () {
    Object.assign(this, {
      available,
      hasShell: available,
      hasExtract: available,
      hasSessions: available,
    });
  });
}

module.exports = {
  config,
  requestOptions,
  deferred,
  offline,
  serve,
  readBody,
  holdDelay,
  mockScraplingDetector,
};
