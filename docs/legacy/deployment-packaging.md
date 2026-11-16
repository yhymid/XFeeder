# X3-33 — Deploying XFeeder with Docker or systemd

These are optional deployment examples. No Kubernetes, orchestration
service, or replacement for the existing Node worker is required.

## Docker Compose (standard RSS/Atom/JSON sources)

The default Docker image uses Node 24, `npm ci` from the committed
package-lock, the non-root `node` account, and excludes private files,
Python environments and browser downloads. It deliberately does **not**
install Scrapling/Chromium; enable browser fallback only in a separately
reviewed image with matching Python/browser dependencies.

From a fresh checkout:

```sh
mkdir -p data
cp config.json.example data/config.json
# On Linux, the container runs with UID/GID 1000. Grant that user access:
sudo chown -R 1000:1000 data
chmod 700 data
chmod 600 data/config.json

docker compose build
docker compose up -d worker
docker compose logs -f worker
```

The worker reads `/data/config.json` and writes `/data/cache.json`
plus sibling feed state and telemetry files into the **same** bind mount.
Do not mount config read-only in a separate, isolated directory: the
dashboard and worker share adjacent runtime snapshots and the dashboard
edits config.json.

For an optional local dashboard, create an untracked `.env` beside
`compose.yaml` containing an actual strong
`XFEEDER_DASHBOARD_PASSWORD=...` value; do not commit it. Then run:

```sh
docker compose --profile dashboard up -d
```

The dashboard is published as `127.0.0.1:3000:3000` on the host.
For access from another computer, use SSH forwarding or a separately
authenticated/TLS reverse proxy, not a public bind without protection.
Both services share `./data`; **only one worker** may write a cache at
once. For upgrade, back up `data/`, rebuild and recreate the services.

Stop requests use SIGTERM and a 45-second grace period for cancellation
and state persistence. Compose uses `restart: unless-stopped`; persistent
bad configuration still requires operator action rather than relying
on endless retries.

## systemd (host installation)

Install a reviewed runtime release to `/opt/xfeeder` and run `npm ci`
there. Ensure Node.js 22, 24 or 26 is installed. Create an `xfeeder`
system user and group and use `/var/lib/xfeeder` for state. Copy
`config.json.example` there as `config.json` and give it to
`xfeeder:xfeeder` with mode 0600. Use the provided examples:

- `deploy/systemd/xfeeder.service.example`
- `deploy/systemd/xfeeder-dashboard.service.example`

The units use `StateDirectory=xfeeder`, restricted umask, SIGTERM,
45-second stop timeout and `Restart=on-failure`. They expect
`/usr/bin/node`; adapt that path if your distribution installs Node
elsewhere. The worker sets explicit `--config` and `--cache` paths;
the dashboard's working directory is the same state directory.

For the optional dashboard place its secret in
`/etc/xfeeder/dashboard.env` with:

```ini
XFEEDER_DASHBOARD_PASSWORD=put-a-long-random-secret-here
```

Keep this file outside the repo, owned by root with mode 0600.
Do not use the sample value. The dashboard binds to loopback; access
remotely through an SSH tunnel or hardened reverse proxy.

Copy/rename the example units to `/etc/systemd/system/xfeeder.service`
and `xfeeder-dashboard.service`, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now xfeeder.service
sudo systemctl enable --now xfeeder-dashboard.service
journalctl -u xfeeder.service -f
```

## Release and backup

Releases are generated from a reviewed **Git ref**, not the developer's
worktree. From a clean clone run:

```sh
npm run release:archive
```

The runtime archive excludes `node_modules`, `.venv`, browser
binaries, logs, private cache, secrets and telemetry. It includes a
generated empty starter config; **never overwrite the deployment config
with that starter during an upgrade**.

Stop the worker and dashboard before a consistent backup; copy
`config.json`, `.env` or protected dashboard secrets (securely),
`cache.json`, `cache.feeds.json`, and any operational state in the
data directory. Store backups encrypted with restrictive permissions.
Test restoration into an isolated location; never run restored data in
parallel with the original cache. In Docker, back up the bind-mounted
`./data` directory rather than an ephemeral container filesystem.

For journald, use built-in journald retention/rotation settings
(`SystemMaxUse`, `MaxRetentionSec`) appropriate for the host.
For Docker, configure engine log rotation (for example `json-file`
`max-size` and `max-file`) via daemon configuration. XFeeder's
optional `debug/terminal.txt` capture is separate; disable it unless
needed and rotate it with external tooling when enabled.

## Verification and limits

Run `npm ci`, `npm test`, `npm run check-config`, then a controlled
`npm run start:dry-run` in the target environment. The dashboard
provides `/api/live` and `/api/ready`, but the latter depends on
fresh telemetry from a worker and is not a replacement for systemd or
Compose restart supervision.

The packaging test checks configuration structure and privacy exclusions.
It is **not** a substitute for building and launching an actual container
on a Docker-capable host. Browser-backed Scrapling requires a dedicated
deployment profile with correctly matched Chromium binaries.
