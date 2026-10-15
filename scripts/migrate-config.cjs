"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { migrateConfig, ConfigMigrationError } = require("../src/core/config-migration");

function parseArgs(argv = []) {
  const options = { configPath: "./config.json", write: false, inPlace: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--in-place") options.inPlace = true;
    else if (arg === "--config" && argv[i + 1]) options.configPath = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error("Unknown or incomplete migration argument");
  }
  if (options.inPlace && !options.write)
    throw new Error("--in-place requires --write");
  return options;
}

function writeExclusive(file, contents) {
  const directory = path.dirname(file);
  const temp = path.join(directory, "." + path.basename(file) + "." + process.pid +
    "." + crypto.randomBytes(6).toString("hex") + ".tmp");
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (fs.existsSync(file)) throw new Error("Output already exists; refusing to overwrite");
    fs.renameSync(temp, file);
    // Directory sync is best-effort on systems lacking fsync for folders.
    let dirFd;
    try { dirFd = fs.openSync(directory, "r"); fs.fsyncSync(dirFd); }
    catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF", "EPERM"].includes(error?.code))
        throw error;
    } finally { if (dirFd !== undefined) fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function migrateFile({ configPath = "./config.json", write = false, inPlace = false } = {}) {
  if (inPlace && !write) throw new Error("--in-place requires --write");
  const input = path.resolve(configPath);
  const original = fs.readFileSync(input, "utf8");
  const source = JSON.parse(original);
  const next = migrateConfig(source);
  const payload = JSON.stringify(next, null, 2) + "\n";
  const count = Object.keys(next.channels).length;
  if (!write) return {
    written: false, channels: count, schemaVersion: 2,
    message: "Preview only. Re-run with --write to create a separate v2 file.",
  };
  const output = inPlace ? input : input + ".v2.json";
  if (inPlace) {
    const backup = input + ".legacy.bak";
    // Backup must exist before replacement; never overwrite an earlier one.
    writeExclusive(backup, original);
    // The original must still be identical to the previewed content.
    if (fs.readFileSync(input, "utf8") !== original)
      throw new Error("Configuration changed during migration; original preserved");
    const staged = input + ".v2.staged.json";
    writeExclusive(staged, payload);
    try { fs.renameSync(staged, input); }
    catch (error) { try { fs.unlinkSync(staged); } catch {} throw error; }
  } else {
    writeExclusive(output, payload);
  }
  return { written: true, channels: count, schemaVersion: 2,
    message: inPlace ? "In-place migration completed with a .legacy.bak backup" :
      "New v2 configuration written; original preserved" };
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log("Usage: npm run config:migrate -- [--config PATH] [--write] [--in-place]");
      console.log("Default: validate and preview. --write: create PATH.v2.json; --in-place: backup then replace.");
    } else {
      const result = migrateFile(opts);
      console.log("[Config Migration] " + result.message);
      console.log("[Config Migration] Schema v" + result.schemaVersion + ", channels: " + result.channels);
    }
  } catch (error) {
    if (error instanceof ConfigMigrationError) {
      for (const item of error.errors)
        console.error("[Config Migration] " + item.path + " (" + item.code + "): " + item.message);
    } else {
      // Never echo raw config, URLs, secrets or untrusted paths/errors.
      console.error("[Config Migration] Failed; input configuration remains unchanged.");
    }
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, migrateFile };
