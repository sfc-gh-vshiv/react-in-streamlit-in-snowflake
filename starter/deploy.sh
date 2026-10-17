#!/usr/bin/env bash
# Deploy a Streamlit in Snowflake app from a folder: upload exactly the files listed in
# its deploy.manifest, create or update the app, then byte-check what Snowflake serves.
#
#   deploy.sh APP_DIR DB.SCHEMA.APP --warehouse WH [options]
#     -c, --connection NAME   Snowflake CLI connection (default: the CLI's default)
#     -r, --role ROLE         role to deploy as (default: the connection's role)
#     -w, --warehouse WH      warehouse the app's queries run on (required)
#     -t, --title TITLE       title shown in Snowsight
#     --container             use the container runtime (default: warehouse runtime)
#     --pool POOL             compute pool for --container (required with it)
#     --check                 validate the manifest and print the upload list; change nothing
#
# The committed ui/sl_ui.js is uploaded as is, so deploying needs no Node toolchain.
set -euo pipefail

die() { echo "deploy.sh: $*" >&2; exit 1; }
[ $# -ge 2 ] || die "usage: deploy.sh APP_DIR DB.SCHEMA.APP --warehouse WH [--container --pool POOL] [-c CONN] [-r ROLE] [--check]"
APP_DIR=$(cd "$1" && pwd) || die "no such folder: $1"
APP=$2; shift 2
CONN="" ROLE="" WH="" TITLE="" POOL="" CONTAINER=0 CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    -c|--connection) CONN=$2; shift 2;;
    -r|--role) ROLE=$2; shift 2;;
    -w|--warehouse) WH=$2; shift 2;;
    -t|--title) TITLE=$2; shift 2;;
    --pool) POOL=$2; shift 2;;
    --container) CONTAINER=1; shift;;
    --check) CHECK=1; shift;;
    *) die "unknown option $1";;
  esac
done
ident='^[A-Za-z_][A-Za-z0-9_$]*$'
IFS=. read -r DB SCHEMA NAME EXTRA <<< "$APP"
for part in "$DB" "$SCHEMA" "$NAME"; do [[ $part =~ $ident ]] || die "app must be DB.SCHEMA.NAME with plain identifiers"; done
[ -z "${EXTRA:-}" ] || die "app must be DB.SCHEMA.NAME"
for v in "$WH" "$ROLE" "$POOL"; do [ -z "$v" ] || [[ $v =~ $ident ]] || die "not a plain identifier: $v"; done
[ -z "$TITLE" ] || [[ $TITLE =~ ^[A-Za-z0-9\ ().,:_-]+$ ]] || die "the title may use letters, digits, spaces and ().,:_- only"

# ---------------------------------------------------------------- the manifest gate
# Only listed files are uploaded. Paths stay inside the app folder, and anything that
# looks like a credential is refused even if someone lists it.
MANIFEST="$APP_DIR/deploy.manifest"
[ -f "$MANIFEST" ] || die "missing $MANIFEST"
FILES=()
while IFS= read -r line || [ -n "$line" ]; do
  f=$(printf '%s' "${line%%#*}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$f" ] || continue
  case "$f" in
    /*|~*|*..*|*\\*|*" "*) die "manifest: '$f' must be a plain relative path inside the app folder";;
  esac
  base=$(basename "$f")
  case "$base" in
    secrets.toml|connections.toml|.env|.env.*|*.pem|*.p8|*.key|*.p12|*.pfx|id_rsa*|*.token)
      die "manifest: refusing to upload '$f' (looks like a credential)";;
    config.toml) [ "$f" = ".streamlit/config.toml" ] || die "manifest: refusing to upload '$f' (only .streamlit/config.toml is allowed)";;
  esac
  case "$base" in
    *.py|*.js|*.css|*.json|*.yml|*.yaml|*.toml|*.txt|*.md|*.svg|*.png) ;;
    *) die "manifest: '$f' has a file type this script does not upload";;
  esac
  [ -f "$APP_DIR/$f" ] || die "manifest: '$f' does not exist"
  FILES+=("$f")
done < "$MANIFEST"
[ ${#FILES[@]} -gt 0 ] || die "manifest lists no files"
printf '%s\n' "${FILES[@]}" | grep -qx 'streamlit_app.py' || die "manifest must include streamlit_app.py"

if [ "$CHECK" = 1 ]; then printf 'upload %s\n' "${FILES[@]}"; exit 0; fi
[ -n "$WH" ] || die "--warehouse is required"
[ "$CONTAINER" = 0 ] || [ -n "$POOL" ] || die "--container needs --pool"

# ---------------------------------------------------------------- deploy
cli=(-c "$CONN"); [ -n "$CONN" ] || cli=()
sql() { snow sql "${cli[@]}" ${ROLE:+--role "$ROLE"} -q "$1" "${@:2}"; }
copy() { snow stage copy "$1" "$2" --overwrite "${cli[@]}" ${ROLE:+--role "$ROLE"} >/dev/null; }
if [ "$CONTAINER" = 1 ]; then
  RUNTIME="RUNTIME_NAME = 'SYSTEM\$ST_CONTAINER_RUNTIME_PY3_11' COMPUTE_POOL = $POOL ARTIFACT_REPOSITORIES = (snowflake.snowpark.pypi_shared_repository)"
else
  RUNTIME="RUNTIME_NAME = 'SYSTEM\$WAREHOUSE_RUNTIME'"
fi
STAGE="@$DB.$SCHEMA.${NAME}_SRC"
cd "$APP_DIR"
sql "CREATE STAGE IF NOT EXISTS $DB.$SCHEMA.${NAME}_SRC;" >/dev/null
for f in "${FILES[@]}"; do d=$(dirname "$f"); [ "$d" = "." ] && d=""; copy "$f" "$STAGE/$d"; done
sql "CREATE STREAMLIT IF NOT EXISTS $APP FROM '$STAGE' MAIN_FILE = 'streamlit_app.py'
     QUERY_WAREHOUSE = $WH $RUNTIME ${TITLE:+TITLE = '$TITLE'};" >/dev/null
sql "ALTER STREAMLIT $APP SET QUERY_WAREHOUSE = $WH $RUNTIME;" >/dev/null   # an existing app follows the flags too
sql "ALTER STREAMLIT $APP ADD LIVE VERSION FROM LAST;" >/dev/null 2>&1 || true
LIVE="snow://streamlit/$APP/versions/live"
for f in "${FILES[@]}"; do d=$(dirname "$f"); [ "$d" = "." ] && d=""; copy "$f" "$LIVE/$d"; done
sql "ALTER STREAMLIT $APP COMMIT;" >/dev/null
sql "ALTER STREAMLIT $APP ADD LIVE VERSION FROM LAST;" >/dev/null 2>&1 || true   # editable copy for next time

# ---------------------------------------------------------------- verify what is served
SERVED=$(sql "DESCRIBE STREAMLIT $APP;" --format json | python3 -c '
import json, sys
d = json.load(sys.stdin)
d = d[-1] if isinstance(d[0], list) else d
row = {k.lower(): v for k, v in d[0].items()}
print(row["default_version_location_uri"])')
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
snow stage copy "$SERVED" "$TMP" --recursive "${cli[@]}" ${ROLE:+--role "$ROLE"} >/dev/null
rc=0
for f in "${FILES[@]}"; do if cmp -s "$TMP/$f" "$f"; then echo "match $f"; else echo "DIFF  $f"; rc=1; fi; done
echo "deployed $APP ($( [ "$CONTAINER" = 1 ] && echo "container runtime on $POOL" || echo "warehouse runtime" ), queries on $WH)"
exit $rc
