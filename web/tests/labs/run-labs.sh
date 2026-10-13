#!/usr/bin/env bash
# Runs the browser labs against a local relay serving a WEB_TEST_HOOKS=1 build.
#   ROM=path/to/baserom.us.z64 web/tests/labs/run-labs.sh [controls|pause|all]
# Env (all optional except ROM):
#   RELAY  relay binary            (default: server/build/sm64-relay)
#   DIST   web build to serve      (default: build/us_web/dist)
#   OUT    where results go        (default: $TMPDIR/sm64-labs)
#   PORT   first local port to use (default: 8124; the labs use PORT..PORT+2)
# Playwright: cd web/tests/labs && npm install && npx playwright install chromium. The labs run
# full Chromium (channel "chromium"), not chrome-headless-shell, whose WebGL can't run the game.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
LABS="$ROOT/web/tests/labs"
LAB=${1:-all}
: "${ROM:?set ROM to your own baserom.us.z64 (it is never copied into the repo)}"
ROM=$(realpath "$ROM")
RELAY=${RELAY:-$ROOT/server/build/sm64-relay}
DIST=${DIST:-$ROOT/build/us_web/dist}
OUT=${OUT:-${TMPDIR:-/tmp}/sm64-labs}
PORT=${PORT:-8124}
[ -x "$RELAY" ] || { echo "no relay at $RELAY: cmake -S server -B server/build && cmake --build server/build"; exit 1; }
[ -f "$DIST/sm64coopdx.wasm" ] || { echo "no web build in $DIST: make TARGET_WEB=1 WEB_TEST_HOOKS=1 web-dist"; exit 1; }

PIDS=(); DIRS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && wait "$p" 2>/dev/null || true; done
  for d in "${DIRS[@]:-}"; do [ -n "$d" ] && rm -rf -- "$d"; done
  PIDS=(); DIRS=()
}
trap cleanup EXIT
waitport() { timeout 15 bash -c "until (echo > /dev/tcp/127.0.0.1/$1) 2>/dev/null; do sleep 0.2; done"; }
relay() { # port, log, extra env...
  local port=$1 log=$2 data; shift 2
  data=$(mktemp -d "${TMPDIR:-/tmp}/sm64-lab-relay.XXXXXX"); DIRS+=("$data")
  # local only: --allow-lan-test lets anyone who can reach the port play without Discord
  env "$@" "$RELAY" --bind 127.0.0.1 --port "$port" --www "$DIST" --data "$data" --allow-lan-test > "$log" 2>&1 &
  PIDS+=($!); waitport "$port"
}

status=0
run_controls() {
  local o="$OUT/controls"; mkdir -p "$o"
  relay "$PORT" "$o/relay.log"
  node "$LABS/controls-lab.mjs" "http://127.0.0.1:$PORT" "$ROM" "$o" | tee "$o/controls.log" || status=1
  cleanup
}
run_pause() {
  local o="$OUT/pause" mock=$((PORT + 2)); mkdir -p "$o"
  # the hosted-ROM relay signs players in against the repo's mock Discord API (which listens on 127.0.0.1)
  python3 "$ROOT/server/tests/mock_discord.py" "$mock" > "$o/mock.log" 2>&1 & PIDS+=($!); waitport "$mock"
  relay "$PORT" "$o/relay-hosted.log" SM64_ROM_PATH="$ROM" DISCORD_GUILD_IDS=1 DISCORD_CLIENT_ID=1 \
    DISCORD_CLIENT_SECRET=mock-secret DISCORD_API_BASE="http://127.0.0.1:$mock"
  relay "$((PORT + 1))" "$o/relay-lan.log"
  node "$LABS/pause-lab.mjs" "http://127.0.0.1:$PORT" "http://127.0.0.1:$((PORT + 1))" "$ROM" "$o" | tee "$o/pause.log" || status=1
  cleanup
}
case $LAB in
  controls) run_controls ;;
  pause) run_pause ;;
  all) run_controls; run_pause ;;
  *) echo "usage: ROM=... $0 [controls|pause|all]"; exit 2 ;;
esac
echo "results in $OUT"
exit $status
