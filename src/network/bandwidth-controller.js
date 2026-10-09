"use strict";
const { performance } = require("node:perf_hooks");
const { cancelled } = require("./abort");
const immediatePermit = Promise.resolve();

// Token bucket: at most 100 ms of credits, capped at 64 KiB. Round-robin
// allocation in small quanta keeps a large consumer from starving smaller ones.
class BandwidthController {
  constructor(rate = null, clock = {}) {
    this.now = clock.now || (() => performance.now());
    this.setTimer = clock.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = clock.clearTimeout || ((timer) => clearTimeout(timer));
    this.queue = [];
    this.timer = null;
    this.closed = false;
    this.grantedBytes = 0;
    this.rate = null;
    this.tokens = 0;
    this.last = this.now();
    this.setRate(rate);
    this.tokens = this.capacity;
  }
  get capacity() {
    return this.rate === null
      ? 0
      : Math.max(1, Math.min(65536, Math.floor(this.rate / 10)));
  }
  get quantum() {
    return this.rate === null ? 65536 : Math.min(16384, this.capacity);
  }
  refill() {
    const now = this.now();
    if (this.rate !== null)
      this.tokens = Math.min(
        this.capacity,
        this.tokens + (Math.max(0, now - this.last) * this.rate) / 1000,
      );
    this.last = now;
  }
  setRate(rate) {
    if (rate !== null && (!Number.isSafeInteger(rate) || rate < 1))
      throw new RangeError("Rate must be positive integer bytes/s or null");
    this.refill();
    this.rate = rate;
    this.tokens = Math.min(this.tokens, this.capacity);
    this.drain();
  }
  consume(bytes, { signal } = {}) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      return Promise.reject(new RangeError("Invalid byte count"));
    if (this.closed || signal?.aborted)
      return Promise.reject(
        signal?.reason || cancelled("Bandwidth controller closed"),
      );
    if (!bytes || this.rate === null) {
      this.grantedBytes += bytes;
      return immediatePermit;
    }
    return new Promise((resolve, reject) => {
      const item = { bytes, remaining: bytes, resolve, reject, signal };
      item.abort = () => {
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.cleanup(item);
        reject(signal.reason || cancelled());
        this.drain();
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }
  cleanup(item) {
    item.signal?.removeEventListener("abort", item.abort);
  }
  drain() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.closed) return;
    this.refill();
    while (this.queue.length && (this.rate === null || this.tokens >= 1)) {
      const item = this.queue.shift();
      const amount =
        this.rate === null
          ? item.remaining
          : Math.min(item.remaining, this.quantum, Math.floor(this.tokens));
      item.remaining -= amount;
      if (this.rate !== null) this.tokens -= amount;
      if (!item.remaining) {
        this.cleanup(item);
        this.grantedBytes += item.bytes;
        item.resolve();
      } else this.queue.push(item);
    }
    if (this.queue.length) {
      const next = Math.min(this.queue[0].remaining, this.quantum);
      const delay = Math.max(
        1,
        Math.ceil(((next - this.tokens) / this.rate) * 1000),
      );
      this.timer = this.setTimer(
        () => {
          this.timer = null;
          this.drain();
        },
        Math.min(delay, 2_147_000_000),
      );
    }
  }
  close(error = cancelled("Bandwidth controller closed")) {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    for (const item of this.queue.splice(0)) {
      this.cleanup(item);
      item.reject(error);
    }
  }
  snapshot() {
    return {
      rate: this.rate,
      burstBytes: this.capacity,
      pending: this.queue.length,
      grantedBytes: this.grantedBytes,
      closed: this.closed,
    };
  }
}
module.exports = { BandwidthController };
