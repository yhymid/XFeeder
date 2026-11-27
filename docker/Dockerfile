# syntax=docker/dockerfile:1
#
# XFeeder images, smallest first (see docs/docker.md):
#   docker build -f docker/Dockerfile --target slim      -t xfeeder:slim .
#   docker build -f docker/Dockerfile --target scrapling -t xfeeder:scrapling .
#   docker build -f docker/Dockerfile --target full      -t xfeeder:full .   # linux/amd64 only
#
# Every image runs as UID/GID 65532 and keeps all state in /data (a directory:
# XFeeder writes files by rename, which a single-file bind mount cannot take).

# ---------- build: static musl binary (same toolchain as release.yml) ----------
FROM docker.io/library/rust:1-trixie AS build
ARG TARGETARCH
ARG GIT_COMMIT=""
RUN apt-get update -q && apt-get install -y -q --no-install-recommends musl-tools && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN case "$TARGETARCH" in \
      amd64|"") t=x86_64-unknown-linux-musl ;; \
      arm64) t=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && rustup target add "$t" \
 && XFEEDER_GIT_COMMIT="$GIT_COMMIT" CC=musl-gcc cargo build --release --locked --target "$t" \
 && install -D -m 0755 "target/$t/release/xfeeder" /out/usr/local/bin/xfeeder \
 && install -D -m 0644 config.json.example .env.example -t /out/usr/share/xfeeder/ \
 && install -d -m 0700 /out/data

# ---------- slim: the binary, CA certificates, nothing else ----------
FROM gcr.io/distroless/static-debian13:nonroot AS slim
LABEL org.opencontainers.image.title="XFeeder" \
      org.opencontainers.image.description="RSS/Atom/JSON to Discord and Telegram (slim)" \
      org.opencontainers.image.source="https://github.com/yhymid/XFeeder" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /out/usr /usr
COPY --from=build --chown=65532:65532 /out/data /data
USER 65532:65532
WORKDIR /data
VOLUME ["/data"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/xfeeder"]
CMD ["run", "--config", "/data/config.json", "--cache", "/data/cache.json"]

# ---------- scrapling: + Python, Scrapling and its Chromium (Cloudflare pages) ----------
FROM docker.io/library/python:3.14-slim-trixie AS scrapling
LABEL org.opencontainers.image.title="XFeeder" \
      org.opencontainers.image.description="RSS/Atom/JSON to Discord and Telegram (with Scrapling)" \
      org.opencontainers.image.source="https://github.com/yhymid/XFeeder" \
      org.opencontainers.image.licenses="MIT"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PATH=/opt/scrapling/bin:$PATH
COPY scrapling/requirements.lock.txt /tmp/requirements.lock.txt
RUN apt-get update -q \
 && apt-get install -y -q --no-install-recommends tini ca-certificates \
 && python -m venv /opt/scrapling \
 && /opt/scrapling/bin/pip install --no-deps -r /tmp/requirements.lock.txt \
 && /opt/scrapling/bin/pip check \
 && /opt/scrapling/bin/python -m patchright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /tmp/requirements.lock.txt /root/.cache \
 && groupadd -g 65532 xfeeder && useradd -u 65532 -g 65532 -m -d /home/xfeeder -s /usr/sbin/nologin xfeeder \
 && install -d -o 65532 -g 65532 -m 0700 /data
COPY --from=build /out/usr /usr
USER 65532:65532
WORKDIR /data
VOLUME ["/data"]
STOPSIGNAL SIGTERM
# tini reaps Chromium's child processes.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/xfeeder"]
CMD ["run", "--config", "/data/config.json", "--cache", "/data/cache.json"]

# ---------- full: + SteamCMD for steampics:// (linux/amd64 only: SteamCMD is 32-bit x86) ----------
FROM scrapling AS full
LABEL org.opencontainers.image.description="RSS/Atom/JSON to Discord and Telegram (with Scrapling and SteamCMD)"
USER root
# Debian's steamcmd is in non-free, i386 only, and asks to accept Valve's licence
# through debconf; building this image accepts it.
RUN dpkg --add-architecture i386 \
 && sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
 && echo 'steam steam/question select I AGREE' | debconf-set-selections \
 && echo 'steam steam/license note ""' | debconf-set-selections \
 && apt-get update -q \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends steamcmd:i386 \
 && rm -rf /var/lib/apt/lists/*
USER 65532:65532
# SteamCMD updates itself into $HOME/.local/share/Steam (~215 MB) and keeps a
# Steam login there (Settings.SteamPics.Login): keep $HOME on a volume.
VOLUME ["/home/xfeeder"]
