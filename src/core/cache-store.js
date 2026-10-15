"use strict";

const fs = require("fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createCacheStore(cacheFile = "./cache.json") {
  let cache = {};
  const META_KEY = "__xfeeder";

  let blockedError = null;
  let saveSequence = 0;
  let pendingSave = Promise.resolve();
  function assertUsable() {
    if (blockedError) throw blockedError;
  }
  function block(message, cause) {
    blockedError = Object.assign(new Error(message, { cause }), { code: "CACHE_UNSAFE" });
    console.error(`[Cache] ${message}`);
    throw blockedError;
  }

  function load() {
    let original;
    try {
      original = fs.readFileSync(cacheFile);
    } catch (error) {
      if (error.code !== "ENOENT")
        return block(`Cannot read ${cacheFile}; refusing to start or overwrite delivery state.`, error);
      const directory = path.dirname(path.resolve(cacheFile));
      const prefix = `${path.basename(cacheFile)}.corrupt-`;
      if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith(prefix)))
        return block(`Missing ${cacheFile} with quarantined state present; restore a verified cache before restarting.`, error);
      assertUsable();
      cache = {};
      return cache;
    }

    let parsed;
    try {
      parsed = JSON.parse(original.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Cache root must be an object");
    } catch (error) {
      // Stable content identity prevents a restart loop from creating unlimited
      // copies. The original file is never renamed, removed or replaced.
      const quarantine = `${cacheFile}.corrupt-${crypto.createHash("sha256").update(original).digest("hex")}`;
      try {
        fs.writeFileSync(quarantine, original, { flag: "wx", mode: 0o600 });
      } catch (copyError) {
        if (copyError.code !== "EEXIST")
          return block(`Invalid ${cacheFile}; quarantine could not be preserved. Original retained; startup blocked.`, copyError);
        let existing;
        try { existing = fs.readFileSync(quarantine); }
        catch (readError) {
          return block(`Invalid ${cacheFile}; existing quarantine cannot be verified. Startup blocked.`, readError);
        }
        if (!existing.equals(original))
          return block(`Invalid ${cacheFile}; quarantine collision. Original retained; startup blocked.`, copyError);
      }
      return block(`Invalid ${cacheFile}; original retained and quarantined at ${quarantine}. Restore a verified cache before restarting; delivery is blocked to prevent duplicates.`, error);
    }

    blockedError = null;
    cache = parsed;
    const channelCount = Object.keys(cache).filter(key => key !== META_KEY).length;
    console.log(`[Cache] Loaded (${channelCount} channels)`);
    return cache;
  }

  function save() {
    assertUsable();
    const tempFile = `${cacheFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tempFile, cacheFile);
  }

  // Serialize whole snapshots at invocation time. A later destination
  // success must never overwrite a newer snapshot with an older write.
  async function saveAsync() {
    assertUsable();
    const snapshot = JSON.stringify(cache, null, 2);
    const job = pendingSave.then(async () => {
      assertUsable();
      const directory = path.dirname(path.resolve(cacheFile));
      const temporary = path.join(directory,
        `${path.basename(cacheFile)}.${process.pid}.${++saveSequence}.${crypto.randomBytes(6).toString("hex")}.tmp`);
      let handle;
      try {
        handle = await fs.promises.open(temporary, "wx", 0o600);
        await handle.writeFile(snapshot, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.promises.rename(temporary, cacheFile);
        // The rename is atomic on the same filesystem; sync the parent
        // directory so the directory entry survives a host crash on
        // filesystems that support directory fsync.
        let directoryHandle;
        try {
          directoryHandle = await fs.promises.open(directory, "r");
          await directoryHandle.sync();
        } catch (error) {
          if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF", "EPERM"].includes(error?.code))
            throw error;
        } finally {
          if (directoryHandle) await directoryHandle.close();
        }
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.promises.unlink(temporary).catch(() => {});
        block(`Cannot persist ${cacheFile}; delivery state is now unsafe. Refusing further operation.`, error);
      }
    });
    // Drain rejected writes too, but the fail-closed latch above prevents
    // any subsequent write or read from silently continuing.
    pendingSave = job.catch(() => {});
    return job;
  }

  async function flush() {
    await pendingSave;
    assertUsable();
  }

  function getState() {
    assertUsable();
    return cache;
  }

  function getChannelBucket(index) {
    assertUsable();
    if (!cache[index]) cache[index] = {};
    return cache[index];
  }

  function replaceState(next) {
    assertUsable();
    cache = next && typeof next === "object" ? next : {};
    return cache;
  }

  function getFeedValidator(feedUrl) {
    assertUsable();
    const snapshot = cache?.[META_KEY]?.feedSnapshots?.[feedUrl];
    if (!snapshot || typeof snapshot !== "object") return null;
    return {
      etag: String(snapshot.etag || ""),
      lastModified: String(snapshot.lastModified || ""),
    };
  }

  function getFeedItems(feedUrl) {
    assertUsable();
    const items = cache?.[META_KEY]?.feedSnapshots?.[feedUrl]?.items;
    return Array.isArray(items) ? [...items] : [];
  }

  function setFeedSnapshot(feedUrl, validator, items, { persist = true } = {}) {
    assertUsable();
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
    saveAsync,
    flush,
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
