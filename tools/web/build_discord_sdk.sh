#!/bin/sh
# Rebuilds web/vendor/discord-sdk.js: Discord's Embedded App SDK (MIT) bundled into one ES module,
# so the Activity loads it from our own server (Discord's CSP blocks outside script hosts).
# Usage: tools/web/build_discord_sdk.sh [version]   (needs node and npm)
set -e
VERSION="${1:-2.5.0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
cd "$WORK"
npm init -y >/dev/null
npm install --silent "@discord/embedded-app-sdk@$VERSION" esbuild
echo "export { DiscordSDK, patchUrlMappings } from '@discord/embedded-app-sdk';" > entry.mjs
mkdir -p "$ROOT/web/vendor"
npx esbuild entry.mjs --bundle --format=esm --minify --outfile="$ROOT/web/vendor/discord-sdk.js"
rm -rf "$WORK"
