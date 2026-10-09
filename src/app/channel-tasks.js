"use strict";
const { runContext } = require("../network/context");
const { cancelled, isCancelled, throwIfAborted } = require("../network/abort");

class ChannelTasks {
  constructor() {
    this.active = new Map();
    this.states = new Map();
    this.stopping = false;
  }
  run(index, channel, fn) {
    const key = String(channel.cacheKey || channel.ID || channel.Key || index);
    if (this.active.has(key)) return this.active.get(key).promise;
    if (this.stopping)
      return Promise.reject(cancelled("Channel scheduling stopped"));
    const controller = new AbortController();
    const record = { controller, promise: null };
    const previous = this.states.get(key);
    const state = {
      key,
      status: "scheduled",
      reason: null,
      failures: previous?.failures || 0,
    };
    this.states.set(key, state);
    const waits = new Map();
    let nextWait = 0,
      failure;
    const onWaiting = (reason) => {
      const id = nextWait++;
      waits.set(id, reason);
      state.status = "waiting";
      state.reason = reason;
      return () => {
        waits.delete(id);
        if (state.status === "waiting") {
          state.status = waits.size ? "waiting" : "running";
          state.reason = waits.values().next().value || null;
        }
      };
    };
    const promise = Promise.resolve()
      .then(() =>
        runContext(
          {
            signal: controller.signal,
            onWaiting,
            onFailure: (error) => {
              failure ||= error;
            },
          },
          async () => {
            throwIfAborted(controller.signal);
            state.status = "running";
            const result = await fn(index, channel);
            throwIfAborted(controller.signal);
            if (failure) throw failure;
            return result;
          },
        ),
      )
      .then(
        (result) => {
          state.status = "completed";
          return result;
        },
        (error) => {
          state.status =
            isCancelled(error) || controller.signal.aborted
              ? "cancelled"
              : "failed";
          if (state.status === "failed") state.failures++;
          throw error;
        },
      )
      .finally(() => {
        state.reason = null;
        this.active.delete(key);
      });
    record.promise = promise;
    this.active.set(key, record);
    return promise;
  }
  stop() {
    this.stopping = true;
  }
  abort() {
    for (const record of this.active.values())
      record.controller.abort(cancelled("Channel shutdown deadline"));
  }
  idle() {
    return Promise.allSettled(
      Array.from(this.active.values(), (record) => record.promise),
    );
  }
  snapshot() {
    return Object.fromEntries(
      Array.from(this.states, ([key, state]) => [key, { ...state }]),
    );
  }
}
module.exports = { ChannelTasks };
