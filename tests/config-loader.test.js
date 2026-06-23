const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadConfig } = require("../src/config-loader");

test("loadConfig reloads updated values from .env next to config.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfeeder-config-"));
  const configPath = path.join(tempDir, "config.json");
  const envPath = path.join(tempDir, ".env");

  try {
    fs.writeFileSync(configPath, JSON.stringify({
      Example: {
        Value: "${EXAMPLE_TOKEN}",
      },
    }, null, 2));

    fs.writeFileSync(envPath, "EXAMPLE_TOKEN=first-value\n", "utf8");
    assert.equal(loadConfig(configPath).Example.Value, "first-value");

    fs.writeFileSync(envPath, "EXAMPLE_TOKEN=second-value\n", "utf8");
    assert.equal(loadConfig(configPath).Example.Value, "second-value");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
