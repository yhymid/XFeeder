"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("X3-33: Docker has a deterministic lock-based non-root runtime", () => {
  const docker = read("Dockerfile");
  assert.match(docker, /^FROM node:24-bookworm-slim/m);
  assert.match(docker, /npm ci --omit=dev --ignore-scripts/);
  assert.match(docker, /^USER node$/m);
  assert.match(docker, /^STOPSIGNAL SIGTERM$/m);
  assert.match(docker, /^ENTRYPOINT \["node", "\/app\/main.js"\]$/m);
  assert.doesNotMatch(docker, /(?:curl|wget).+\|\s*(?:sh|bash)/);
});

test("X3-33: build context excludes secrets, caches, Python venv and browser payloads", () => {
  const ignore = read(".dockerignore");
  for (const forbidden of [
    "**/.venv/**", "**/node_modules/**", "**/cache.json",
    "**/config.json", "**/.env*", "**/ms-playwright/**",
    "**/browser-profiles/**", "**/*.activity-runtime.json",
    "**/*.network-runtime.json",
  ]) assert.ok(ignore.includes(forbidden), "Missing .dockerignore rule: " + forbidden);
  const docker = read("Dockerfile");
  assert.doesNotMatch(docker, /^COPY\s+\.\s+\.$/m);
  assert.match(docker, /^COPY src \.\/src$/m);
});

test("X3-33: Compose preserves config/state and never publishes dashboard to LAN", () => {
  const compose = read("compose.yaml");
  assert.match(compose, /\.\/data:\/data/g);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /stop_grace_period: 45s/g);
  assert.match(compose, /restart: unless-stopped/g);
  assert.match(compose, /XFEEDER_DASHBOARD_PASSWORD:\s*"/);
  assert.ok(!compose.includes("CHANGE_ME"));
  assert.doesNotMatch(compose, /privileged:\s*true/);
});

test("X3-33: systemd waits for shutdown and loads dashboard secret from protected file", () => {
  for (const name of ["xfeeder.service.example", "xfeeder-dashboard.service.example"]) {
    const unit = read("deploy/systemd/" + name);
    assert.match(unit, /User=xfeeder/);
    assert.match(unit, /StateDirectory=xfeeder/);
    assert.match(unit, /KillSignal=SIGTERM/);
    assert.match(unit, /TimeoutStopSec=45/);
    assert.match(unit, /UMask=0077/);
    assert.match(unit, /Restart=on-failure/);
    assert.doesNotMatch(unit, /PASSWORD=CHANGE_ME/);
  }
  assert.match(read("deploy/systemd/xfeeder-dashboard.service.example"),
    /EnvironmentFile=\/etc\/xfeeder\/dashboard\.env/);
});
