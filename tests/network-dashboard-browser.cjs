"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startDashboard } = require("../src/dashboard/server");
const { createApp } = require("../src/app/bootstrap");
(async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "xfeeder-network-browser-"),
  );
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ Settings: { Logs: false }, Auth: { Token: "SECRET" } }),
  );
  await fs.writeFile(path.join(dir, ".env"), "");
  const previous = process.env.XFEEDER_DASHBOARD_PASSWORD;
  delete process.env.XFEEDER_DASHBOARD_PASSWORD;
  let server, browser, app;
  try {
    server = startDashboard({ port: 0, dataDir: dir });
    await once(server, "listening");
    app = createApp({
      configPath,
      cachePath: path.join(dir, "cache.json"),
      autostart: true,
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.XFEEDER_BROWSER_PATH,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#settings`);
    await page.getByRole("heading", { name: "Network", exact: true }).waitFor();
    const profile = page.getByLabel("Bandwidth Limit", { exact: true });
    assert.equal(await profile.inputValue(), "unlimited");
    const save = page.getByRole("button", {
      name: "Save network",
      exact: true,
    });
    assert.equal(await save.isEnabled(), false);
    await profile.selectOption("potato");
    await page
      .getByText("Potato is extremely slow.", { exact: false })
      .waitFor();
    await profile.selectOption("custom");
    const download = page.getByLabel("Download limit (Mbps)", { exact: true });
    const upload = page.getByLabel("Upload limit (Mbps)", { exact: true });
    await download.fill("0");
    assert.equal(await save.isEnabled(), false);
    await page
      .getByText("Download: enter a positive limit", { exact: false })
      .waitFor();
    await download.fill("2");
    await upload.fill("0.5");
    await page.getByRole("switch", { name: "Network Friendly Mode" }).check();
    await page.getByText("Advanced network settings", { exact: true }).click();
    await page
      .getByLabel("Maximum concurrent requests", { exact: true })
      .fill("3");
    await page
      .getByRole("switch", { name: "Scrapling Resource Saving" })
      .uncheck();
    // Saving Network must preserve unrelated unsaved edits.
    await page.getByRole("switch", { name: "Expert diagnostics" }).check();
    await save.click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-network-status]")?.textContent ===
        "Saved · Applied by worker",
    );
    let stored = JSON.parse(await fs.readFile(configPath));
    assert.equal(stored.network.bandwidthProfile, "custom");
    assert.equal(stored.network.uploadLimitMbps, 0.5);
    assert.equal(stored.network.maxConcurrentRequests, 3);
    assert.equal(stored.network.scraplingResourceSaving, false);
    assert.equal(stored.Settings.DebugExpert, undefined);
    assert.equal(
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .isEnabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".dirty-label")?.textContent ===
        "All changes saved",
    );
    // A second save catches stale client revision handling.
    await profile.selectOption("medium");
    await save.click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-network-status]")?.textContent ===
          "Saved · Applied by worker" &&
        document
          .querySelector("[data-network-metrics]")
          ?.textContent.includes("Profile: medium"),
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "/tmp/xfeeder-network-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(
      () =>
        document.querySelector(".sidebar").getBoundingClientRect().right <= 1,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "/tmp/xfeeder-network-mobile.png",
      fullPage: true,
    });
    await profile.selectOption("unlimited");
    await save.click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-network-status]")?.textContent ===
          "Saved · Applied by worker" &&
        document
          .querySelector("[data-network-metrics]")
          ?.textContent.includes("Profile: unlimited"),
    );
    // Concurrent disk edit must be rejected without losing the draft.
    stored = JSON.parse(await fs.readFile(configPath));
    stored.external = { keep: true };
    await fs.writeFile(configPath, JSON.stringify(stored));
    await profile.selectOption("low");
    await save.click();
    await page
      .getByText("Configuration changed elsewhere. Refresh before saving.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      JSON.parse(await fs.readFile(configPath)).network.bandwidthProfile,
      "unlimited",
    );
    await app.shutdown({ persistCache: false, graceMs: 0 });
    await page.waitForFunction(() =>
      document
        .querySelector("[data-network-metrics]")
        ?.textContent.includes("unavailable while the worker is offline"),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS Network: presets, custom validation, independent save, real applied runtime, conflict, offline status, desktop/mobile",
    );
  } finally {
    await browser?.close();
    await app?.shutdown({ persistCache: false, graceMs: 0 });
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    if (previous === undefined) delete process.env.XFEEDER_DASHBOARD_PASSWORD;
    else process.env.XFEEDER_DASHBOARD_PASSWORD = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
