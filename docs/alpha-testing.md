# XFeeder 3.0.0-alpha.0 — Public Alpha Testing Guide

Welcome to the **XFeeder 3.0 public alpha**! This preview is available to anyone who wants to try upcoming features, explore the new architecture, and help improve the next major release.

You don't need an invitation or prior testing experience. Whether you're trying XFeeder for the first time or upgrading from 2.2, your feedback is welcome.

> **Alpha software:** This release is a work in progress. Features may change, bugs are expected, and it is not recommended for critical or production notification workflows. Keep a backup of your existing installation and data.

## Download the alpha

Visit [XFeeder Releases](https://github.com/yhymid/XFeeder/releases/tag/v3.0.0-alpha.0) and look for version **3.0.0-alpha.0**. If the prerelease is not yet published, wait for its release assets to appear.

The prebuilt runtime archive currently targets **Linux**. It is not a standalone executable: you'll also need Node.js and npm. Other operating systems may be tested from source, but the Linux archive should not be presented as a Windows or macOS package.

For the Linux runtime archive, download:

- `XFeeder-3.0.0-alpha.0-linux-runtime.tar.gz`
- `SHA256SUMS.txt`

Verify the archive against the published checksum before extracting. For example, in the directory containing your downloads:

```bash
sha256sum -c SHA256SUMS.txt
mkdir -p ~/Apps
tar -xzf XFeeder-3.0.0-alpha.0-linux-runtime.tar.gz -C ~/Apps
cd ~/Apps/XFeeder-3.0.0-alpha.0
```

If the checksum file lists additional release assets that you haven't downloaded, `sha256sum -c` may report those as missing. Make sure the downloaded archive's checksum passes.

## Get started

**Requirements:** Node.js 22 or 24 and npm are recommended; CI also tests Node.js 26. An internet connection is needed to install dependencies. Python and browser dependencies are optional and only needed for Scrapling features.

From the extracted runtime directory:

```bash
node --version
npm --version
npm ci
cp config.json.example config.json
cp .env.example .env
npm run check-config
npm run start:dry-run
```

Edit `config.json` and `.env` with your own feed URLs and destination settings. Start with a public RSS, Atom or JSON Feed and a dedicated test Discord webhook or Telegram chat.

The dry run checks your setup **without posting messages or changing delivery history**. A starter configuration with no configured feeds or destinations will not send anything.

### Try a real delivery

When your test destination is configured, run:

```bash
npm run start:once
npm run start:once
```

The first run can send new entries, subject to `RequestSend`. The second should not resend entries already recorded as delivered. **These commands send real messages**, so use a test destination rather than a busy community channel.

To keep XFeeder running continuously, use:

```bash
npm start
```

### Explore the dashboard

With the worker running, open another terminal in the XFeeder directory:

```bash
XFEEDER_DASHBOARD_PASSWORD='choose-your-own-strong-password' npm run dashboard
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000) on the same computer. Explore the dashboard's Overview, Channels, Activity and Settings pages. The `/api/live` endpoint reports dashboard liveness, while `/api/ready` reports worker readiness. For remote access, follow the [security guide](../SECURITY.md) rather than exposing the dashboard directly.

### Optional: test Scrapling

Scrapling provides browser-based fetching for sources that need it. It requires an additional pinned Python/Chromium environment:

```bash
npm run scrapling:install
npm run scrapling:check
```

You can skip this section if you're testing standard RSS, Atom or JSON sources.

## What we'd love you to test

There is no fixed test assignment. Try the features that matter to you: installation from the public release archive, RSS/Atom/JSON or YouTube feeds, Discord and Telegram delivery, duplicate prevention across restarts, the dashboard, networking and rate limits, proxy support, optional Scrapling, and clean shutdown with Ctrl+C.

A particularly useful test is running `start:once` twice and checking that the same post is not delivered again. It's also helpful to see whether XFeeder retains delivery history in `cache.json` and feed snapshots in `cache.feeds.json` after a restart.

If you're testing a more advanced setup, explore `Settings.MaxConcurrentChannels`, Network Usage Control, or your preferred proxy configuration. You don't need to test everything to contribute.

## Upgrading from an earlier XFeeder version

Keep the alpha **separate from your existing installation**. Before reusing data, back up `config.json`, `.env`, `cache.json` and `cache.feeds.json` where present. Copy only the files you intend to migrate into the new directory, and keep the original files untouched.

Older feed snapshot data may be migrated automatically. Do not delete cache files to fix an error without understanding the effect on duplicate prevention. See the [configuration migration guide](config-migration.md) for more details.

## Report bugs and share feedback

Found something unexpected, have a compatibility problem, or want to suggest an improvement? Open a [GitHub Issue](https://github.com/yhymid/XFeeder/issues). A useful report includes the alpha version, operating system, Node/npm versions, what you were trying to do, what happened, what you expected, and how someone else can reproduce it.

Screenshots and logs can help, but **remove tokens, webhook URLs, private feed addresses, passwords and account details** before posting. For sensitive security issues, follow the private reporting instructions in [SECURITY.md](../SECURITY.md).

Public alpha feedback helps shape the stable XFeeder 3.0 release. Thanks for trying it and sharing what works — and what doesn't!
