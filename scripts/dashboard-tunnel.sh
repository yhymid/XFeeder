#!/usr/bin/env bash
# Open the XFeeder dashboard of a server through SSH.
#
#   scripts/dashboard-tunnel.sh user@host [local-port] [-- extra ssh options]
#
# The dashboard listens on the server's 127.0.0.1 only (see
# deploy/systemd/xfeeder-dashboard.service.example). The tunnel runs in the
# foreground: Ctrl+C closes it and nothing is left running on either side.
# Environment: XFEEDER_REMOTE_PORT (default 3000), SSH_KEY (ssh -i).
set -euo pipefail

target=${1:?usage: $0 user@host [local-port] [-- ssh options]}
shift
local_port=3000
if [[ $# -gt 0 && $1 != -- ]]; then
    local_port=$1
    shift
fi
[[ ${1:-} == -- ]] && shift
remote_port=${XFEEDER_REMOTE_PORT:-3000}

ssh_args=(-N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3)
if [[ -n ${SSH_KEY:-} ]]; then
    ssh_args+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
fi
ssh_args+=(-L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" "$@" "$target")

echo "Dashboard: http://127.0.0.1:${local_port}/  (Ctrl+C to close)"
exec ssh "${ssh_args[@]}"
