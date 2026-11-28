# XFeeder 3.1 - Tracker Update

**English** · [Polski](Instruction.pl.md)

XFeeder posts new entries from RSS, Atom, JSON Feed, YouTube, GitHub and Steam to Discord
webhooks and Telegram. This package is ready to run: one program, nothing else to install.

## What is in the package

| File | What it is |
|---|---|
| `XFeeder` | The program (Linux x86_64, static: runs on any distribution, no Node.js, no libraries). |
| `config.json.example` | Example configuration: channels, feeds and settings. |
| `.env.example` | Example secrets file: webhook URLs and tokens. |
| `systemd/` | Service files to run XFeeder and its dashboard 24/7. |
| `dashboard-tunnel.sh` | Opens a server's dashboard on your own computer through SSH. |
| `scrapling/requirements.lock.txt` | Optional: versions for the browser that gets through Cloudflare. |
| `CHANGELOG.md`, `LICENSE` | What changed in 3.1, and the MIT licence. |

The full documentation (every setting explained) is on GitHub:
<https://github.com/yhymid/XFeeder/tree/main/docs>.

## 1. Start in five minutes

```sh
unzip XFeeder.zip -d xfeeder && cd xfeeder
cp config.json.example config.json
cp .env.example .env
chmod 600 .env config.json
```

1. In Discord: **Server settings → Integrations → Webhooks → New webhook**, choose the
   channel, **Copy webhook URL**.
2. Put it in `.env`:

   ```sh
   DISCORD_WEBHOOK_MAIN=https://discord.com/api/webhooks/123.../abc...
   ```

3. In `config.json`, under `channels` → `main` → `Feeds`, put the feeds you want
   (RSS/Atom links, `https://www.youtube.com/feeds/videos.xml?channel_id=...`,
   `https://github.com/OWNER/REPO/commits/main.atom`, ...). Delete the `channels2` group
   if you do not need a second channel.
4. Check and test:

   ```sh
   ./XFeeder --check-config      # errors and warnings
   ./XFeeder --dry-run --once    # fetches everything, posts nothing
   ```

5. Run:

   ```sh
   ./XFeeder
   ```

The first check of a feed only **remembers** its current entries, so the channel is not
flooded with old posts. From then on every new entry is posted. If you want the latest
entry right away, set `"FirstRunSend": 1` in `Settings`.

Changes to `config.json` and `.env` are picked up on their own; no restart is needed.
Stop with `Ctrl+C`.

## 2. Run 24/7 with systemd (server)

```sh
sudo useradd --system --home /var/lib/xfeeder --shell /usr/sbin/nologin xfeeder
sudo install -d -m 0700 -o xfeeder -g xfeeder /var/lib/xfeeder
sudo install -m 0755 XFeeder /usr/local/bin/xfeeder
sudo install -m 0600 -o xfeeder -g xfeeder config.json .env /var/lib/xfeeder/
sudo cp systemd/xfeeder.service systemd/xfeeder-dashboard.service /etc/systemd/system/
sudo usermod -aG systemd-journal xfeeder          # lets the dashboard's Logs page read the log
sudo systemctl daemon-reload
sudo systemctl enable --now xfeeder
sudo systemctl enable --now xfeeder-dashboard     # optional: web dashboard
journalctl -u xfeeder -f                          # live log
```

The dashboard service starts, stops and restarts together with `xfeeder`. To use another
folder or user, edit the paths and `User=` in both service files first.

Run only **one** XFeeder per `cache.json`.

## 3. Dashboard

A web page to watch and edit XFeeder: channels, posts, logs, charts, diagnostics and
settings. No JavaScript.

- On your own computer: `./XFeeder dashboard --data-dir .` and open
  <http://127.0.0.1:3000/>.
- On a server it listens only on the server's `127.0.0.1`. From your computer:

  ```sh
  SSH_KEY=~/.ssh/your_key ./dashboard-tunnel.sh user@server
  # open http://127.0.0.1:3000/   (Ctrl+C closes the tunnel)
  ```

- To reach it from a network, set a password first: uncomment
  `XFEEDER_DASHBOARD_PASSWORD` in `.env` with your own value, and set
  `XFEEDER_DASHBOARD_HOST=0.0.0.0`. Behind HTTPS, also
  `XFEEDER_DASHBOARD_PUBLIC_ORIGIN=https://your.domain`. With systemd, change
  `XFEEDER_DASHBOARD_HOST` in `xfeeder-dashboard.service`: values set there win over
  `.env`.

The **EN · PL** switch in the top right corner changes the language.

## 4. Optional: sites that block bots (Cloudflare)

Most feeds work without this. If a feed answers `403`, install the browser once, in the
folder with `config.json` (Python 3.10+ needed):

```sh
python3 -m venv scrapling/.venv
scrapling/.venv/bin/pip install --no-deps -r scrapling/requirements.lock.txt
scrapling/.venv/bin/python -m playwright install chromium
scrapling/.venv/bin/python -m patchright install chromium
```

Then in `config.json` set `"Scrapling": { "Enabled": true, ... }` and add the blocked
feed to `Scrapling.PerUrlConfig` with `"fallback": true` (plain download first, the
browser only when blocked). Restart XFeeder.

## 5. Telegram

Create a bot with @BotFather, put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`,
and set `"Telegram": { "Enabled": true, ... }` in `config.json`.

## 6. Upgrading

**From 2.x (Node.js):** stop the old version, put `XFeeder` in the same folder and start
it. `config.json`, `.env` and `cache.json` are read as they are; nothing is posted again.
`node_modules`, `package.json` and the `.js` files are no longer needed.

**From 3.0 (or an earlier 3.x build):** nothing in `config.json` or `.env` has to change, and nothing old is posted again.

```sh
cp cache.json cache.json.backup
sudo install -m 0755 XFeeder /usr/local/bin/xfeeder
sudo systemctl restart xfeeder        # restarts the dashboard too
```

## 7. Commands

| Command | What it does |
|---|---|
| `./XFeeder` | Runs the worker (checks feeds and posts). |
| `./XFeeder --check-config` | Checks `config.json` and `.env`, then exits. |
| `./XFeeder --dry-run --once` | One full round without posting or saving. |
| `./XFeeder preview <URL>` | Shows what XFeeder reads from a feed and how long it takes. |
| `./XFeeder rerender --apply` | Rebuilds already sent Discord posts in the current look. |
| `./XFeeder dashboard --data-dir .` | Starts the web dashboard. |
| `./XFeeder --help`, `--version` | Help and version. |

## 8. Files XFeeder creates

`cache.json` (what was already posted; **back it up**), `cache.feeds.json` (feed state),
`sent.json` (sent Discord posts, for edits), `*.runtime.json` (data for the dashboard),
and, if enabled, `diagnostics/`, `scrapling/`, `clearance.json`, `requests/`.

## 9. Common problems

| Problem | Fix |
|---|---|
| `missing delivery target` | The channel has no webhook, or the `${...}` name is not in `.env`. |
| Nothing is posted from a new feed | Intended: the first check only remembers. Use `FirstRunSend`. |
| A feed returns 403 | The site blocks bots: see section 4. |
| `400 Unknown Channel` from Discord | The webhook or thread was deleted: create a new webhook. |
| Posts arrive late | Lower `TimeChecker` (minutes) for that channel, or turn on `Settings.AdaptivePolling`. |
| `Permission denied` when starting | `chmod +x XFeeder`. |

More: <https://github.com/yhymid/XFeeder/blob/main/docs/configuration.md>.
