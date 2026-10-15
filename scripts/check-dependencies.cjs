"use strict";

const fs = require("node:fs");
const path = require("node:path");

function versionTuple(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function withinCaret(range, actual) {
  if (typeof range !== "string" || !range.startsWith("^")) return range === actual;
  const minimum = versionTuple(range.slice(1));
  const current = versionTuple(actual);
  if (!minimum || !current) return false;
  const [major, minor, patch] = current;
  const [minMajor, minMinor, minPatch] = minimum;
  if (major !== minMajor || (minMajor === 0 && minor !== minMinor)) return false;
  return minor > minMinor || (minor === minMinor && patch >= minPatch);
}

function validateNodeLock(manifest, lock) {
  const errors = [];
  if (lock.lockfileVersion !== 3) errors.push("Node lockfile must use lockfileVersion 3");
  const root = lock.packages?.[""];
  if (!root) return ["Node lockfile root entry is missing"];
  if (root.version !== manifest.version) errors.push("Node root package version differs");
  const expected = manifest.dependencies || {};
  const actual = root.dependencies || {};
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const name of keys) {
    if (expected[name] !== actual[name]) {
      errors.push("Node root dependency mismatch: " + name);
      continue;
    }
    const pkg = lock.packages["node_modules/" + name];
    if (!pkg) { errors.push("Node locked package missing: " + name); continue; }
    if (!withinCaret(expected[name], pkg.version)) {
      errors.push("Node locked version incompatible with manifest: " + name);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pkg.integrity || "")) {
      errors.push("Node locked integrity missing/invalid: " + name);
    }
    if (!/^https:\/\/registry\.npmjs\.org\//.test(pkg.resolved || "")) {
      errors.push("Node package registry URL missing/unexpected: " + name);
    }
  }
  return errors;
}

function validatePythonLock(requirements, lockText, verifyImport) {
  const errors = [];
  const requirement = requirements.trim().match(/^scrapling\[all\]==(\d+\.\d+\.\d+)$/);
  if (!requirement) errors.push("Python requirements.txt must pin scrapling[all] exactly");
  const versions = new Map();
  for (const line of lockText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const part = trimmed.split(";")[0].trim();
    const match = part.match(/^([A-Za-z0-9_.-]+)==([0-9]+(?:\.[0-9]+)*(?:[a-z0-9.-]+)?)$/i);
    if (!match) { errors.push("Python lockfile has an unpinned entry"); continue; }
    const normalized = match[1].toLowerCase().replace(/[-_.]+/g, "-");
    if (versions.has(normalized)) errors.push("Python duplicate lock entry: " + normalized);
    versions.set(normalized, match[2]);
  }
  const scrapling = versions.get("scrapling");
  if (!scrapling || scrapling !== requirement?.[1]) errors.push("Python Scrapling lock/requirements version mismatch");
  if (!scrapling || !verifyImport.includes('version("scrapling") == "' + scrapling + '"'))
    errors.push("Python installer verification version mismatch");
  for (const name of ["playwright", "patchright"]) {
    if (!versions.has(name)) errors.push("Python lock is missing " + name);
  }
  return errors;
}

function checkDependencies(root = path.resolve(__dirname, "..")) {
  const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const { VERIFY_IMPORT } = require("./install-scrapling.cjs");
  const pythonLock = read("src/extensions/Scrapling/requirements.lock.txt");
  const errors = [
    ...validateNodeLock(manifest, lock),
    ...validatePythonLock(
      read("src/extensions/Scrapling/requirements.txt"),
      pythonLock,
      VERIFY_IMPORT,
    ),
  ];
  return {
    ok: errors.length === 0,
    errors,
    packages: Object.keys(manifest.dependencies || {}).length,
    pythonPins: pythonLock.split(/\r?\n/)
      .filter(line => line.trim() && !line.trim().startsWith("#")).length,
  };
}

if (require.main === module) {
  try {
    const result = checkDependencies();
    if (!result.ok) {
      for (const problem of result.errors) console.error("[Dependency Check] " + problem);
      process.exitCode = 1;
    } else console.log("[Dependency Check] OK: " + result.packages + " Node direct packages, " + result.pythonPins + " pinned Python packages.");
  } catch (error) {
    console.error("[Dependency Check]", error.message);
    process.exitCode = 1;
  }
}

module.exports = { versionTuple, withinCaret, validateNodeLock, validatePythonLock, checkDependencies };
