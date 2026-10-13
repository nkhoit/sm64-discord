#!/usr/bin/env bash
# Installs the web release and the relay under $PREFIX and restarts the relay if its binary changed.
#
#   deploy/deploy.sh [--www DIR] [--relay FILE] [--restart | --no-restart]
#
#   --www DIR      install this web release (the output of `make TARGET_WEB=1 web-dist`) instead of building it
#   --relay FILE   install this sm64-relay binary instead of building it
#   --restart      restart the relay even if its binary didn't change
#   --no-restart   never restart the relay
#
# Environment:
#   PREFIX     install location (default ~/sm64)
#   SYSTEMCTL  how to run systemctl (default "systemctl --user"; "sudo systemctl" for a system unit)
#   SERVICE    the relay's unit (default sm64-relay.service)
#   KEEP       how many web releases to keep (default 3)
#
# Layout:
#   $PREFIX/releases/<time>/   one directory per web release
#   $PREFIX/www                symlink to the current release, switched atomically
#   $PREFIX/bin/sm64-relay
#   $PREFIX/data/              the relay's saves; created if missing, never written to by this script
#
# The relay reads files from www on every request, so a web-only deploy goes live without a restart.
# Restarting the relay ends any game in progress. Safe to run again: if a restart fails (or is skipped
# with --no-restart) after a new relay was installed, the next run restarts it.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PREFIX=${PREFIX:-$HOME/sm64}
SYSTEMCTL=${SYSTEMCTL:-systemctl --user}
SERVICE=${SERVICE:-sm64-relay.service}
KEEP=${KEEP:-3}

www_src=
relay_src=
restart=auto
while [ $# -gt 0 ]; do
    case $1 in
        --www) www_src=${2:?--www needs a directory}; shift 2 ;;
        --relay) relay_src=${2:?--relay needs a file}; shift 2 ;;
        --restart) restart=yes; shift ;;
        --no-restart) restart=no; shift ;;
        -h|--help) sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "$0"; exit 0 ;;
        *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
done

