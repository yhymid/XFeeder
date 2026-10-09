"use strict";
const { cancelled } = require("./abort");

class ConcurrencyGate {
  constructor(limit = Infinity) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
    this.closed = false;
  }
  setLimit(limit) {
    this.limit = limit;
    this.drain();
  }
  acquire(signal) {
    try {
      const release = this.tryAcquire(signal);
      if (release) return Promise.resolve(release);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal };
      item.abort = () => {
        const index = this.waiting.indexOf(item);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal.removeEventListener("abort", item.abort);
        reject(signal.reason || cancelled());
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      this.waiting.push(item);
      this.drain();
    });
  }
  tryAcquire(signal) {
    if (this.closed || signal?.aborted)
      throw signal?.reason || cancelled("Network admission closed");
    // No queue entry or abort listener is needed for an immediately granted
    // permit. Never bypass an older waiter when a limit changes at runtime.
    if (!this.waiting.length && this.active < this.limit)
      return this.permit();
    return null;
  }
  drain() {
    while (!this.closed && this.waiting.length && this.active < this.limit) {
      const item = this.waiting.shift();
      item.signal?.removeEventListener("abort", item.abort);
      item.resolve(this.permit());
    }
  }
  permit() {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }
  close(error = cancelled("Network admission closed")) {
    this.closed = true;
    this.cancelWaiting(error);
  }
  cancelWaiting(error = cancelled("Network waiting operation cancelled")) {
    for (const item of this.waiting.splice(0)) {
      item.signal?.removeEventListener("abort", item.abort);
      item.reject(error);
    }
  }
  snapshot() {
    return {
      active: this.active,
      waiting: this.waiting.length,
      limit: this.limit,
    };
  }
}
module.exports = { ConcurrencyGate };
