"use strict";
// Optional browser acceptance suite. Uses an external Playwright install, never production files.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { once } = require("node:events");
const { startDashboard } = require("../src/dashboard/server");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const event = (name, data = {}) =>
  `[worker][stdout] [Expert] ${JSON.stringify({ time: new Date().toISOString(), event: name, ...data })}\n`;
(async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "xfeeder-browser-"),
  );
  const screenshots =
    process.env.XFEEDER_SCREENSHOT_DIR ||
    path.join(os.tmpdir(), "xfeeder-screenshots");
  await fs.mkdir(screenshots, { recursive: true });
  const config = {
    Settings: { Logs: true, DebugExpert: true },
    Telegram: { Enabled: true, BotToken: "${FIXTURE_TOKEN}", ChatID: "@test" },
    ChannelDefaults: { TimeChecker: 60, RequestSend: 5 },
    Blogs: [
      {
        RSS: "https://example.com/feed",
        Feeds: ["https://second.example/atom"],
        Webhook: "${FIXTURE_WEBHOOK}",
        custom: { preserve: true },
      },
      "https://shorthand.example/feed",
    ],
    Named: { News: { Sources: ["https://news.example/feed"] } },
  };
  await fs.writeFile(
    path.join(directory, "config.json"),
    JSON.stringify(config, null, 2),
  );
  await fs.writeFile(
    path.join(directory, ".env"),
    "FIXTURE_TOKEN=fake-test-token\nFIXTURE_WEBHOOK=https://discord.com/api/webhooks/123/FAKESECRET\n",
  );
  await fs.mkdir(path.join(directory, "debug"));
  await fs.writeFile(
    path.join(directory, "debug/terminal.txt"),
    event("channel.process.begin", { channel: "Blogs#1" }) +
      event("feed.download.complete", {
        url: "https://example.com/feed?token=SOURCESECRET",
        ok: true,
        elapsedMs: 42,
      }) +
      event("feed.parsed", {
        url: "https://example.com/feed",
        parser: "rss-parser",
        itemCount: 5,
      }) +
      event("delivery.complete", {
        channel: "Blogs#1",
        target: "webhook",
        durationMs: 125,
      }) +
      event("queue.channel.complete", { channel: "Blogs#1" }),
  );
  const previousPassword = process.env.XFEEDER_DASHBOARD_PASSWORD;
  delete process.env.XFEEDER_DASHBOARD_PASSWORD;
  let server, browser, passwordServer;
  const readConfig = async () =>
    JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8"));
  try {
    server = startDashboard({ port: 0, dataDir: directory });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.XFEEDER_BROWSER_PATH
        ? { executablePath: process.env.XFEEDER_BROWSER_PATH }
        : {}),
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    // Unknown fixture metadata is preserved but must trigger the unsupported-section warning.
    const saveWithUnknownFields = async () => {
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      const warning = page.getByRole("alertdialog", { name: "Save with configuration warnings?" });
      await warning.waitFor();
      assert.match(await warning.textContent(), /Unsupported configuration section/);
      await warning.getByRole("button", { name: "Save with warnings", exact: true }).click();
    };
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page
      .getByRole("heading", { name: "Overview", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .isEnabled(),
      false,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(screenshots, "desktop-overview.png"),
      fullPage: true,
    });
    console.log("PASS desktop overview and local-open mode");

    await page.getByRole("link", { name: "Channels", exact: true }).click();
    await page
      .getByLabel("Search channels", { exact: true })
      .fill("second.example");
    assert.equal(await page.locator(".channel-row").count(), 1);
    await page.getByRole("button", { name: "Blogs #1", exact: true }).click();
    await page.getByLabel("Check every (minutes)", { exact: true }).fill("15");
    assert.equal(
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .isEnabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Refresh from disk", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Discard unsaved changes?" })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    assert.equal(
      await page
        .getByLabel("Check every (minutes)", { exact: true })
        .inputValue(),
      "15",
    );
    await saveWithUnknownFields();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        document.querySelector(".dirty-label")?.textContent ===
        "All changes saved",
    );
    assert.equal((await readConfig()).Blogs[0].TimeChecker, 15);
    assert.equal((await readConfig()).Blogs[0].RSS, "https://example.com/feed");
    assert.deepEqual((await readConfig()).Blogs[0].Feeds, [
      "https://second.example/atom",
    ]);
    assert.equal(
      (await readConfig()).Blogs[1],
      "https://shorthand.example/feed",
    );
    console.log(
      "PASS search, editing, dirty state, cancel refresh, save and alias preservation",
    );

    await page.getByRole("tab", { name: "Delivery", exact: true }).click();
    assert.equal(await page.getByText("Inherited", { exact: true }).count(), 1);
    assert.equal(
      await page
        .getByLabel("Webhook URL or env reference", { exact: true })
        .inputValue(),
      "${FIXTURE_WEBHOOK}",
    );
    await page
      .getByLabel("Delivery settings", { exact: true })
      .selectOption("custom");
    await page
      .getByLabel("Chat ID or @channel", { exact: true })
      .fill("@override");
    await saveWithUnknownFields();
    await page.waitForFunction(
      () =>
        document.querySelector(".dirty-label")?.textContent ===
        "All changes saved",
    );
    assert.equal((await readConfig()).Blogs[0].Telegram.ChatID, "@override");
    await page
      .getByLabel("Delivery settings", { exact: true })
      .selectOption("inherit");
    await page.getByRole("tab", { name: "Sources", exact: true }).click();
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add sources", exact: true })
      .getByLabel("Source URLs", { exact: true })
      .fill("https://new.example/rss\nhttps://another.example/rss");
    await page
      .getByRole("dialog", { name: "Add sources", exact: true })
      .getByRole("button", { name: "Add sources", exact: true })
      .click();
    assert.equal(await page.locator(".source-row").count(), 4);
    await saveWithUnknownFields();
    await page.waitForFunction(
      () =>
        document.querySelector(".dirty-label")?.textContent ===
        "All changes saved",
    );
    assert.ok(!(await readConfig()).Blogs[0].Telegram);
    console.log("PASS source multi-paste and Telegram override / inheritance");

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page
      .getByRole("button", { name: "Add channel", exact: true })
      .click();
    const create = page.getByRole("dialog", {
      name: "Add channel",
      exact: true,
    });
    await create.getByLabel("Group", { exact: true }).fill("Named");
    await create.getByLabel("Channel name", { exact: true }).fill("Added news");
    await create
      .getByLabel("Source URLs", { exact: true })
      .fill("https://added.example/rss\nhttps://added.example/atom");
    await create
      .getByRole("button", { name: "Create channel", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Added news", exact: true })
      .waitFor();
    await saveWithUnknownFields();
    await page.waitForFunction(
      () =>
        document.querySelector(".dirty-label")?.textContent ===
        "All changes saved",
    );
    assert.equal((await readConfig()).Named["Added news"].RSS.length, 2);
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    await page
      .getByRole("heading", { name: "Added news copy", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Actions for Added news copy", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Actions for Added news copy", exact: true })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    const deleteDialog = page.getByRole("alertdialog", {
      name: "Delete Added news copy?",
    });
    await deleteDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Added news copy", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Actions for Added news copy", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Actions for Added news copy", exact: true })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Delete Added news copy?" })
      .getByRole("button", { name: "Delete channel", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Channels", exact: true })
      .waitFor();
    console.log("PASS named-group create, duplicate and delete confirmation");

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page
      .getByLabel("Bot token", { exact: true })
      .fill("visible-only-on-reveal");
    assert.equal(
      await page.getByLabel("Bot token", { exact: true }).getAttribute("type"),
      "password",
    );
    await page.getByRole("link", { name: "Advanced", exact: true }).click();
    await page
      .locator("summary")
      .filter({ hasText: "Environment variables" })
      .click();
    await page
      .getByRole("button", { name: "Edit raw .env", exact: true })
      .click();
    await page
      .getByLabel("Raw .env", { exact: true })
      .fill(
        "FIXTURE_TOKEN=changed-test-token\nFIXTURE_WEBHOOK=https://discord.com/api/webhooks/123/FAKESECRET\n",
      );
    await page
      .getByRole("dialog", { name: "Edit raw .env", exact: true })
      .getByRole("button", { name: "Save .env", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".dirty-label")?.textContent ===
        "Configuration unsaved",
    );
    assert.equal((await readConfig()).Telegram.BotToken, "${FIXTURE_TOKEN}");
    await page
      .getByRole("button", { name: "Close editor", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh from disk", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Discard unsaved changes?" })
      .getByRole("button", { name: "Discard and refresh", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".dirty-label")?.textContent ===
        "All changes saved",
    );
    console.log(
      "PASS secret masking, independent .env save and confirmed refresh",
    );

    await page
      .locator("summary")
      .filter({ hasText: "Runtime / fetch mode" })
      .click();
    await page.getByLabel("Timeout (ms)", { exact: true }).fill("4567");
    await page
      .locator("summary")
      .filter({ hasText: "Browser behavior" })
      .click();
    await page
      .getByLabel("Headless browser", { exact: true })
      .selectOption("true");
    await saveWithUnknownFields();
    await page.waitForFunction(
      () =>
        document.querySelector(".dirty-label")?.textContent ===
        "All changes saved",
    );
    assert.equal((await readConfig()).Scrapling.DefaultOptions.timeoutMs, 4567);
    assert.equal((await readConfig()).Scrapling.DefaultOptions.headless, true);
    await page
      .locator("summary")
      .filter({ hasText: "Raw config.json" })
      .click();
    const raw = page.getByLabel("Raw config.json", { exact: true });
    const rawValue = JSON.parse(await raw.inputValue());
    rawValue.CustomMetadata = { preserved: true };
    await raw.fill("{");
    await page
      .getByRole("button", { name: "Validate JSON", exact: true })
      .click();
    await page
      .getByText(
        "Invalid JSON. Check the syntax and use an object as the root.",
        { exact: true },
      )
      .waitFor();
    await raw.fill(JSON.stringify(rawValue, null, 2));
    assert.equal(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      true,
    );
    await page
      .getByRole("button", { name: "Apply to form", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Replace form with raw JSON?" })
      .getByRole("button", { name: "Apply JSON", exact: true })
      .click();
    await saveWithUnknownFields();
    await page.waitForFunction(
      () =>
        document.querySelector(".dirty-label")?.textContent ===
        "All changes saved",
    );
    assert.deepEqual((await readConfig()).CustomMetadata, { preserved: true });
    console.log(
      "PASS independent Scrapling sections, raw JSON validation/apply and beforeunload protection",
    );

    await page.getByRole("link", { name: "Activity", exact: true }).click();
    const body = await page.locator("main").textContent();
    assert.ok(!body.includes("SOURCESECRET"));
    assert.ok(!body.includes("FAKESECRET"));
    await page.getByLabel("Event", { exact: true }).selectOption("delivery");
    assert.equal(await page.locator(".activity-row").count(), 1);
    await page.locator(".activity-row").click();
    await page
      .getByRole("dialog", { name: "Entry delivered", exact: true })
      .waitFor();
    assert.ok(
      !(await page.getByRole("dialog").textContent()).includes("FAKESECRET"),
    );
    await page.keyboard.press("Escape");
    await fs.appendFile(
      path.join(directory, "debug/terminal.txt"),
      event("delivery.complete", { channel: "Blogs#1", target: "telegram" }),
    );
    await page
      .getByRole("button", { name: "Refresh activity", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".activity-row").length === 2,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Refresh activity", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    console.log("PASS Activity filtering, sanitized details and Escape");

    await page.getByRole("link", { name: "Channels", exact: true }).click();
    await page.getByLabel("Search channels", { exact: true }).fill("");
    while (
      await page
        .getByRole("button", { name: "Dismiss notification", exact: true })
        .count()
    )
      await page
        .getByRole("button", { name: "Dismiss notification", exact: true })
        .first()
        .click();
    await page.screenshot({
      path: path.join(screenshots, "desktop-channels.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(screenshots, "mobile-channels.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page
      .getByRole("heading", { name: "Overview", exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(screenshots, "mobile-overview.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 360, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page
      .getByRole("button", { name: "Add channel", exact: true })
      .click();
    const cancel = page.getByRole("dialog", {
      name: "Add channel",
      exact: true,
    });
    await cancel
      .getByLabel("Source URLs", { exact: true })
      .fill("https://unsaved.example/rss");
    await page.keyboard.press("Escape");
    await page
      .getByRole("alertdialog", { name: "Discard new channel?" })
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    assert.equal(await page.locator("dialog[open]").count(), 0);
    console.log(
      "PASS 390px and 360px layouts, mobile navigation and drawer dirty protection",
    );

    process.env.XFEEDER_DASHBOARD_PASSWORD = "browser-password";
    passwordServer = startDashboard({ port: 0, dataDir: directory });
    await once(passwordServer, "listening");
    await page.goto(`http://127.0.0.1:${passwordServer.address().port}`);
    await page
      .getByRole("heading", { name: "Welcome back", exact: true })
      .waitFor();
    await page.getByLabel("Dashboard password", { exact: true }).fill("wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByText("Invalid dashboard password.", { exact: true })
      .waitFor();
    await page
      .getByLabel("Dashboard password", { exact: true })
      .fill("browser-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Overview", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page.getByRole("button", { name: "Logout", exact: true }).click();
    await page
      .getByRole("heading", { name: "Welcome back", exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    console.log(
      `PASS password login / logout and no uncaught browser errors\nScreenshots: ${screenshots}`,
    );
  } finally {
    if (previousPassword === undefined)
      delete process.env.XFEEDER_DASHBOARD_PASSWORD;
    else process.env.XFEEDER_DASHBOARD_PASSWORD = previousPassword;
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (passwordServer)
      await new Promise((resolve) => passwordServer.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
