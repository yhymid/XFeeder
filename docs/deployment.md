# Deployment

**English** · [Polski](deployment.pl.md)

With Docker instead: [docker.md](docker.md).

Build on the target machine (or on one with the same or an older glibc). A
binary built on a rolling-release distribution may not start on an older
Ubuntu/Debian because of glibc symbol versions.

## Build from source

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
git clone https://github.com/yhymid/XFeeder.git
cd XFeeder
cargo build --release --locked
install -m 0755 target/release/xfeeder /usr/local/bin/xfeeder   # or keep it in place
```

## Data directory

Keep `config.json`, `.env` and `cache.json` together, readable only by the
service user (`chmod 600`). Everything else is created there by XFeeder:

| File | Written by | What it holds |
|---|---|---|
| `config.json` | you, dashboard | Channels and settings ([configuration guide](configuration.md)). |
| `.env` | you, dashboard | Webhook URLs, tokens and other secrets. |
| `cache.json` | worker | Delivery history: which entries every destination already got. **Back it up.** Without it every feed starts over: its current entries are marked as seen (except the newest `FirstRunSend`). |
| `cache.feeds.json` | worker | Feed state: validators (ETag, Last-Modified), last snapshot, health. Safe to delete. |
| `sent.json` | worker | Message ids and entries of the newest 2000 Discord posts, for edits (`rerender`, `SteamMerge`). No webhook URLs. |
| `clearance.json` | worker | Saved Cloudflare cookies (`Scrapling.ReuseClearance`). Delete it to forget all. |
| `config.json.*-runtime.json` | worker | Telemetry snapshots for the dashboard, rewritten every 2 s. |
| `requests/` | dashboard | Requests waiting for the worker (Check now, Forget); emptied every 30 s. |
| `diagnostics/` | worker | Event files and reports (`Settings.Diagnostics`). |
| `scrapling/` | worker, you | Browser worker script and its `.venv` ([Scrapling](../scrapling/README.md)). |
| `config.json.bak`, `.env.bak` | dashboard | The previous version after a save from the dashboard. |
| `*.corrupt-*` | worker | A copy of a state file that could not be parsed. See below. |

When `cache.json` cannot be parsed, the worker copies it to `cache.json.corrupt-<sha256>`
and does not start, so nothing is posted twice. Restore a good copy and start it again.

## systemd

Templates: [`deploy/systemd/xfeeder.service.example`](../deploy/systemd/xfeeder.service.example)
and [`xfeeder-dashboard.service.example`](../deploy/systemd/xfeeder-dashboard.service.example).

```sh
sudo cp deploy/systemd/xfeeder.service.example /etc/systemd/system/xfeeder.service
sudoedit /etc/systemd/system/xfeeder.service   # paths, User=
sudo systemctl daemon-reload
sudo systemctl enable --now xfeeder
journalctl -u xfeeder -f
```

Run exactly **one** worker per `cache.json`.

### Dashboard

```sh
sudo cp deploy/systemd/xfeeder-dashboard.service.example /etc/systemd/system/xfeeder-dashboard.service
sudoedit /etc/systemd/system/xfeeder-dashboard.service   # same paths and User= as the worker
sudo usermod -aG systemd-journal xfeeder                 # optional: the Logs page reads the journal
sudo systemctl daemon-reload
sudo systemctl enable --now xfeeder-dashboard
```

The dashboard unit is tied to the worker (`PartOf=` and `WantedBy=xfeeder.service`):
once enabled it starts at boot together with `xfeeder`, and stops and restarts with it.
It reads `config.json` and `.env` of the data directory, so run it as the same user as
the worker. It sees a worker started by systemd and shows the `systemctl` command
instead of start/stop buttons.

The service listens on `127.0.0.1:3000` of the server. Without
`XFEEDER_DASHBOARD_PASSWORD` it refuses any non-loopback address, so it is reachable only
through SSH. From your own machine:

```sh
SSH_KEY=~/.ssh/my_key scripts/dashboard-tunnel.sh user@server        # local port 3000
SSH_KEY=~/.ssh/my_key scripts/dashboard-tunnel.sh user@server 8080   # another local port
# Dashboard: http://127.0.0.1:3000/  (Ctrl+C to close)
```

The tunnel runs in the foreground; closing it leaves nothing running. Everything the
dashboard can do is described in the [dashboard guide](dashboard.md).

## Checks before going live

```sh
xfeeder --check-config --config /path/config.json
xfeeder --dry-run --once --config /path/config.json --cache /path/cache.json
```

The dry run lists every entry that would be posted; with an existing cache it
should only show entries that are genuinely new.

## Updating

```sh
cp cache.json cache.json.before-update           # in the data directory
git pull && cargo build --release --locked
sudo install -m 0755 target/release/xfeeder /usr/local/bin/xfeeder
sudo systemctl restart xfeeder                   # restarts the dashboard too
journalctl -u xfeeder -n 50
```
