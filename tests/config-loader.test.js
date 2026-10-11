const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { loadConfig } = require("../src/config-loader");
const { tempDir } = require("./helpers/temp-dir.cjs");

test("loadConfig reloads updated values from .env next to config.json", (t) => {
  const directory = tempDir(t);
  const configPath = path.join(directory, "config.json");
  const envPath = path.join(directory, ".env");

  fs.writeFileSync(configPath, JSON.stringify({
    Example: {
      Value: "${EXAMPLE_TOKEN}",
    },
  }, null, 2));

  fs.writeFileSync(envPath, "EXAMPLE_TOKEN=first-value\n", "utf8");
  assert.equal(loadConfig(configPath).Example.Value, "first-value");

  fs.writeFileSync(envPath, "EXAMPLE_TOKEN=second-value\n", "utf8");
  assert.equal(loadConfig(configPath).Example.Value, "second-value");
});
