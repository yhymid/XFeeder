"use strict";

const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const { TaskGate, abortError } = require("./task-gate");
const { terminateChildTree } = require("./process-control");

const WORKER_SCRIPT = path.join(__dirname, "browser_worker.py");
const DEFAULT_TIMEOUT_MS = 120000;
const SHUTDOWN_TIMEOUT_MS = 5000;

class BrowserWorker {
  constructor() {
    this.child = null;
    this.pythonCmd = null;
    this.nextId = 1;
    this.pending = new Map();
    this.lastStderr = "";
    this.queue = new TaskGate();
    this.stopping = Promise.resolve();
    this.generation = 0;
    this.closing = false;
  }

  start(pythonCmd) {
    if (this.child && this.pythonCmd === pythonCmd) return;
    this.stop(new Error("Scrapling browser worker restarted"));

    const child = spawn(pythonCmd, [WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.pythonCmd = pythonCmd;
    this.lastStderr = "";

    const output = readline.createInterface({ input: child.stdout });
    child._xfeederOutput = output;
    output.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.lastStderr = `${this.lastStderr}${chunk}`.slice(-4000);
      const message = String(chunk).trim();
      if (message) console.warn(`[Scrapling Session] ${message}`);
    });
    child.on("error", (error) => { if (this.child === child) this.stop(error); });
    child.on("exit", (code, signal) => {
      const detail = code === 0 ? "closed" : `exited (${signal || code})`;
      const suffix = this.lastStderr.trim();
      const error = new Error(`Scrapling browser worker ${detail}${suffix ? `: ${suffix}` : ""}`);
      if (this.child === child) this.stop(error);
    });
  }

  handleLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      console.warn(`[Scrapling Session] Ignored non-protocol output: ${String(line).slice(0, 200)}`);
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response);
    }
  }

  stop(error = new Error("Scrapling browser worker stopped")) {
    const child = this.child;
    this.child = null;
    this.pythonCmd = null;
    if (child) {
      if (child._xfeederOutput) child._xfeederOutput.close();
      this.stopping = terminateChildTree(child);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(pythonCmd, request, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
    if (this.closing) return Promise.reject(abortError());
    const generation = this.generation;
    // Python's protocol is synchronous. Keep waiting calls in Node so aborting
    // one active browser cannot kill unrelated calls buffered in its stdin.
    return this.queue.run(1, signal, async () => {
      await this.stopping;
      if (signal?.aborted || generation !== this.generation) throw abortError();
      const onAbort = () => this.stop(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await this.requestActive(pythonCmd, request, timeoutMs);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await this.stopping;
      }
    });
  }

  requestActive(pythonCmd, request, timeoutMs) {
    this.start(pythonCmd);
    const child = this.child;
    const id = this.nextId++;
    const payload = JSON.stringify({ ...request, id });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Scrapling browser request timed out after ${timeoutMs}ms`);
        this.stop(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  async fetch(pythonCmd, url, mode, options = {}) {
    const { signal, ...serializableOptions } = options;
    const timeout = Number(options.timeoutMs ?? options.timeout_ms ?? 0);
    const timeoutMs = Number.isFinite(timeout) && timeout > 0
      ? Math.min(300000, Math.max(10000, timeout + 30000))
      : DEFAULT_TIMEOUT_MS;
    const response = await this.request(pythonCmd, { url, mode, options: serializableOptions }, timeoutMs, signal);
    return {
      html: response.html || "",
      status: response.status ?? null,
      headers: response.headers || {},
      url: response.url || url,
      fetchMode: mode,
      runtime: "session",
      elapsed: null,
    };
  }

  async close() {
    if (this.closing) return this.closePromise;
    this.closing = true;
    this.generation++;
    this.queue.cancelWaiting();
    this.closePromise = this.closeActive().finally(() => { this.closing = false; });
    return this.closePromise;
  }

  async closeActive() {
    const child = this.child;
    if (!child) { await this.stopping; return; }
    const id = this.nextId++;

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        terminateChildTree(child);
        finish();
      }, SHUTDOWN_TIMEOUT_MS);
      child.once("exit", finish);
      this.pending.set(id, {
        resolve: () => {
          child.stdin.end();
          finish();
        },
        reject: finish,
        timer,
      });
      child.stdin.write(`${JSON.stringify({ id, action: "shutdown" })}\n`, (error) => {
        if (error) finish();
      });
    });

    if (this.child === child) this.stop();
    await this.stopping;
  }
}

const browserWorker = new BrowserWorker();

module.exports = browserWorker;
