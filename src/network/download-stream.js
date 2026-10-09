"use strict";
const { Readable } = require("node:stream");
const { performance } = require("node:perf_hooks");
const { waiting } = require("./context");
const { combineSignals, cancelled } = require("./abort");

// Pull from IncomingMessage only while downstream has room. Unlimited passes
// chunks synchronously; only an actual bandwidth wait creates an async step.
class DownloadStream extends Readable {
  constructor(raw, network, signal, idleMs, onTimeout) {
    // Match the source's normal buffering in Unlimited; a smaller output buffer
    // forces otherwise unrestricted consumers through extra read/nextTick cycles.
    super({
      highWaterMark:
        network.download.rate === null
          ? Math.min(raw.readableHighWaterMark, 65536)
          : 16384,
    });
    this.raw = raw;
    this.network = network;
    this.idleMs = idleMs;
    this.onTimeout = onTimeout;
    this.pending = null;
    this.offset = 0;
    this.demand = false;
    this.busy = false;
    this.ended = false;
    this.idleTimer = null;
    this.idleSince = null;
    // A local cancellation signal is needed only when waiting for bandwidth.
    // Unlimited still observes the parent signal via its destroy listener.
    this.local = null;
    this.signal = signal;
    this.abort = () => this.destroy(signal.reason || cancelled());
    this.parentSignal = signal;
    signal.addEventListener("abort", this.abort, { once: true });
    this.statusCode = raw.statusCode;
    this.statusMessage = raw.statusMessage;
    this.headers = raw.headers;
    this.rawHeaders = raw.rawHeaders;
    this.req = raw.req;
    this.socket = raw.socket;
    raw.on("readable", () => this.pump());
    raw.once("end", () => {
      this.ended = true;
      this.pump();
    });
    raw.once("error", (error) => this.destroy(error));
    raw.once("close", () => {
      if (!raw.readableEnded && !this.destroyed)
        this.destroy(
          Object.assign(new Error("Response closed before completion"), {
            code: "ERR_STREAM_PREMATURE_CLOSE",
          }),
        );
    });
    this.on("error", () => {});
    if (signal.aborted) this.abort();
  }
  _read() {
    this.demand = true;
    this.pump();
  }
  clearIdle() {
    this.idleSince = null;
  }
  armIdle() {
    if (!(this.idleMs > 0)) return;
    if (this.idleSince === null) this.idleSince = performance.now();
    if (this.idleTimer !== null) return;
    const check = () => {
      this.idleTimer = null;
      if (this.destroyed || this.idleSince === null) return;
      const remaining = this.idleMs - (performance.now() - this.idleSince);
      if (remaining <= 0) this.destroy(this.onTimeout());
      else this.idleTimer = setTimeout(check, remaining);
    };
    this.idleTimer = setTimeout(check, this.idleMs);
  }
  pump() {
    if (this.busy || this.destroyed) return;
    if (this.ended && !this.pending) {
      this.clearIdle();
      this.push(null);
      return;
    }
    if (!this.demand) return;
    this.busy = true;
    while (this.demand && !this.destroyed) {
      if (!this.pending) {
        this.pending = this.raw.read();
        this.offset = 0;
        if (this.pending === null) {
          if (this.ended || this.raw.readableEnded) {
            this.clearIdle();
            this.push(null);
          } else this.armIdle();
          break;
        }
        this.clearIdle();
        this.network.metrics.record("download", this.pending.length);
      }
      const bucket = this.network.download;
      if (bucket.rate === null && !bucket.closed && !this.signal.aborted) {
        const chunk = this.offset
          ? this.pending.subarray(this.offset)
          : this.pending;
        void bucket.consume(chunk.length, { signal: this.signal });
        this.pending = null;
        this.demand = this.push(chunk);
        continue;
      }
      const length = Math.min(
        this.pending.length - this.offset,
        bucket.quantum,
      );
      if (!this.local) {
        this.local = new AbortController();
        this.signal = combineSignals(this.parentSignal, this.local.signal);
      }
      waiting(
        bucket.consume(length, { signal: this.signal }),
        "bandwidth",
      ).then(
        () => {
          if (this.destroyed) return;
          const chunk = this.pending.subarray(
            this.offset,
            this.offset + length,
          );
          this.offset += length;
          if (this.offset === this.pending.length) this.pending = null;
          this.demand = this.push(chunk);
          this.busy = false;
          this.pump();
        },
        (error) => this.destroy(error),
      );
      return;
    }
    this.busy = false;
  }
  _destroy(error, callback) {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.clearIdle();
    if (this.local && !this.readableEnded)
      this.local.abort(error || cancelled("Response stream closed"));
    this.parentSignal.removeEventListener("abort", this.abort);
    this.pending = null;
    this.raw.destroy();
    callback(error);
  }
}
module.exports = { DownloadStream };
