"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function venvPaths(baseDir, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path;
  const directory = paths.resolve(baseDir, ".venv");
  const bin = paths.join(directory, platform === "win32" ? "Scripts" : "bin");
  return { directory, python: paths.join(bin, platform === "win32" ? "python.exe" : "python"),
    scrapling: paths.join(bin, platform === "win32" ? "scrapling.exe" : "scrapling") };
}
const PYTHON_INFO = `
import sys, sysconfig, json
try:
    from importlib.metadata import version
    scrapling = version("scrapling")
except ImportError:
    scrapling = None
scripts = [sysconfig.get_path("scripts")]
try:
    scripts.append(sysconfig.get_path("scripts", scheme=sysconfig.get_preferred_scheme("user")))
except (AttributeError, KeyError):
    pass
print(json.dumps(dict(version=list(sys.version_info[:3]), prefix=sys.prefix,
    basePrefix=getattr(sys, "base_prefix", sys.prefix), scripts=scripts, scrapling=scrapling)))
`;
function probePython(command, run = spawnSync) {
  const result = run(command, ["-c", PYTHON_INFO], {
    encoding: "utf8", timeout: 10000, windowsHide: true, shell: false,
  });
  if (result.error || result.status !== 0) return null;
  try {
    const info = JSON.parse(result.stdout);
    return Array.isArray(info.version) ? info : null;
  } catch { return null; }
}
function compatiblePython(info, minimumMinor = 11) {
  return info?.version?.[0] === 3 && info.version[1] >= minimumMinor;
}
module.exports = { venvPaths, probePython, compatiblePython };
