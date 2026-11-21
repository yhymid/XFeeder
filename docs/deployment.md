# Deployment

**English** · [Polski](deployment.pl.md)

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
service user (`chmod 600`). The worker also creates `cache.feeds.json`, `sent.json`, the
`*.runtime.json` telemetry files and, if Scrapling is installed, a
`scrapling/` directory there.

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

The dashboard service listens on `127.0.0.1:3000` of the server. Without
`XFEEDER_DASHBOARD_PASSWORD` it refuses any non-loopback address, so it is
reachable only through SSH. From your own machine:

```sh
SSH_KEY=~/.ssh/my_key scripts/dashboard-tunnel.sh user@server
# Dashboard: http://127.0.0.1:3000/  (Ctrl+C to close)
```

The tunnel runs in the foreground; closing it leaves nothing running. The
dashboard reads `config.json` and `.env` of the data directory, so run it as
the same user as the worker. It sees a worker started by systemd and shows the
`systemctl` command instead of start/stop buttons. After updating the binary,
restart both services.

## Checks before going live

```sh
xfeeder --check-config --config /path/config.json
xfeeder --dry-run --once --config /path/config.json --cache /path/cache.json
```

The dry run lists every entry that would be posted; with an existing cache it
should only show entries that are genuinely new.

## Updating

```sh
git pull && cargo build --release --locked
sudo systemctl restart xfeeder
```

Back up `cache.json` before upgrades.
