"use strict";
// Local, fixed payload benchmark. Each scenario gets a fresh process and GC.
const { execFileSync, fork } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const http = require("node:http");
const { once } = require("node:events");
const axios = require("axios");
const { getHttpClient } = require("../src/client");
const { resetNetwork } = require("../src/network/service");
const { createDefaultParser } = require("../src/core/feed-pipeline");
// Keep the original short workload for comparison. The optional steady mode
// gives the buffered path enough requests to finish background JIT compilation.
const steadyBuffered = process.argv.includes("--steady");
const feedPayload = Buffer.from(
  '<?xml version="1.0"?><rss version="2.0"><channel>' +
  '<title>Local fixture</title><link>http://127.0.0.1/</link><description>Benchmark</description>' +
  Array.from({ length: 100 }, (_, i) =>
    `<item><title>Item ${i}</title><link>http://127.0.0.1/${i}</link>` +
    `<guid>${i}</guid><description>${"Fixed local feed content. ".repeat(80)}</description></item>`,
  ).join("") + '</channel></rss>',
);
const cases = {
  baseline: { bytes: 16 * 1024 * 1024, count: 3, rounds: 8, warmup: 4 },
  unlimited: { bytes: 16 * 1024 * 1024, count: 3, rounds: 8, warmup: 4 },
  "baseline-buffered": {
    bytes: 256 * 1024, count: 3,
    rounds: steadyBuffered ? 1024 : 256,
    warmup: steadyBuffered ? 512 : 32,
    buffered: true,
  },
  "unlimited-buffered": {
    bytes: 256 * 1024, count: 3,
    rounds: steadyBuffered ? 1024 : 256,
    warmup: steadyBuffered ? 512 : 32,
    buffered: true,
  },
  "baseline-feed": {
    bytes: feedPayload.length, count: 3, rounds: 32, warmup: 4, feed: true,
  },
  "unlimited-feed": {
    bytes: feedPayload.length, count: 3, rounds: 32, warmup: 4, feed: true,
  },
  potato: {
    bytes: 5000,
    count: 1,
    network: { bandwidthProfile: "potato" },
    expected: 0.01,
  },
  medium: {
    bytes: 1024 * 1024,
    count: 3,
    network: { bandwidthProfile: "medium" },
    expected: 10,
  },
  "custom-upload": {
    bytes: 2,
    count: 3,
    upload: 20000,
    network: {
      bandwidthProfile: "custom",
      downloadLimitMbps: 2,
      uploadLimitMbps: 0.2,
    },
    expectedUpload: 0.2,
  },
  custom: {
    bytes: 50000,
    count: 3,
    upload: 10000,
    network: {
      bandwidthProfile: "custom",
      downloadLimitMbps: 2,
      uploadLimitMbps: 0.2,
    },
    expected: 2,
    expectedUpload: 0.2,
  },
};
async function run(name) {
  const c = cases[name];
  if (!c) throw new Error(`Unknown scenario: ${name}`);
  resetNetwork();
  // The fixture has its own process: CPU and memory below belong to the client.
  const server = fork(__filename, ["--server", c.feed ? "feed" : String(c.bytes)], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const url = await new Promise((resolve, reject) => {
    const failed = (error) => {
      cleanup();
      server.kill();
      reject(error instanceof Error
        ? error : new Error("Fixture exited before listening"));
    };
    const ready = (address) => {
      cleanup();
      resolve(address);
    };
    const timer = setTimeout(
      () => failed(new Error("Fixture startup timed out")), 10000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      server.removeListener("error", failed);
      server.removeListener("exit", failed);
      server.removeListener("message", ready);
    };
    server.once("error", failed);
    server.once("exit", failed);
    server.once("message", ready);
  });
  const managed = getHttpClient("unused", {
    Proxy: { Enabled: false },
    network: c.network || {},
  });
  // Keep headers, timeouts and Axios defaults equal; only the adapter differs.
  const client =
    name.startsWith("baseline")
      ? axios.create({ ...managed.defaults, adapter: axios.getAdapter("http") })
      : managed;
  const parser = c.feed ? createDefaultParser() : null;
  async function request() {
    const response = await client.request({
      url,
      proxy: false,
      method: c.upload ? "POST" : "GET",
      data: c.upload ? Buffer.alloc(c.upload) : undefined,
      responseType: c.feed ? "text" : c.buffered ? "arraybuffer" : "stream",
    });
    let bytes = 0;
    if (c.feed) {
      bytes = Buffer.byteLength(response.data);
      const feed = await parser.parseString(response.data);
      if (feed.items.length !== 100 || feed.items[99].guid !== "99")
        throw new Error("Unexpected parsed feed");
    } else if (c.buffered) bytes = response.data.length;
    else for await (const chunk of response.data) bytes += chunk.length;
    if (bytes !== c.bytes) throw new Error("Unexpected byte count");
  }
  const batch = () => Promise.all(Array.from({ length: c.count }, request));
  let sample;
  try {
    // Repeated warmup and a longer fixed workload reduce startup and JIT noise.
    for (let i = 0; i < (c.warmup || 0); i++) await batch();
    global.gc?.();
    const memory = process.memoryUsage(),
      cpu = process.cpuUsage(),
      start = performance.now();
    let peakRss = memory.rss;
    sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 10);
    for (let i = 0; i < (c.rounds || 1); i++) await batch();
    const elapsedMs = performance.now() - start,
      used = process.cpuUsage(cpu);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const requests = c.count * (c.rounds || 1);
    const actualMbps = (c.bytes * requests * 8) / (elapsedMs * 1000);
    return {
      name,
      requests,
      warmupRequests: c.count * (c.warmup || 0),
      responseBytes: c.bytes,
      responseType: c.feed ? "text + rss-parser" : c.buffered ? "arraybuffer" : "stream",
      configuredDownloadMbps:
        c.network?.bandwidthProfile === "custom"
          ? c.network.downloadLimitMbps
          : (c.expected ?? null),
      configuredUploadMbps: c.expectedUpload ?? null,
      actualDownloadMbps: +actualMbps.toFixed(4),
      actualUploadMbps: c.upload
        ? +((c.upload * c.count * 8) / (elapsedMs * 1000)).toFixed(4)
        : 0,
      deviationPercent: c.expected
        ? +((actualMbps / c.expected - 1) * 100).toFixed(2)
        : null,
      uploadDeviationPercent: c.expectedUpload
        ? +(
            ((c.upload * c.count * 8) / (elapsedMs * 1000) / c.expectedUpload -
              1) *
            100
          ).toFixed(2)
        : null,
      elapsedMs: +elapsedMs.toFixed(2),
      cpuMs: +((used.user + used.system) / 1000).toFixed(2),
      cpuMsPerRequest: +((used.user + used.system) / 1000 / requests).toFixed(4),
      peakRssDeltaMiB: +((peakRss - memory.rss) / 1048576).toFixed(2),
      heapDeltaMiB: +(
        (process.memoryUsage().heapUsed - memory.heapUsed) /
        1048576
      ).toFixed(2),
      note: c.upload
        ? "Download and upload rates averaged across combined request duration"
        : "Client CPU only; separate fixture process; RSS sampled every 10ms",
    };
  } finally {
    clearInterval(sample);
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "exit");
      server.kill();
      await stopped;
    }
  }
}
if (process.argv[2] === "--server") {
  const payload = process.argv[3] === "feed"
    ? feedPayload : Buffer.alloc(Number(process.argv[3]), 0x61);
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { }
    res.end(payload);
  });
  server.listen(0, "127.0.0.1", () => {
    process.send(`http://127.0.0.1:${server.address().port}`);
  });
  process.once("disconnect", () => process.exit());
} else if (process.argv[2] && process.argv[2] !== "--steady")
  run(process.argv[2])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
