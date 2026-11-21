#!/usr/bin/env bash
# Build the ready-to-run release archive.
#
#   scripts/package-release.sh path/to/xfeeder-binary [out.zip]
#
# Layout (flat, as in the release notes): Instruction.md, Instruction.pl.md,
# XFeeder, config.json.example, .env.example, systemd/, dashboard-tunnel.sh,
# scrapling/requirements.lock.txt, CHANGELOG.md, LICENSE.
set -euo pipefail

binary=${1:?usage: $0 path/to/xfeeder-binary [out.zip]}
out=$(realpath -m "${2:-XFeeder.zip}")
root=$(cd "$(dirname "$0")/.." && pwd)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

install -m 0755 "$binary" "$stage/XFeeder"
install -m 0644 "$root/release/Instruction.md" "$root/release/Instruction.pl.md" \
    "$root/config.json.example" "$root/.env.example" "$root/CHANGELOG.md" "$root/LICENSE" "$stage/"
install -d "$stage/systemd" "$stage/scrapling"
install -m 0644 "$root/deploy/systemd/xfeeder.service.example" "$stage/systemd/xfeeder.service"
install -m 0644 "$root/deploy/systemd/xfeeder-dashboard.service.example" "$stage/systemd/xfeeder-dashboard.service"
install -m 0755 "$root/scripts/dashboard-tunnel.sh" "$stage/dashboard-tunnel.sh"
install -m 0644 "$root/scrapling/requirements.lock.txt" "$stage/scrapling/requirements.lock.txt"

rm -f "$out"
(cd "$stage" && TZ=UTC find . -exec touch -d @"${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct)}" {} + \
    && zip -X -q -r "$out" Instruction.md Instruction.pl.md XFeeder config.json.example .env.example \
        systemd dashboard-tunnel.sh scrapling CHANGELOG.md LICENSE)
echo "$out"
