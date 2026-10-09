"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const storage = new AsyncLocalStorage();
function context() {
  return storage.getStore() || {};
}
function waiting(promise, reason) {
  const current = storage.getStore();
  if (!current?.onWaiting) return promise;
  return trackedWaiting(promise, current, reason);
}
async function trackedWaiting(promise, current, reason) {
  const done = current.onWaiting(reason);
  try {
    return await promise;
  } finally {
    done?.();
  }
}
module.exports = {
  context,
  waiting,
  runContext: (value, fn) => storage.run(value, fn),
};