else {
  const sample = (name) => {
    const output = execFileSync(
      process.execPath,
      ["--expose-gc", __filename, name, ...(steadyBuffered ? ["--steady"] : [])],
      { encoding: "utf8" },
    );
    return JSON.parse(output.trim().split("\n").at(-1));
  };
  const groups = {
    baseline: [], unlimited: [],
    "baseline-buffered": [], "unlimited-buffered": [],
    "baseline-feed": [], "unlimited-feed": [],
  };
  // Alternate order to reduce host load / CPU frequency bias between groups.
  for (let round = 0; round < 6; round++) {
    for (const name of round % 2
      ? Object.keys(groups).reverse()
      : Object.keys(groups))
      groups[name].push(sample(name));
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const i = Math.floor(sorted.length / 2);
    return (sorted[i] + sorted[i - 1]) / 2;
  };
  const rows = Object.keys(cases).map((name) => {
    if (!groups[name]) return sample(name);
    const samples = groups[name];
    const result = { ...samples[0] };
    for (const key of [
      "elapsedMs",
      "cpuMs",
      "cpuMsPerRequest",
      "peakRssDeltaMiB",
      "heapDeltaMiB",
      "actualDownloadMbps",
    ])
      result[key] = +median(samples.map((s) => s[key])).toFixed(4);
    result.elapsedRangeMs = [
      Math.min(...samples.map((s) => s.elapsedMs)),
      Math.max(...samples.map((s) => s.elapsedMs)),
    ];
    result.cpuRangeMs = [
      Math.min(...samples.map((s) => s.cpuMs)),
      Math.max(...samples.map((s) => s.cpuMs)),
    ];
    return result;
  });
  console.log(
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        benchmarkVersion: 3,
        mode: steadyBuffered ? "steady-buffered" : "standard",
        rows,
        samples: groups,
        unlimitedElapsedOverheadPercent: +(
          (rows[1].elapsedMs / rows[0].elapsedMs - 1) *
          100
        ).toFixed(2),
        unlimitedCpuOverheadPercent: +(
          (rows[1].cpuMs / rows[0].cpuMs - 1) *
          100
        ).toFixed(2),
        bufferedElapsedOverheadPercent: +(
          (rows[3].elapsedMs / rows[2].elapsedMs - 1) * 100
        ).toFixed(2),
        bufferedCpuOverheadPercent: +(
          (rows[3].cpuMs / rows[2].cpuMs - 1) * 100
        ).toFixed(2),
        bufferedCpuOverheadMsPerRequest: +(
          rows[3].cpuMsPerRequest - rows[2].cpuMsPerRequest
        ).toFixed(4),
        feedElapsedOverheadPercent: +(
          (rows[5].elapsedMs / rows[4].elapsedMs - 1) * 100
        ).toFixed(2),
        feedCpuOverheadPercent: +(
          (rows[5].cpuMs / rows[4].cpuMs - 1) * 100
        ).toFixed(2),
        feedCpuOverheadMsPerRequest: +(
          rows[5].cpuMsPerRequest - rows[4].cpuMsPerRequest
        ).toFixed(4),
        notes:
          "Fixed loopback payloads; client CPU/memory only; same Axios defaults. Median of 6 interleaved fresh processes for each baseline/Unlimited pair (stream, buffered, RSS parse), after repeated warmup. Limited scenarios single sample. Custom rates include upload wait. Not a wire-level QoS benchmark.",
      },
      null,
      2,
    ),
  );
}
