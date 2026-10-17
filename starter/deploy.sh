#!/usr/bin/env bash
# Upload files to a Streamlit app's stage AND live version, then byte-verify the live copy.
# Usage: deploy.sh <CONNECTION> <APP_FQN> <STAGE> <APP_DIR> <file> [file...]
#   e.g. deploy.sh MY_CONN DB.SCH.APP @DB.SCH.APP_STAGE ~/proj/app streamlit_app.py ui/sl_ui.js
set -euo pipefail
CONN=$1 APP=$2 STAGE=$3 DIR=$4; shift 4
LIVE="snow://streamlit/$APP/versions/live"
cd "$DIR"
for f in "$@"; do
  case "$f" in *secrets.toml*) echo "refusing to upload $f" >&2; exit 1;; esac
  d=$(dirname "$f"); [ "$d" = "." ] && d=""
  for t in "$STAGE" "$LIVE"; do
    snow stage copy "$f" "$t/$d" --overwrite -c "$CONN" >/dev/null
  done
done
TMP=$(mktemp -d)
snow stage copy "$LIVE/" "$TMP" --recursive -c "$CONN" >/dev/null
rc=0
for f in "$@"; do
  if cmp -s "$TMP/$f" "$f"; then echo "match $f"; else echo "DIFF $f"; rc=1; fi
done
rm -rf "$TMP"
exit $rc
