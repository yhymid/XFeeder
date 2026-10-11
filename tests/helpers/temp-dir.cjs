"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(process.env.XFEEDER_TEST_ROOT || os.tmpdir(), "xfeeder-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  return directory;
}

module.exports = { tempDir };
