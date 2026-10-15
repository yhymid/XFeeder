"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { checkDependencies, withinCaret, validateNodeLock, validatePythonLock } = require("../scripts/check-dependencies.cjs");
const { planUpgrade, compareVersions, refresh } = require("../scripts/refresh-dependency.cjs");

const root = path.resolve(__dirname, "..");

test("X3 dependencies: committed npm and Python locks are mutually consistent", () => {
  const report = checkDependencies(root);
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
  assert.equal(report.packages, Object.keys(require("../package.json").dependencies).length);
  assert.ok(report.pythonPins > 50);
});

test("X3 dependencies: caret range respects 0.x minor boundaries", () => {
  assert.equal(withinCaret("^1.12.2", "1.20.0"), true);
  assert.equal(withinCaret("^1.12.2", "1.12.1"), false);
  assert.equal(withinCaret("^1.12.2", "2.0.0"), false);
  assert.equal(withinCaret("^0.6.2", "0.6.8"), true);
  assert.equal(withinCaret("^0.6.2", "0.7.0"), false);
  assert.equal(withinCaret("^0.0.4", "0.0.4"), true);
  assert.equal(withinCaret("^0.0.4", "0.0.5"), false);
  assert.equal(withinCaret("1.16.0", "1.16.0"), true);
  assert.equal(withinCaret("1.16.0", "1.16.1"), false);
});

test("X3 dependencies: reject mismatched npm manifest, integrity and missing lock entries", () => {
  const manifest = { version: "2.2.0", dependencies: { alpha: "^1.0.0" } };
  const lock = { lockfileVersion: 3, packages: { "": { version: "2.2.0",
    dependencies: { alpha: "^1.0.0" } },
    "node_modules/alpha": { version: "1.1.0", integrity: "sha512-YWJjZA==",
      resolved: "https://registry.npmjs.org/alpha/-/alpha-1.1.0.tgz" },
  } };
  assert.deepEqual(validateNodeLock(manifest, lock), []);
  assert.match(validateNodeLock({ ...manifest, dependencies: { alpha: "^2.0.0" } }, lock).join("\n"), /root dependency mismatch/);
  assert.match(validateNodeLock(manifest, { ...lock, packages: { ...lock.packages,
    "node_modules/alpha": { ...lock.packages["node_modules/alpha"], integrity: "" },
  } }).join("\n"), /integrity/);
  assert.match(validateNodeLock(manifest, { ...lock, packages: { "": lock.packages[""] } }).join("\n"), /missing/);
});

test("X3 dependencies: Python pins must match requirements and installer validation", () => {
  const requirement = "scrapling[all]==0.4.15\n";
  const ok = "scrapling==0.4.15\nplaywright==1.63.0\npatchright==1.63.0\n";
  const verify = 'assert version("scrapling") == "0.4.15"';
  assert.deepEqual(validatePythonLock(requirement, ok, verify), []);
  assert.match(validatePythonLock(requirement.replace("0.4.15", "0.5.0"), ok, verify).join("\n"), /Scrapling lock/);
  assert.match(validatePythonLock(requirement, ok.replace("patchright==1.63.0", "patchright>=1.63"), verify).join("\n"), /unpinned/);
  assert.match(validatePythonLock(requirement, ok + "Scrapling==0.4.15\n", verify).join("\n"), /duplicate/);
  assert.match(validatePythonLock(requirement, ok, "wrong").join("\n"), /installer/);
});

test("X3 dependencies: patch/minor upgrade planner rejects majors, unknown packages and downgrades", () => {
  const manifest = { dependencies: { alpha: "^1.12.2", xml2js: "^0.6.2" } };
  const lock = { packages: { "node_modules/alpha": { version: "1.16.0" },
    "node_modules/xml2js": { version: "0.6.2" },
  } };
  assert.deepEqual(planUpgrade(manifest, lock, "alpha", "1.16.1"),
    { dependency: "alpha", from: "1.16.0", to: "1.16.1" });
  assert.equal(compareVersions("1.12.4", "1.12.3"), 1);
  assert.equal(compareVersions("1.12.3", "1.12.4"), -1);
  for (const [name, version] of [
    ["alpha", "2.0.0"], ["xml2js", "0.7.0"], ["alpha", "1.15.0"],
    ["alpha", "1.16.0"], ["alpha", "latest"], ["not-installed", "1.2.3"],
    ["alpha", "1.16.2-rc.1"], ["alpha", "--prefix=/etc"],
  ]) assert.throws(() => planUpgrade(manifest, lock, name, version));
});

test("X3 dependencies: refresh command disables scripts, treats arguments literally, and never pushes", () => {
  const call = [];
  const before = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
  const plan = refresh({ root, args: ["follow-redirects", "1.16.1"],
    execute(command, args, options) {
      call.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(plan.dependency, "follow-redirects");
  assert.equal(call.length, 1);
  assert.deepEqual(call[0].args.slice(0, 4),
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit"]);
  assert.equal(call[0].options.shell, false);
  assert.equal(call[0].options.cwd, root);
  assert.equal(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"), before);
});
