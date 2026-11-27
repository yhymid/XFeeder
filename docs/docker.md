# XFeeder in Docker

[Polski](docker.pl.md)

Docker is an alternative to the plain binary ([deployment.md](deployment.md)); both are
supported. Three images, built from [`docker/Dockerfile`](../docker/Dockerfile):

| Image | Adds | Size (amd64) | Architectures |
|---|---|---|---|
| `slim` | the static binary and CA certificates | ~17 MB | amd64, arm64 |
| `scrapling` | Python, [Scrapling](../scrapling/README.md) and its Chromium, for pages behind Cloudflare | ~1.6 GB | amd64 (arm64 untested) |
| `full` | SteamCMD, for `steampics://` sources | ~1.65 GB | amd64 only (SteamCMD is 32-bit x86) |

Start with `slim`. Take `scrapling` only if a feed needs `"Scrapling": true`, and `full`
only for `steampics://`.

## Quick start

```bash
git clone https://github.com/yhymid/XFeeder && cd XFeeder
mkdir -p data
cp config.json.example data/config.json   # then edit it
cp .env.example data/.env                 # webhooks, tokens
sudo chown -R 65532:65532 data            # the images run as UID 65532
docker compose build                      # slim; XFEEDER_TARGET=scrapling or full for the others
docker compose up -d
docker compose logs -f worker
```

Other images: `XFEEDER_TARGET=full XFEEDER_IMAGE=xfeeder:full docker compose build`, then
`XFEEDER_IMAGE=xfeeder:full docker compose up -d` (or put both in a `.env` next to
`compose.yaml`).

## Data

Everything lives in `./data`, mounted at `/data`: `config.json`, `.env`, `cache.json`,
`sent.json`, logs and `steam_pics.json`. Mount the **directory**, not single files: XFeeder
writes a temporary file and renames it, which fails on a single-file mount ("Device or
resource busy"). With the wrong owner the worker stops at start with "Permission denied";
fix it with `sudo chown -R 65532:65532 data`.

Only one worker may use a `cache.json`. The worker holds a lock on `cache.json.lock`; a
second one, in another container or on the host, exits with "another XFeeder worker is
already using …".

## Dashboard

```bash
echo 'XFEEDER_DASHBOARD_PASSWORD=choose-a-password' >> data/.env
docker compose --profile dashboard up -d
```

Open `http://127.0.0.1:3000` on the server, or from your computer through
`ssh -L 3000:127.0.0.1:3000 user@server`. In a container the dashboard listens on `0.0.0.0`,
so a password is required, and `XFEEDER_DASHBOARD_PUBLIC_ORIGIN` must match the address in
the browser exactly (`http://127.0.0.1:3000`; `localhost` or another port gives
`403 Untrusted Host`). `compose.yaml` publishes the port on `127.0.0.1` only and sets
`XFEEDER_DASHBOARD_WORKER_CONTROL=off`: the worker is its own container, so start and stop
it with `docker compose`, not with the dashboard's buttons. Configuration changes are picked
up without a restart.

## Steam builds (`full`)

SteamCMD updates itself on its first run (~215 MB) into `/home/xfeeder`. Keep that on a
volume (uncomment `steam-home` in `compose.yaml`), or every new container downloads it
again. For a Steam account (`Settings.SteamPics.Login`), log in once inside the container:

```bash
docker compose run --rm -it --entrypoint /usr/games/steamcmd worker +login NAME +quit
```

Approve the login in the Steam Mobile app within about a minute. The session is kept in the
`steam-home` volume.

## Stopping

`docker compose stop` sends SIGTERM; the worker finishes the current sends, saves its state
and exits (`stop_grace_period: 45s`). The `scrapling` and `full` images run under `tini`,
which also stops Chromium's processes.

## Not covered yet

- Images on ghcr.io: planned for the next release; until then build them yourself.
- Healthcheck: `slim` has no shell, so there is none. Check `docker compose logs`.
- arm64 is not tested; `full` cannot run on arm64.
