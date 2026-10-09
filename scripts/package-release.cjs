"use strict";
// Archive a reviewed Git ref, never the developer's working directory.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const ref = process.argv[2] || "HEAD";
const git = (...args) => execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
const pkg = JSON.parse(git("show", `${ref}:package.json`));
if (pkg.name !== "xfeeder" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw Error("Not a versioned XFeeder source tree");
const entries = git("ls-tree", "-rlz", ref).toString().split("\0").filter(Boolean);
const files = entries.map(entry => entry.slice(entry.indexOf("\t") + 1));
const forbidden = files.filter((file, index) => {
  const parts = file.split("/"), base = parts.at(-1);
  return !entries[index].startsWith("100") ||
    parts.some(p => [".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", "coverage", "playwright-report", "test-results", "benchmark-results", "release-artifacts", "ms-playwright", ".cache"].includes(p)) ||
    (base.startsWith(".env") && base !== ".env.example") ||
    ["config.json", "cache.json", "http-meta.json"].includes(file) ||
    /(?:\.py[cod]|\.log|\.tmp|\.temp|\.cpuprofile|\.heapprofile|\.network-runtime\.json)$/.test(file) ||
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
const output = path.resolve(process.argv[3] || `release-artifacts/XFeeder-${pkg.version}.tar.gz`);
const tar = git("archive", "--format=tar", `--prefix=XFeeder-${pkg.version}/`, ref);
const compressed = gzipSync(tar, { level: 9 });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, compressed);
const sizes = entries.map(entry => {
  const [mode, type, hash, size] = entry.slice(0, entry.indexOf("\t")).split(/\s+/);
  return { path: entry.slice(entry.indexOf("\t") + 1), bytes: Number(size) };
});
console.log(JSON.stringify({ version: pkg.version, ref, files: files.length,
  sourceBytes: sizes.reduce((sum, file) => sum + file.bytes, 0),
  archiveBytes: compressed.length, output,
  largestFiles: sizes.sort((a,b) => b.bytes - a.bytes).slice(0,10),
}, null, 2));
