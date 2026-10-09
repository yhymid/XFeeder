"use strict";

const { execFile: systemExecFile } = require("node:child_process");
const { abortError } = require("./task-gate");
const stopping = new WeakMap();

function terminateChildTree(child) {
  if (!child) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  const stopped = new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", finish);
    const kill = (signal) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {}
      }
      if (child.exitCode === null) child.kill(signal);
    };
    timer = setTimeout(() => kill("SIGKILL"), 1000);
    timer.unref();
    if (process.platform === "win32" && child.pid) {
      systemExecFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () =>
        kill("SIGTERM"),
      );
    } else {
      kill("SIGTERM");
    }
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
      await terminateChildTree(child);
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
