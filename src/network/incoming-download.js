"use strict";
const { performance } = require("node:perf_hooks");
const { waiting } = require("./context");
const { combineSignals, cancelled } = require("./abort");
const observeError = () => {};

// IncomingMessage is already a Readable. Keep its native buffer and lifecycle
// instead of copying every byte through a second Readable. Decorate only the
// producer hooks (push, _read, _destroy), preserving their implementations.
// https://nodejs.org/api/stream.html#api-for-stream-implementers
function manageIncomingDownload(raw, network, signal, idleMs, onTimeout, {
  observeAbort = true, onFailure,
} = {}) {
  // Cancellation can win before Axios installs its response listeners.
  raw.on("error", observeError);
  const originalPush = raw.push;
  const originalRead = raw._read;
  const originalDestroy = raw._destroy;
  let chunks = [], index = 0, offset = 0;
  let demand = false, busy = false, ended = false, resumePending = false;
  let readSize = raw.readableHighWaterMark;
  let local, bandwidthSignal = signal;
  let idleSince = null, idleTimer = null;

  const clearIdle = () => { idleSince = null; };
  const armIdle = () => {
    if (!(idleMs > 0) || raw.destroyed || ended) return;
    if (idleSince === null) idleSince = performance.now();
    if (idleTimer !== null) return;
    const check = () => {
      idleTimer = null;
      if (raw.destroyed || idleSince === null) return;
      const remaining = idleMs - (performance.now() - idleSince);
      if (remaining <= 0) raw.destroy(onTimeout());
      else idleTimer = setTimeout(check, remaining);
    };
    idleTimer = setTimeout(check, idleMs);
  };
  const resumeSource = () => {
    if (resumePending) return;
    resumePending = true;
    // A producer stops after push returns false. Resume after that return,
    // including when a queued chunk was released synchronously in Unlimited.
    queueMicrotask(() => {
      resumePending = false;
      if (raw.destroyed || ended || !demand || chunks.length) return;
      armIdle();
      originalRead.call(raw, readSize);
    });
  };
  const pump = () => {
    if (raw.destroyed || busy) return;
    busy = true;
    while (demand && index < chunks.length && !raw.destroyed) {
      const chunk = chunks[index];
      const bucket = network.download;
      if (bucket.rate === null && !bucket.closed && !bandwidthSignal.aborted) {
        const remaining = offset ? chunk.subarray(offset) : chunk;
        void bucket.consume(remaining.length, { signal: bandwidthSignal });
        index++;
        offset = 0;
        demand = originalPush.call(raw, remaining);
        continue;
      }
      if (!local) {
        local = new AbortController();
        bandwidthSignal = combineSignals(signal, local.signal);
      }
      const length = Math.min(chunk.length - offset, bucket.quantum);
      waiting(bucket.consume(length, { signal: bandwidthSignal }), "bandwidth").then(
        () => {
          if (raw.destroyed) return;
          const part = chunk.subarray(offset, offset + length);
          offset += length;
          if (offset === chunk.length) { index++; offset = 0; }
          demand = originalPush.call(raw, part);
          busy = false;
          pump();
        },
        (error) => raw.destroy(error),
      );
      return;
    }
    busy = false;
    if (raw.destroyed) return;
    if (index === chunks.length) {
      chunks = [];
      index = 0;
      if (ended) originalPush.call(raw, null);
      else if (demand) resumeSource();
    }
  };
  raw.push = function (chunk, encoding) {
    if (raw.destroyed) return false;
    clearIdle();
    if (chunk === null) {
      ended = true;
      return index === chunks.length ? originalPush.call(raw, null) : false;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    network.metrics.record("download", buffer.length);
    const bucket = network.download;
    if (!chunks.length && bucket.rate === null && !bucket.closed && !signal.aborted) {
      void bucket.consume(buffer.length, { signal });
      demand = originalPush.call(raw, buffer);
      return demand;
    }
    chunks.push(buffer);
    pump();
    return false;
  };
  raw._read = function (size) {
    if (raw.destroyed) return;
    demand = true;
    readSize = size;
    if (chunks.length || ended) pump();
    else {
      armIdle();
      originalRead.call(raw, size);
    }
  };
  const abort = () => raw.destroy(signal.reason || cancelled());
  raw._destroy = function (error, callback) {
    // IncomingMessage emits `aborted` before its transport error. Preserve the
    // cause before Axios translates that event to generic ERR_BAD_RESPONSE.
    if (error) onFailure?.(error);
    clearTimeout(idleTimer);
    idleTimer = null;
    clearIdle();
    if (observeAbort) signal.removeEventListener("abort", abort);
    if (local && !raw.readableEnded)
      local.abort(error || cancelled("Response stream closed"));
    chunks = [];
    raw.push = originalPush;
    raw._read = originalRead;
    raw._destroy = originalDestroy;
    originalDestroy.call(raw, error, callback);
  };
  if (observeAbort) signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return raw;
}

module.exports = { manageIncomingDownload };
