#!/usr/bin/env bash
# One-time Steam login for `steampics://` with an account (Settings.SteamPics.Login).
#
# Reads STEAMCMD_LOGIN and STEAMCMD_PASSWORD from the .env next to the config,
# logs SteamCMD in once (it asks for the Steam Guard code here, in the terminal)
# and quits. SteamCMD then keeps the session, so XFeeder needs only the login.
# Run it as the user that runs XFeeder, in an interactive terminal:
#
#   scripts/steam-login.sh [path/to/.env] [steamcmd]
#
# The password goes to SteamCMD in a temporary 0600 script file that is deleted
# afterwards, never on the command line. After a successful login the password
# can be removed from .env.
set -euo pipefail

env_file=${1:-.env}
steamcmd=${2:-/usr/games/steamcmd}
[[ -r $env_file ]] || { echo "cannot read $env_file" >&2; exit 1; }
[[ -t 0 ]] || { echo "run this in an interactive terminal (Steam Guard code)" >&2; exit 1; }

value() {
  # Last NAME=value line; surrounding quotes removed. Not `source`d, so the
  # file is never executed.
  local line
  line=$(grep -E "^[[:space:]]*$1=" "$env_file" | tail -n 1) || true
  line=${line#*=}
  line=${line%$'\r'}
  if [[ $line == \"*\" || $line == \'*\' ]]; then line=${line:1:-1}; fi
  printf '%s' "$line"
}

login=$(value STEAMCMD_LOGIN)
password=$(value STEAMCMD_PASSWORD)
[[ $login =~ ^[A-Za-z0-9_]{3,64}$ ]] || { echo "STEAMCMD_LOGIN is empty or not a Steam account name" >&2; exit 1; }
[[ -n $password ]] || { echo "STEAMCMD_PASSWORD is empty" >&2; exit 1; }
[[ $password != *[[:space:]\"]* ]] || { echo "the password has spaces or quotes; log in by hand: $steamcmd +login $login" >&2; exit 1; }

script=$(umask 077 && mktemp)
trap 'rm -f "$script"' EXIT
printf 'login %s %s\nquit\n' "$login" "$password" > "$script"
unset password

"$steamcmd" +runscript "$script"
echo
echo "If SteamCMD said 'Waiting for user info...OK', the session is saved."
echo "Check: $steamcmd +@NoPromptForPassword 1 +login $login +quit"
