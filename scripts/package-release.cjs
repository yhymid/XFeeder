"use strict";
// Archive a reviewed Git ref, never the developer's working directory.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const ref = process.argv[2] || "HEAD";
const sourceOnly = process.argv[4] === "--source";
if (process.argv[4] && !sourceOnly) throw Error("Usage: package-release.cjs [ref] [output] [--source]");
const git = (...args) => execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
const pkg = JSON.parse(git("show", `${ref}:package.json`));
if (pkg.name !== "xfeeder" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw Error("Not a versioned XFeeder source tree");
const entries = git("ls-tree", "-rlz", ref).toString().split("\0").filter(Boolean);
const files = entries.map(entry => entry.slice(entry.indexOf("\t") + 1));
const forbidden = files.filter((file, index) => {
  const parts = file.split("/"), base = parts.at(-1);
  return !entries[index].startsWith("100") ||
    parts.some(p => [".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", "coverage", "playwright-report", "test-results", "benchmark-results", "release-artifacts", "ms-playwright", "browsers", ".local-browsers", ".cache", ".aws", ".ssh", ".codex", ".agents", ".direnv", "browser-profiles", "user-data-dir", ".auth"].includes(p)) ||
    [".npmrc", ".netrc", ".git-credentials", ".pypirc", ".envrc"].includes(base) ||
    ["secrets.json", "credentials.json", "auth.json"].includes(file) ||
    /\.(?:sqlite3?|db)(?:-(?:journal|shm|wal))?$/i.test(base) ||
    (/\.(?:pem|key|p12|pfx)$/i.test(base) && !["tests/fixtures/tls/localhost-test-key.pem", "tests/fixtures/tls/localhost-test-cert.pem"].includes(file)) ||
    (base.startsWith(".env") && base !== ".env.example") ||
    (["config.json", "cache.json", "http-meta.json"].includes(file) || /\.feeds\.json$/i.test(file)) ||
    /(?:\.py[cod]|\.log|\.tmp|\.temp|\.cpuprofile|\.heapprofile|\.network-runtime\.json)$/.test(file) ||
    /\.corrupt-/.test(base) ||
    /^debug\/.*\.txt$/.test(file) || file.startsWith("src/extensions/Scrapling/upstream/");
});
if (forbidden.length) throw Error(`Generated/private files tracked in release: ${forbidden.join(", ")}`);
// Also enforce the actual repository ignore rules, including exceptions for fixtures/examples.
let ignored;
try {
  ignored = execFileSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], { input: files.join("\0") + "\0" }).toString();
} catch (error) {
  if (error.status !== 1) throw error;
  ignored = "";
}
if (ignored) throw Error(`Ignored files tracked in release: ${ignored.split("\0").filter(Boolean).join(", ")}`);
const prefix = `XFeeder-${pkg.version}/`;
const output = path.resolve(process.argv[3] || `release-artifacts/XFeeder-${pkg.version}-${sourceOnly ? "source" : "runtime"}.tar.gz`);
const runtimeRoots = new Set(["main.js", "dashboard.js", "package.json", "package-lock.json", "LICENSE", ".env.example", "config.json.example", "scripts/install-scrapling.cjs"]);
const selected = sourceOnly ? files : files.filter(file => runtimeRoots.has(file) ||
  (file.startsWith("src/") && (/\.(?:js|cjs|mjs|py|html|css|svg)$/.test(file) ||
    /^src\/extensions\/Scrapling\/requirements(?:\.lock)?\.txt$/.test(file))));
const generated = [];
if (!sourceOnly) {
  for (const required of runtimeRoots) if (!files.includes(required)) throw Error(`Missing runtime file: ${required}`);
  // Development commands must not refer to files omitted from the runtime package.
  const runtimePackage = { ...pkg, scripts: Object.fromEntries(Object.entries(pkg.scripts || {}).filter(([name]) =>
    ["start", "start:once", "start:dry-run", "start:expert-dry-run", "check-config", "dashboard", "scrapling:install", "scrapling:check"].includes(name))) };
  generated.push({ path: "package.json", data: Buffer.from(JSON.stringify(runtimePackage, null, 2) + "\n") });
  // This is a generated empty starter, never the developer's private config.json.
  generated.push({ path: "config.json", data: Buffer.from(JSON.stringify({ Settings: { Logs: false, DebugExpert: false }, channels: {} }, null, 2) + "\n") });
}
let tar = git("archive", "--format=tar", `--prefix=${prefix}`, ref, "--", ...selected.filter(file => !generated.some(item => item.path === file)));
if (generated.length) {
  let end = 0;
  while (end < tar.length && tar[end] !== 0) {
    const size = parseInt(tar.toString("ascii", end + 124, end + 136).replace(/\0/g, "").trim(), 8) || 0;
    end += 512 + Math.ceil(size / 512) * 512;
  }
  const extra = generated.flatMap(({ path: name, data }) => {
    const header = Buffer.alloc(512);
    const fullName = prefix + name;
    if (Buffer.byteLength(fullName) > 100) throw Error("Generated archive path too long");
    header.write(fullName);
    for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) {
      header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset);
    }
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257); header.write("00", 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    return [header, data, Buffer.alloc((512 - data.length % 512) % 512)];
  });
  tar = Buffer.concat([tar.subarray(0, end), ...extra, Buffer.alloc(1024)]);
}
const compressed = gzipSync(tar, { level: 9 });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, compressed);
const sizes = entries.filter(entry => selected.includes(entry.slice(entry.indexOf("\t") + 1)) &&
  !generated.some(item => item.path === entry.slice(entry.indexOf("\t") + 1))).map(entry => {
  const [mode, type, hash, size] = entry.slice(0, entry.indexOf("\t")).split(/\s+/);
  return { path: entry.slice(entry.indexOf("\t") + 1), bytes: Number(size) };
});
sizes.push(...generated.map(item => ({ path: item.path, bytes: item.data.length })));
console.log(JSON.stringify({ version: pkg.version, ref, kind: sourceOnly ? "source" : "runtime", files: sizes.length,
  sourceBytes: sizes.reduce((sum, file) => sum + file.bytes, 0),
  archiveBytes: compressed.length, output,
  largestFiles: sizes.sort((a,b) => b.bytes - a.bytes).slice(0,10),
}, null, 2));
