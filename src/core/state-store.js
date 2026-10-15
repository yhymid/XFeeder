"use strict";

const path = require("node:path");
const { createCacheStore } = require("./cache-store");

function defaultFeedStatePath(cachePath) {
  const parts = path.parse(cachePath);
  return path.join(parts.dir, `${parts.name}.feeds.json`);
}

function createStateStore({
  cachePath = "./cache.json",
  feedStatePath = defaultFeedStatePath(cachePath),
  persistMigration = true,
} = {}) {
  if (path.resolve(cachePath) === path.resolve(feedStatePath))
    throw new Error("Feed state must not share the delivery cache path");

  const delivery = createCacheStore(cachePath);
  const feedCache = createCacheStore(feedStatePath);
  const runtime = new Map();
  const events = [];
  const MAX_EVENTS = 1000;

  function getSnapshots(cache) {
    const value = cache?.__xfeeder?.feedSnapshots;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value : null;
  }

  const deliveryData = delivery.getState();
  const legacy = getSnapshots(deliveryData);
  if (legacy && persistMigration) {
    const feedData = feedCache.getState();
    feedData.__xfeeder ||= {};
    feedData.__xfeeder.feedSnapshots ||= {};
    const next = feedData.__xfeeder.feedSnapshots;
    let added = false;
    for (const [url, snapshot] of Object.entries(legacy)) {
      // Prefer the separate feed-state copy if a previous migration was
      // interrupted after writing it. Never replace newer feed snapshots.
      if (Object.hasOwn(next, url)) continue;
      next[url] = structuredClone(snapshot);
      added = true;
    }
    // Persist the separate store BEFORE changing the legacy delivery file.
    // A failed write keeps every original source snapshot intact.
    if (added) feedCache.save();
    delete deliveryData.__xfeeder.feedSnapshots;
    if (Object.keys(deliveryData.__xfeeder).length === 0)
      delete deliveryData.__xfeeder;
    delivery.save();
  }

  function getFeedState(feedUrl) {
    const data = getSnapshots(feedCache.getState())?.[feedUrl] ||
      getSnapshots(delivery.getState())?.[feedUrl];
    if (!data || typeof data !== "object") return null;
    return structuredClone(data);
  }

  function setFeedState(feedUrl, value, { persist = true } = {}) {
    if (typeof feedUrl !== "string" || !feedUrl.trim())
      throw new TypeError("Feed state requires a non-empty URL");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("Feed state requires an object");
    const state = feedCache.getState();
    state.__xfeeder ||= {};
    state.__xfeeder.feedSnapshots ||= {};
    state.__xfeeder.feedSnapshots[feedUrl] = structuredClone(value);
    if (persist) feedCache.save();
  }

  async function setFeedStateAsync(feedUrl, value, options = {}) {
    setFeedState(feedUrl, value, { ...options, persist: false });
    if (options.persist !== false) await feedCache.saveAsync();
  }

  async function setFeedSnapshotAsync(feedUrl, validator, items, options = {}) {
    const changed = setFeedSnapshotInMemory(feedUrl, validator, items);
    if (changed && options.persist !== false) await feedCache.saveAsync();
    return changed;
  }

  function setFeedSnapshotInMemory(feedUrl, validator, items) {
    const old = getFeedState(feedUrl) || {};
    const next = {
      etag: String(validator?.etag || ""),
      lastModified: String(validator?.lastModified || ""),
      items: Array.isArray(items) ? items : [],
    };
    if (next.etag === (old.etag || "") &&
        next.lastModified === (old.lastModified || "") &&
        JSON.stringify(next.items) === JSON.stringify(old.items || []))
      return false;
    setFeedState(feedUrl, next, { persist: false });
    return true;
  }

  const feeds = Object.freeze({
    getFeedState,
    setFeedState,
    setFeedStateAsync,
    setFeedSnapshotAsync,
    getFeedValidator(feedUrl) {
      const state = getFeedState(feedUrl);
      return state ? { etag: String(state.etag || ""), lastModified: String(state.lastModified || "") } : null;
    },
    getFeedItems(feedUrl) {
      const state = getFeedState(feedUrl);
      return Array.isArray(state?.items) ? state.items : [];
    },
    setFeedSnapshot(feedUrl, validator, items, { persist = true } = {}) {
      const changed = setFeedSnapshotInMemory(feedUrl, validator, items);
      if (changed && persist) feedCache.save();
      return changed;
    },
  });

  return Object.freeze({
    delivery,
    feeds,
    isUsable() {
      try {
        delivery.getState();
        feedCache.getState();
        return true;
      } catch {
        return false;
      }
    },
    runtime: Object.freeze({
      get(key) { return runtime.get(key); },
      set(key, value) { runtime.set(key, structuredClone(value)); },
      delete(key) { return runtime.delete(key); },
      snapshot() { return Object.fromEntries(
        [...runtime].map(([key, value]) => [key, structuredClone(value)])); },
      appendEvent(event) {
        events.push(structuredClone(event));
        if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
      },
      events() { return structuredClone(events); },
      prune() { events.splice(0, events.length); },
    }),
    feedStatePath,
    save() {
      // Legacy synchronous contract for migration tools and older callers.
      delivery.save();
      feedCache.save();
    },
    async saveAsync() {
      // Delivery must finish before the optional feed snapshot flush.
      await delivery.saveAsync();
      await feedCache.saveAsync();
    },
    async flush() {
      await delivery.flush();
      await feedCache.flush();
    },
  });
}

module.exports = { createStateStore, defaultFeedStatePath };
