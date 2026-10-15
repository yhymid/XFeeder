"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { versionTuple, withinCaret, checkDependencies } = require("./check-dependencies.cjs");

function compareVersions(a, b) {
  const left = versionTuple(a), right = versionTuple(b);
  if (!left || !right) throw new Error("Only exact stable semver x.y.z versions are supported");
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  }
  return 0;
}

function planUpgrade(manifest, lock, dependency, requested) {
  if (!Object.hasOwn(manifest.dependencies || {}, dependency))
    throw new Error("Only existing direct Node dependencies may be upgraded");
  if (!/^[A-Za-z0-9@/_-]+$/.test(dependency))
    throw new Error("Unexpected dependency name");
  const target = versionTuple(requested);
  if (!target || requested !== target.join("."))
    throw new Error("Target must be a stable, exact x.y.z version");
  const spec = manifest.dependencies[dependency];
  if (!withinCaret(spec, requested))
    throw new Error("Upgrade is outside the existing caret range; review major upgrades separately");
  const installed = lock.packages?.["node_modules/" + dependency]?.version;
  if (!installed || compareVersions(requested, installed) <= 0)
    throw new Error("Target version must be newer than the installed locked version");
  return { dependency, from: installed, to: requested };
}

function refresh({ root = path.resolve(__dirname, ".."),
  args = process.argv.slice(2), execute = spawnSync } = {}) {
  if (args.length !== 2) throw new Error("Usage: npm run deps:refresh -- <direct-dependency> <exact-patch-or-minor-version>");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const plan = planUpgrade(manifest, lock, args[0], args[1]);
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = [
    "install", "--package-lock-only", "--ignore-scripts",
    "--no-audit", "--no-fund", "--save", "--save-prefix=^",
    plan.dependency + "@" + plan.to,
  ];
  const result = execute(cmd, commandArgs, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("npm lockfile refresh failed; inspect the working tree");
  // Do not commit if npm changed packages in an unexpected way.
  const checks = checkDependencies(root);
  if (!checks.ok) throw new Error("Lockfile verification failed:\n" + checks.errors.join("\n"));
  return plan;
}

if (require.main === module) {
  try {
    const plan = refresh();
    console.log("[Dependencies] Refreshed " + plan.dependency + " " + plan.from + " -> " + plan.to);
    console.log("[Dependencies] Review package-lock.json; then run npm ci, npm test and npm audit --audit-level=high.");
  } catch (error) {
    console.error("[Dependencies] " + error.message);
    process.exitCode = 1;
  }
}

module.exports = { compareVersions, planUpgrade, refresh };
