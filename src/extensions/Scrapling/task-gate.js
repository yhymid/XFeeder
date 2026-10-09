"use strict";

function abortError() {
  const error = new Error("Scrapling request cancelled");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

// Scrapling-only admission control. This is not an HTTP or bandwidth limiter.
class TaskGate {
  constructor() {
    this.active = new Set();
    this.waiting = [];
    this.generation = 0;
  }

  run(limit, signal, operation) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const task = {
        limit,
        signal,
        operation,
        resolve,
        reject,
        generation: this.generation,
      };
      task.abort = () => {
        const index = this.waiting.indexOf(task);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        signal.removeEventListener("abort", task.abort);
        reject(abortError());
        this.drain();
      };
      signal?.addEventListener("abort", task.abort, { once: true });
      this.waiting.push(task);
      this.drain();
    });
  }

  drain() {
    while (this.waiting.length) {
      const task = this.waiting[0];
      // Honor limits of tasks already running when config changes or callers
      // use different Scrapling instances. Never preempt an active fetch.
      const limit = Math.min(
        task.limit,
        ...Array.from(this.active, (item) => item.limit),
      );
      if (this.active.size >= limit) return;
      this.waiting.shift();
      task.signal?.removeEventListener("abort", task.abort);
      this.active.add(task);
      Promise.resolve()
        .then(() => {
          if (task.signal?.aborted || task.generation !== this.generation)
            throw abortError();
          return task.operation();
        })
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active.delete(task);
          this.drain();
        });
    }
  }

  cancelWaiting(error = abortError()) {
    this.generation++;
    for (const task of this.waiting.splice(0)) {
      task.signal?.removeEventListener("abort", task.abort);
      task.reject(error);
    }
  }
}

module.exports = { TaskGate, abortError };