say() { printf '==> %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

[[ $KEEP =~ ^[1-9][0-9]*$ ]] || die "KEEP must be a positive integer, not '$KEEP'"
read -ra systemctl <<< "$SYSTEMCTL"
# A system unit runs the relay as another user (sm64), so this script mustn't create its data dir
system_unit=no
if [[ " $SYSTEMCTL " == *" sudo "* ]] || { [ "$EUID" -eq 0 ] && [[ $SYSTEMCTL != *--user* ]]; }; then
    system_unit=yes
fi

# Prints "yes" if the relay's unit is installed, "no" if systemd doesn't know it; fails on anything else
# (no user bus under cron or `sudo -u`, sudo asking for a password, ...).
unit_installed() {
    local err
    if err=$("${systemctl[@]}" cat "$SERVICE" 2>&1 >/dev/null); then
        echo yes
    elif [[ $err == *"No files found for"* ]]; then
        echo no
    else
        die "'$SYSTEMCTL cat $SERVICE' failed: $err"
    fi
}

# Build whatever wasn't given
if [ -z "$www_src" ]; then
    if ! command -v emcc >/dev/null; then
        emsdk_env=${EMSDK:-$HOME/emsdk}/emsdk_env.sh
        [ -f "$emsdk_env" ] || die "emcc not found; source emsdk_env.sh or pass --www"
        # shellcheck disable=SC1090
        source "$emsdk_env" >/dev/null 2>&1
    fi
    say "building the web release"
    make -C "$REPO" -j"$(nproc)" TARGET_WEB=1 web-dist >/dev/null
    www_src=$REPO/build/us_web/dist
fi
if [ -z "$relay_src" ]; then
    say "building the relay"
    cmake -S "$REPO/server" -B "$REPO/server/build" -DCMAKE_BUILD_TYPE=Release -Wno-dev >/dev/null
    cmake --build "$REPO/server/build" -j"$(nproc)" >/dev/null
    relay_src=$REPO/server/build/sm64-relay
fi

# Refuse anything that isn't a release dir, e.g. build/us_web with its object files
for f in index.html app.js sm64coopdx.js sm64coopdx.wasm sm64coopdx.data; do
    [ -f "$www_src/$f" ] || die "$www_src has no $f; pass the output of 'make TARGET_WEB=1 web-dist'"
done
[ ! -e "$www_src/src" ] || die "$www_src looks like a build dir, not a release; use build/us_web/dist"
[ -x "$relay_src" ] || die "$relay_src is not an executable"

if [ ! -d "$PREFIX/data" ] && [ "$system_unit" = yes ]; then
    die "$PREFIX/data doesn't exist; create it owned by the relay's user first (sudo install -d -o sm64 -g sm64 -m 700 $PREFIX/data, see deploy/README.md)"
fi
mkdir -p "$PREFIX/releases" "$PREFIX/bin"
exec 9>"$PREFIX/.deploy.lock"
flock -n 9 || die "another deploy is running"

if [ ! -d "$PREFIX/data" ]; then
    mkdir -m 700 "$PREFIX/data"
    say "created $PREFIX/data"
fi

# Decide about the restart before anything goes live, so a broken systemctl stops the deploy early.
# The marker survives a failed or skipped restart, so the next run still restarts the new relay.
pending=$PREFIX/.restart-pending
relay_changed=yes
if cmp -s "$relay_src" "$PREFIX/bin/sm64-relay"; then relay_changed=no; fi
want_restart=no
if [ "$restart" = yes ] || { [ "$restart" = auto ] && { [ "$relay_changed" = yes ] || [ -e "$pending" ]; }; }; then
    want_restart=yes
    installed=$(unit_installed)
fi

# Web release
if [ -e "$PREFIX/www" ] && [ ! -L "$PREFIX/www" ]; then
    die "$PREFIX/www is a real directory; move it away so it can become a symlink"
fi
if [ -L "$PREFIX/www" ] && diff -rq "$www_src" "$PREFIX/www/" >/dev/null 2>&1; then
    say "web release unchanged ($(readlink "$PREFIX/www"))"
else
    name=$(date -u +%Y%m%d-%H%M%S)
    n=1
    while [ -e "$PREFIX/releases/$name" ]; do n=$((n + 1)); name=$(date -u +%Y%m%d-%H%M%S)-$n; done
    incoming=$PREFIX/releases/.incoming-$$
    trap 'rm -rf "$incoming" "$PREFIX/www.new"' EXIT
    rm -rf "$incoming"
    mkdir "$incoming"
    # keep file times: the relay only serves a .br/.gz copy that is at least as new as its original
    cp -R --preserve=timestamps "$www_src/." "$incoming/"
    chmod -R a+rX "$incoming"
    mv "$incoming" "$PREFIX/releases/$name"
    ln -sfn "releases/$name" "$PREFIX/www.new"
    mv -T "$PREFIX/www.new" "$PREFIX/www"
    trap - EXIT
    say "web release $name is live"

    # Drop old releases, newest first, never the current one
    current=$(basename "$(readlink "$PREFIX/www")")
    find "$PREFIX/releases" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -printf '%f\n' | sort -r |
        tail -n +$((KEEP + 1)) | while read -r old; do
            [ "$old" = "$current" ] || rm -rf "${PREFIX:?}/releases/$old"
        done
fi

# Relay binary
if [ "$relay_changed" = yes ]; then
    install -m 755 "$relay_src" "$PREFIX/bin/.sm64-relay.new"
    touch "$pending"
    mv -f "$PREFIX/bin/.sm64-relay.new" "$PREFIX/bin/sm64-relay"
    say "installed $PREFIX/bin/sm64-relay"
else
    say "relay unchanged"
fi

if [ "$want_restart" = no ]; then
    if [ -e "$pending" ]; then say "the relay wasn't restarted; the next deploy will restart it"; fi
elif [ "$installed" = no ]; then
    # Nothing is running this binary, and starting the unit later picks it up
    rm -f "$pending"
    say "$SERVICE isn't installed; skipping the restart (see deploy/README.md)"
else
    "${systemctl[@]}" restart "$SERVICE" || die "restarting $SERVICE failed; fix it and run this again to retry"
    rm -f "$pending"
    say "restarted $SERVICE"
fi
