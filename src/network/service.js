"use strict";
const { performance } = require("node:perf_hooks");
const { setMaxListeners } = require("node:events");
const { requireNetworkConfig, resolveNetworkPolicy } = require("./config");
const { BandwidthController } = require("./bandwidth-controller");
const { ConcurrencyGate } = require("./concurrency");
const { cancelled, combineSignals, sleep, throwIfAborted } = require("./abort");
const { context, waiting } = require("./context");
const { NetworkMetrics } = require("./metrics");

class NetworkService {
  constructor() {
    this.download = new BandwidthController();
    this.upload = new BandwidthController();
    this.metrics = new NetworkMetrics();
    this.http = new ConcurrencyGate();
    this.scrapling = new ConcurrencyGate();
    this.controller = new AbortController();
    // Unlimited concurrency can legitimately attach many request listeners to
    // this private signal. Request/stream cleanup removes them on completion.
    setMaxListeners(0, this.controller.signal);
    this.waitController = new AbortController();
    this.operations = new Set();
    // Operations with an individual deadline need a local controller. Others
    // observe the shutdown signal directly; no per-request controller is needed.
    this.controller.signal.addEventListener(
      "abort",
      () => {
        for (const operation of this.operations)
          operation.abort?.(this.controller.signal.reason);
      },
      { once: true },
    );
    this.idleListeners = new Set();
    this.stopping = false;
    this.ownedByApp = false;
    this.nextHeavyStart = 0;
    this.configure({});
  }
  configure(input = {}) {
    const config = requireNetworkConfig(input);
    const signature = JSON.stringify(config);
    if (this.signature === signature) return;
    this.config = config;
    this.signature = signature;
    this.policy = resolveNetworkPolicy(config);
    this.download.setRate(config.downloadBytesPerSecond);
    this.upload.setRate(config.uploadBytesPerSecond);
    this.http.setLimit(this.policy.httpConcurrency);
    this.scrapling.setLimit(this.policy.scraplingConcurrency);
    if (!config.networkFriendlyMode) this.nextHeavyStart = 0;
  }
  useConfig(root) {
    if (!this.ownedByApp && root) this.configure(root.network || {});
    return this;
  }
  operation(signal, { localAbort = true } = {}) {
    if (this.stopping) throw cancelled("Network service is shutting down");
    throwIfAborted(this.controller.signal);
    const local = localAbort ? new AbortController() : null;
    const contextSignal = context().signal;
    const source = local ? local.signal : this.controller.signal;
    const combined =
      signal || contextSignal
        ? combineSignals(signal, contextSignal, source)
        : source;
    throwIfAborted(combined);
    const token = {
      abort: local ? (reason) => local.abort(reason) : undefined,
      signal: combined,
    };
    this.operations.add(token);
    token.finish = () => {
      this.operations.delete(token);
      if (!this.operations.size)
        for (const resolve of this.idleListeners) resolve();
    };
    return token;
  }
  async acquire(kind, signal) {
    const gate = kind === "scrapling" ? this.scrapling : this.http;
    const release = await waiting(gate.acquire(signal), `concurrency:${kind}`);
    try {
      throwIfAborted(signal);
      if (kind === "scrapling" && this.config.networkFriendlyMode) {
        const [min, max] = this.policy.heavySpacingMs;
        const now = performance.now();
        const start = Math.max(now, this.nextHeavyStart);
        this.nextHeavyStart = start + min + Math.random() * (max - min);
        await this.wait(start - now, signal, "friendly-spacing");
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  wait(ms, signal, reason = "retry") {
    return waiting(
      sleep(ms, combineSignals(signal, this.waitController.signal)),
      reason,
    );
  }
  async run(kind, signal, fn) {
    const op = this.operation(signal);
    let release;
    try {
      release = await this.acquire(kind, op.signal);
      return await fn(op.signal);
    } finally {
      release?.();
      op.finish();
    }
  }
  beginShutdown() {
    if (this.stopping) return;
    this.stopping = true;
    const error = cancelled("Network admission closed for shutdown");
    this.http.close(error);
    this.scrapling.close(error);
    this.waitController.abort(error);
  }
  async shutdown(graceMs = this.config.shutdownGraceMs) {
    this.beginShutdown();
    let timer, resolveIdle;
    try {
      if (this.operations.size) {
        await Promise.race([
          new Promise((resolve) => {
            resolveIdle = resolve;
            this.idleListeners.add(resolve);
          }),
          new Promise((resolve) => {
            timer = setTimeout(resolve, graceMs);
          }),
        ]);
      }
    } finally {
      clearTimeout(timer);
      this.idleListeners.delete(resolveIdle);
    }
    this.controller.abort(cancelled("Shutdown deadline reached"));
    this.download.close(cancelled("Bandwidth controller closed for shutdown"));
    this.upload.close(cancelled("Upload controller closed for shutdown"));
  }
  metricsSnapshot() {
    return {
      ...this.metrics.snapshot(),
      activeHttpRequests: this.http.active,
      waitingHttpRequests: this.http.waiting.length,
      activeScraplingTasks: this.scrapling.active,
      waitingScraplingTasks: this.scrapling.waiting.length,
      waitingDownload: this.download.queue.length,
      waitingUpload: this.upload.queue.length,
      profile: this.config.bandwidthProfile,
      downloadLimitBytesPerSecond: this.config.downloadBytesPerSecond,
      uploadLimitBytesPerSecond: this.config.uploadBytesPerSecond,
      friendlyMode: this.config.networkFriendlyMode,
      policy: {
        httpConcurrency: Number.isFinite(this.policy.httpConcurrency)
          ? this.policy.httpConcurrency
          : null,
        scraplingConcurrency: Number.isFinite(this.policy.scraplingConcurrency)
          ? this.policy.scraplingConcurrency
          : null,
      },
      scraplingBytes: {
        status: "unavailable",
        downloadedBytes: null,
        uploadedBytes: null,
      },
      accounting:
        "encoded HTTP body read / request body handed to transport; excludes headers, TLS and redirect replay",
      uploadEnforcement:
        "buffered initial bodies paced before dispatch; streams, multipart and redirect replay are unshaped",
      stopping: this.stopping,
    };
  }
  snapshot() {
    return {
      download: this.download.snapshot(),
      upload: this.upload.snapshot(),
      http: this.http.snapshot(),
      scrapling: this.scrapling.snapshot(),
      operations: this.operations.size,
      stopping: this.stopping,
    };
  }
}

let current = new NetworkService();
function getNetwork(root) {
  return current.useConfig(root);
}
function resetNetwork() {
  current.beginShutdown();
  current.controller.abort(cancelled());
  current.download.close();
  current.upload.close();
  current = new NetworkService();
  return current;
}
module.exports = { NetworkService, getNetwork, resetNetwork };
