"use strict";

const { execFile: systemExecFile } = require("node:child_process");
const { abortError } = require("./task-gate");
const stopping = new WeakMap();

// Playwright starts Chromium in a separate session/process group. Killing only
// -child.pid cannot reach it. Snapshot descendants before the parent can exit,
// and check their start times again before signalling a PID.
async function processTable() {
  const output = await new Promise((resolve, reject) => {
    systemExecFile("ps", ["-axo", "pid=,ppid=,stat=,lstart="],
      { maxBuffer: 8 * 1024 * 1024, timeout: 1000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
  });
  const table = new Map();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (match) table.set(Number(match[1]), {
      parent: Number(match[2]), state: match[3], started: match[4],
    });
  }
  return table;
}

async function terminatePosixTree(child) {
  const known = new Map();
  function collect(table) {
    let added;
    do {
      added = false;
      for (const [pid, record] of table) {
        const parent = table.get(record.parent);
        if (!known.has(pid) && parent && known.get(record.parent) === parent.started) {
          known.set(pid, record.started);
          added = true;
        }
      }
    } while (added);
  }
  let table = await processTable();
  const root = table.get(child.pid);
  if (root) known.set(child.pid, root.started);
  collect(table);
  let closed = child.exitCode !== null || !!child.signalCode;
  const onClose = () => { closed = true; };
  child.once("close", onClose);
  const started = Date.now();
  try {
    // Preserve the driver while Python attempts normal session cleanup.
    if (!closed) child.kill("SIGTERM");
    for (;;) {
      table = await processTable();
      collect(table);
      const alive = [...known].filter(([pid, identity]) => {
        const current = table.get(pid);
        return current?.started === identity && !current.state.startsWith("Z");
      });
      if (closed && !alive.length) return;
      const force = Date.now() - started >= 1000;
      if (closed || force) {
        for (const [pid] of alive) {
          try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      }
      if (Date.now() - started >= 5000)
        throw new Error("Scrapling process tree did not terminate within 5 seconds");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally {
    child.removeListener("close", onClose);
  }
}

function terminateChildTree(child) {
  if (!child) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  const stopped = process.platform !== "win32" && child.pid
    ? terminatePosixTree(child)
    : new Promise((resolve) => {
      let timer;
      const finish = () => { clearTimeout(timer); resolve(); };
      child.once("close", finish);
      const kill = signal => {
        if (child.exitCode === null) child.kill(signal);
      };
      timer = setTimeout(() => kill("SIGKILL"), 1000);
      timer.unref();
      if (process.platform === "win32" && child.pid) {
        systemExecFile("taskkill", ["/PID", String(child.pid), "/T", "/F"],
          () => kill("SIGTERM"));
      } else kill("SIGTERM");
      if (child.exitCode !== null || child.signalCode) finish();
    });
  stopping.set(child, stopped);
  return stopped;
}

// Retain execFile's bounded output/deadline, but also kill descendants (browser
// and driver), rather than only the Python parent on abort or timeout.
function runChild(execFile, command, args, timeout, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let cancelled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const stop = async (error) => {
      if (cancelled) return;
      cancelled = true;
      cleanup();
      try { await terminateChildTree(child); }
      catch (cleanupError) { error.cause = cleanupError; }
      reject(error);
    };
    const onAbort = () => {
      void stop(abortError());
    };
    child = execFile(
      command,
      args,
      {
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        detached: process.platform !== "win32",
      },
      (error, stdout, stderr) => {
        cleanup();
        if (cancelled) return;
        if (error) {
          // Some execFile failures are delivered before a child could be spawned.
          const detail = String(stderr || "").trim();
          const raw = String(error.message || "Scrapling process failed")
            .replace(/\s+/g, " ")
            .trim();
          const failure = new Error(
            detail || (raw.length > 260 ? `${raw.slice(0, 260)}...` : raw),
          );
          void stop(failure);
        } else resolve(String(stdout || ""));
      },
    );
    // Fake execFile in unit tests may invoke its callback synchronously.
    if (child) {
      timer = setTimeout(() => {
        void stop(new Error(`Scrapling process timed out after ${timeout}ms`));
      }, timeout);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    }
  });
}

module.exports = { terminateChildTree, runChild };
