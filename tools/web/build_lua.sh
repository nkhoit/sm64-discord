#!/bin/sh
# Rebuilds lib/lua/web/liblua53.a (Lua 5.3.5) with Emscripten.
# Usage: tools/web/build_lua.sh   (emcc must be on PATH)
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
git clone -q --depth 1 --branch v5.3.5 https://github.com/lua/lua.git "$WORK/lua"
cd "$WORK/lua"
for f in *.c; do
    case "$f" in lua.c|luac.c|ltests.c) continue ;; esac
    emcc -O2 -DLUA_COMPAT_5_2 -c "$f" -o "${f%.c}.o"
done
mkdir -p "$ROOT/lib/lua/web"
emar rcs "$ROOT/lib/lua/web/liblua53.a" ./*.o
rm -rf "$WORK"
