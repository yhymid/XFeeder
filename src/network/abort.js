"use strict";

function cancelled(message = "Network operation cancelled") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ERR_CANCELED";
  return error;
}
function isCancelled(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "ERR_CANCELED" ||
    error?.code === "NETWORK_CLOSED"
  );
}
function throwIfAborted(signal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : cancelled();
}
function combineSignals(...signals) {
  const present = signals.filter(Boolean);
  if (!present.length) return undefined;
  if (present.every((signal) => signal === present[0])) return present[0];
  return AbortSignal.any(present);
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    let remaining = Math.max(0, ms);
    const clean = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      clean();
      reject(signal.reason instanceof Error ? signal.reason : cancelled());
    };
    const next = () => {
      if (signal?.aborted) return abort();
      if (remaining <= 0) {
        clean();
        resolve();
        return;
      }
      const duration = Math.min(remaining, 2_147_000_000);
      remaining -= duration;
      timer = setTimeout(next, duration);
    };
    signal?.addEventListener("abort", abort, { once: true });
    next();
  });
}
module.exports = {
  cancelled,
  isCancelled,
  throwIfAborted,
  combineSignals,
  sleep,
};
