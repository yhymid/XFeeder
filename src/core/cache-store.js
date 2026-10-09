"use strict";

const fs = require("fs");

function createCacheStore(cacheFile = "./cache.json") {
  let cache = {};
  const META_KEY = "__xfeeder";

  function load() {
    if (!fs.existsSync(cacheFile)) {
      cache = {};
      return cache;
    }

    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      const channelCount = Object.keys(cache).filter((key) => key !== META_KEY).length;
      console.log(`[Cache] Loaded (${channelCount} channels)`);
    } catch {
      console.warn("[Cache] Error reading cache.json — creating new.");
      cache = {};
    }

    return cache;
  }

  function save() {
    const tempFile = `${cacheFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tempFile, cacheFile);
  }

  function getState() {
    return cache;
  }

  function getChannelBucket(index) {
    if (!cache[index]) cache[index] = {};
    return cache[index];
  }

  function replaceState(next) {
    cache = next && typeof next === "object" ? next : {};
    return cache;
  }

  function getFeedValidator(feedUrl) {
    const snapshot = cache?.[META_KEY]?.feedSnapshots?.[feedUrl];
    if (!snapshot || typeof snapshot !== "object") return null;
    return {
      etag: String(snapshot.etag || ""),
      lastModified: String(snapshot.lastModified || ""),
    };
  }

  function getFeedItems(feedUrl) {
    const items = cache?.[META_KEY]?.feedSnapshots?.[feedUrl]?.items;
    return Array.isArray(items) ? [...items] : [];
  }

  function setFeedSnapshot(feedUrl, validator, items, { persist = true } = {}) {
    if (typeof feedUrl !== "string" || !feedUrl.trim()) return false;
    const current = cache?.[META_KEY]?.feedSnapshots?.[feedUrl] || {};
    const next = {
      etag: String(validator?.etag || ""),
      lastModified: String(validator?.lastModified || ""),
      items: Array.isArray(items) ? items : [],
    };
    const unchanged = next.etag === current.etag &&
      next.lastModified === current.lastModified &&
      JSON.stringify(next.items) === JSON.stringify(current.items || []);
    if (unchanged) return false;

    if (!cache[META_KEY] || typeof cache[META_KEY] !== "object") cache[META_KEY] = {};
    if (!cache[META_KEY].feedSnapshots || typeof cache[META_KEY].feedSnapshots !== "object") {
      cache[META_KEY].feedSnapshots = {};
    }
    if (!next.etag && !next.lastModified) {
      delete cache[META_KEY].feedSnapshots[feedUrl];
    } else {
      cache[META_KEY].feedSnapshots[feedUrl] = next;
    }
    if (persist) save();
    return true;
  }

  load();

  return {
    load,
    save,
    getState,
    getChannelBucket,
    getFeedValidator,
    getFeedItems,
    setFeedSnapshot,
    replaceState,
  };
}

module.exports = {
  createCacheStore,
};
