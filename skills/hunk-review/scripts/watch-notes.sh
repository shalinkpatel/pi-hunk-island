#!/usr/bin/env bash
# Print NOTES_CHANGED <time> <json> whenever a pi-hunk-island session's notes.json changes, and
# REVIEW_CLOSED when the session directory is gone. Run it under a pi.bash wake monitor matching
# NOTES_CHANGED. Argument: the session directory ($TMPDIR/pi-hunk-XXXXXX).
set -uo pipefail
dir="${1:?session dir}"
file="$dir/notes.json"
last=""
while [ -d "$dir" ]; do
  cur=$(shasum "$file" 2>/dev/null | cut -c1-12)
  if [ -n "$cur" ] && [ "$cur" != "$last" ]; then
    last=$cur
    printf 'NOTES_CHANGED %s %s\n' "$(date +%T)" "$(head -c 4000 "$file")"
  fi
  sleep 5
done
printf 'REVIEW_CLOSED %s\n' "$(date +%T)"
