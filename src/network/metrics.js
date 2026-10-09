"use strict";
const { performance } = require("node:perf_hooks");

// Fixed-size, one-second aggregation buckets. No per-chunk events or timers.
class NetworkMetrics {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.started = now();
    this.totals = {
      downloadedBytes: 0,
      uploadedBytes: 0,
      unshapedUploadBytes: 0,
    };
    this.buckets = Array.from({ length: 5 }, () => ({
      second: -1,
      download: 0,
      upload: 0,
    }));
  }
  record(direction, bytes, shaped = true) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError("Invalid byte count");
    const second = Math.floor(this.now() / 1000);
    const bucket = this.buckets[second % this.buckets.length];
    if (bucket.second !== second)
      Object.assign(bucket, { second, download: 0, upload: 0 });
    bucket[direction] += bytes;
    this.totals[
      direction === "download" ? "downloadedBytes" : "uploadedBytes"
    ] += bytes;
    if (direction === "upload" && !shaped)
      this.totals.unshapedUploadBytes += bytes;
  }
  snapshot() {
    const now = this.now(),
      second = Math.floor(now / 1000);
    const recent = this.buckets.filter(
      (b) => second - b.second >= 0 && second - b.second < 5,
    );
    const seconds = Math.max(1, Math.min(5, (now - this.started) / 1000));
    return {
      ...this.totals,
      downloadBytesPerSecond:
        recent.reduce((sum, b) => sum + b.download, 0) / seconds,
      uploadBytesPerSecond:
        recent.reduce((sum, b) => sum + b.upload, 0) / seconds,
      rateWindowSeconds: 5,
    };
  }
}
module.exports = { NetworkMetrics };
