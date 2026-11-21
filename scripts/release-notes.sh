#!/usr/bin/env bash
# Print the CHANGELOG.md section of a version, without its heading.
#
#   scripts/release-notes.sh 3.0
set -euo pipefail
version=${1:?usage: $0 VERSION}
root=$(cd "$(dirname "$0")/.." && pwd)
notes=$(awk -v v="$version" '
    /^## / { if (found) exit; if (index($0, "## " v " ") == 1) { found = 1; next } }
    found { print }
' "$root/CHANGELOG.md")
[[ -n ${notes//[[:space:]]/} ]] || { echo "No CHANGELOG section for $version" >&2; exit 1; }
printf '%s\n' "$notes"
