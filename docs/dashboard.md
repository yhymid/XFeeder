# Dashboard

**English** · [Polski](dashboard.pl.md)

`xfeeder dashboard` is a web page for watching and editing a running XFeeder: channels,
posts, logs, diagnostics and settings. It is part of the same binary, uses no
JavaScript and needs nothing else installed.

## Starting it

```sh
./xfeeder dashboard --data-dir /path/to/folder   # folder with config.json, .env, cache.json
# http://127.0.0.1:3000/
```

On a server, run it as the systemd service `xfeeder-dashboard` (see
[Deployment](deployment.md#dashboard)); it starts, stops and restarts together with the
worker.

The dashboard and the worker are separate processes. The dashboard never sends posts
itself and never writes the worker's history files (`cache.json`, `sent.json`): it edits
`config.json` and `.env`, reads the worker's telemetry, and passes requests such as
"check now" to the worker through small files (see [Requests to the worker](#requests-to-the-worker)).

## Access and security

| Situation | What to do |
|---|---|
| Your own computer | Open `http://127.0.0.1:3000/`. No password is needed on `127.0.0.1`. |
| A server | Keep it on `127.0.0.1` and open an SSH tunnel: `SSH_KEY=~/.ssh/key scripts/dashboard-tunnel.sh user@server`. Any local port works: `scripts/dashboard-tunnel.sh user@server 8080`. |
| Reachable from a network | Set `XFEEDER_DASHBOARD_PASSWORD`, `XFEEDER_DASHBOARD_HOST=0.0.0.0` and, behind a reverse proxy with HTTPS, `XFEEDER_DASHBOARD_PUBLIC_ORIGIN=https://feeds.example.com`. |

- Without a password the dashboard refuses to listen on anything other than a loopback
  address.
- Requests are accepted only for the expected host name (on loopback: `127.0.0.1`,
  `localhost`, `[::1]` with any port) and form posts only from the same origin.
- The login cookie is `HttpOnly`, `SameSite=Strict` (and `Secure` over HTTPS) and lasts
  `XFEEDER_DASHBOARD_SESSION_TTL_HOURS` (12 h). Repeated wrong passwords are limited.
- Pages are plain HTML with a strict Content-Security-Policy (`default-src 'none'`): no
  scripts are loaded or run.
- Secret values from `.env` are never shown; only whether they are set. Webhook URLs,
  tokens and cookie values are removed from logs, activity and diagnostics.

| Variable | Default | What it does |
|---|---|---|
| `XFEEDER_DASHBOARD_HOST` | `127.0.0.1` | Address to listen on. |
| `XFEEDER_DASHBOARD_PORT` | `3000` | Port. |
| `XFEEDER_DASHBOARD_PASSWORD` | – | Password; required for a non-loopback address. |
| `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` | – | Public `https://…` address behind a reverse proxy. |
| `XFEEDER_DASHBOARD_SESSION_TTL_HOURS` | `12` | How long a login lasts. |
| `XFEEDER_SERVICE_UNIT` | `xfeeder` | systemd unit whose journal the **Logs** page reads. |

These can be set in the environment, in the systemd unit or in `.env`. The `.env` editor
in the dashboard hides and protects the `XFEEDER_DASHBOARD_*` lines.

## Language

The **EN · PL** switch in the top right corner changes the language of every page
(remembered in the `xf_lang` cookie). Feed content, log lines and file contents are shown
as they are.

## Pages

### Overview

- **Worker control**: whether the worker is running. A worker started from the
  dashboard can be started, stopped and restarted here; a worker run by systemd shows the
  `systemctl` command instead.
- Counters since the worker started: checks, posts, errors, durations.
- **Posts per day** (last 30 days) and **posts per channel** (last 7 days) charts.
- **Recent posts** with links to the Discord messages, and **Recent problems**.
- **Feeds with problems**: feeds that fail, are blocked or answer slowly.

### Channels

The list of channels in the order of `config.json`, with the destination (webhook name
and Discord channel, checked by a read-only request; a deleted webhook is shown as a
warning), the real check interval and the feeds.

- **Edit**: all channel settings in one form (`Label`, destination, feeds, interval,
  `Filters`, `FirstRunSend`, …). Saving a channel of a list group pins its current history
  key (`CacheKey`), so editing it does not post old entries again.
- **Duplicate** and **Delete** (with a confirmation page).
- Clicking a channel opens its **channel page**:
  - destination, interval, posts in the last 7 days, number of remembered entries,
    webhook check;
  - a posts-per-day chart, the feeds table and recent posts;
  - **Check now**: the worker checks all feeds of the channel on its next tick (at most
    30 s);
  - **Delivery history**: the entries the channel remembers as already posted, with
    titles. **Forget** removes one of them, so it **will be posted again** on the next
    check if the feed still contains it.

### Feed page

Opened from a feed link: where the feed is used, its real interval (also with
`AdaptivePolling`), health, whether the browser (Scrapling) or a solver is used, the last
saved entries, and hints. **Test now** downloads the feed once and shows the entries as
XFeeder reads them; it sends and saves nothing.

### Posts

Posts sent to Discord (from `sent.json`), newest first, with filters by channel and by
text. **Rebuild** edits a sent message so it uses the current layout (the same as
`xfeeder rerender` for one post); nothing new is sent.

### Activity

Events of the worker in readable form (checks, sends, errors, Scrapling decisions), with
filters by channel, feed and text. Clicking a channel or feed name filters by it.

### Logs

The last 200–5000 lines of the worker's systemd journal (`journalctl -u xfeeder`),
newest first, with an "only warnings and errors" filter and a search box. Secrets are
removed before display. The dashboard user needs read access to the journal (member of
the `adm` or `systemd-journal` group); `sudo` is not used. Set `XFEEDER_SERVICE_UNIT` if
the unit has another name.

### Diagnostics

- **System**: version and git commit, worker PID and uptime, memory of the worker and
  the dashboard, GitHub API limit (remaining / limit, reset time), sizes of the data files.
- **Recorder**: whether `Settings.Diagnostics` is on, and the latest report
  (`diagnostics/summary-*.md`: delay from publication to Discord, slowest feeds, hints).
- **Files**: the diagnostics files on disk.

### Settings

- **General**: `Logs`, `DebugExpert`, `MaxConcurrentChannels`, `FirstRunSend`.
- **Diagnostics recorder**, **Adaptive polling**, **Steam + SteamDB in one post**
  (`SteamMerge`), **Cloudflare** (`Scrapling.ReuseClearance`) and **Telegram** (defaults
  for all channels). Each one writes the setting described in the
  [configuration guide](configuration.md), so switching it off restores the earlier
  behaviour.
- **Network**: limits and timeouts of the `network` section.
- **Secrets (.env)**: which variables used by `config.json` are set; set or replace a
  value without seeing the old one.
- **Saved Cloudflare clearances**: sites with a cookie in `clearance.json`, with expiry;
  **Forget** deletes one (the worker notices the change on its own).

### Advanced

- **.env** editor: all non-reserved lines. The previous file is kept as `.env.bak`.
- **config.json** editor: the whole file, checked before saving. The previous file is kept
  as `config.json.bak`.

## How saving works

- Every form carries the revision of the file it was made from. When the file was
  changed in the meantime (by hand or in another tab), saving is refused ("The configuration
  changed on disk since this page was opened"); reload and try again.
- The file is written atomically with mode `0600`; the previous version is kept as
  `.bak`.
- The worker reloads `config.json` and `.env` on its own, usually within seconds; no
  restart is needed (except for `Settings.Diagnostics`).

## Requests to the worker

**Check now** and **Forget** change the state of the running worker, which keeps
`cache.json` in memory. So the dashboard writes one small JSON file per request into
`requests/` next to `config.json` (folder `0700`, files `0600`). On every scheduler tick
(30 s) the worker reads them, applies them and deletes the files.

- **Check now** makes the channel due immediately.
- **Forget** removes one id from the channel's history and saves `cache.json`. When the
  channel is running at that moment, the request waits for the next tick.
- With `--dry-run` requests are applied in memory only.
- Invalid or oversized files are deleted; at most 100 requests are handled per tick.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `403 Untrusted Host` | The address in the browser does not match. Use `127.0.0.1` or `localhost`, or set `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` behind a proxy. |
| The dashboard does not start with a non-loopback host | Set `XFEEDER_DASHBOARD_PASSWORD`. |
| `Address already in use` | Another dashboard is running on the port, e.g. the systemd service. Use it, or set another `XFEEDER_DASHBOARD_PORT`. |
| Logs page: "Cannot run journalctl" or no lines | Add the dashboard user to the `adm` or `systemd-journal` group, or set `XFEEDER_SERVICE_UNIT`. |
| "changed on disk since this page was opened" when saving | The file changed after the page was opened. Reload the page. |
| Check now / Forget does nothing | The worker is not running, or runs with another data folder. Files left in `requests/` are picked up when it starts. |
| Webhook shown as missing | The webhook was deleted in Discord: create a new one and put its URL in `.env`. |
