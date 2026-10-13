# Browser build

Builds sm64coopdx to WebAssembly with Emscripten (SDL2 + WebGL). The output is
`build/us_web/` (`index.html`, `sm64coopdx.js`, `.wasm`, `.data`).

```sh
source /path/to/emsdk/emsdk_env.sh
make -j TARGET_WEB=1 web-dist
cd build/us_web/dist && python3 -m http.server 8000
```

`web-dist` copies just the served files (`index.html`, `boot.js`, `app.js`, `diagnostics.js`, `sm64coopdx.js/.wasm/.data`,
`vendor/`) to `build/us_web/dist`; serve or deploy that rather than `build/us_web`, which also
holds the object files. `WEB_PRECOMPRESS=1` adds `.gz` (and `.br` with brotli installed) copies,
which the relay sends to browsers that accept them (see `server/README.md`, "Static files"). That
saves compressing the 32 MB `.wasm` on every download when nothing in front of the relay
compresses; Cloudflare and the Caddy setup in `deploy/` compress on the fly anyway.

If you built `TARGET_WEB=1` before release builds dropped debug info, run `rm -rf build/us_web`
(or `make clean`) once: the Makefile doesn't track compiler flags, so the old objects would be
relinked into the 60 MB debug `.wasm`. Check that `sm64coopdx.wasm` is about 32 MB.

For co-op, serve it with the relay instead (see `server/README.md`). The relay serves only
`index.html`, `web/boot.js` and `vendor/` to anyone: `boot.js` signs in, gets an asset session and then
loads the game files (`sm64coopdx.*`, `app.js`, `diagnostics.js`) with it. The page (`web/app.js`)
has two modes:

- **Discord**: launched as an Activity (the URL has `frame_id`). It signs in with the Embedded
  App SDK (`web/vendor/discord-sdk.js`, rebuilt with `tools/web/build_discord_sdk.sh`), and
  everyone in the same Discord server plays in one world on one save. Desktop only for now: when
  Discord's mobile app opens it (`platform=mobile`), the page says so and doesn't download the game.
- **LAN test**: with the relay started with `--allow-lan-test`, open
  `http://<relay>:8080/?room=test&name=Mario` in two windows on the local network. The first
  hosts and the second joins. Without the flag the page says to open it from Discord. If the relay
  has a hosted ROM configured, direct local LAN testing downloads it in memory too; LAN ROM delivery
  is never allowed through a proxy or Discord Activity.

## Client debug panel & reports

The small **Debug** button opens local General, Audio, Performance, Connection, and Errors counters.
The panel stays available offline and before sign-in. Audio measurements come from the existing web
stats hook, the Web Audio callback timing, and bounded sampling of at most 256 frames from up to two
channels every eighth callback. Sample arrays are inspected transiently only; they are never retained
or uploaded. The client does not record microphone input, voice, or game-audio recordings, and it does
not include raw console output, error messages/stacks, usernames, Discord IDs, device IDs, or URL query
parameters. Error events are reduced to a known error class.

Automatic reports are enabled by default when the relay's config enables `diagnostics` and a session
ticket has been assigned. The client samples once per second in memory, keeps at most six recent
samples, and posts a bounded report about every 15 seconds while the game page is visible and playing;
runtime errors are coalesced. The category buttons send an immediate audio, performance, network,
runtime, or other issue report. Reports use the same-origin `/api/diagnostics` endpoint (under
`/.proxy/` inside Discord) and contain only the existing session ticket plus allowlisted numeric/state
fields. No report text or persistent report queue is used. The checkbox opts out immediately and saves
that boolean preference in this browser's local storage. Turning reporting off, or a relay config with
`diagnostics: false`, stops uploads while leaving local diagnostics available. Audio queue, callback,
clipping, and timing counters are observations; they cannot prove the cause of reported static. The
client-only deterministic checks (no relay, ROM, or credentials) run with:

```sh
node web/tests/diagnostics-test.cjs
node web/tests/hosted-rom-bootstrap-test.cjs
```

With a relay that has no hosted ROM, Discord and LAN sessions keep the BYO flow: the page asks for
an operator/client-owned US Super Mario 64 ROM (`.z64`) if one is not already in browser storage.
When hosted delivery is configured, Discord sign-in and the guild allowlist are checked first, then
the browser downloads the bytes before requesting a room ticket. It skips the file picker even if an
old ROM exists in browser storage, and keeps the hosted bytes only in the page's in-memory filesystem
(not IndexedDB). Local game settings in `/save` also reset on reload in hosted mode; the shared
world save is still restored from and uploaded to the relay. A denied or failed hosted download
does not fall back to a local ROM. Authorized
clients receive the ROM bytes; this gate is not DRM or a redistribution license.

The host uploads the save to the relay within about a second of the game writing it, and once more
as the page closes. When the relay closes the connection, the page shows why and rejoins by itself:
after a short random countdown if the host left (the first page back hosts), or with backoff
(2, 4, 8, 15, 30 s) after other drops, checking that the server answers before reloading. It stops
and shows a Rejoin button after the last retry, after 6 rejoins in 5 minutes, or when the world is
full.

Open http://localhost:8000 for single player: without a relay behind it the page skips sign-in and
plays offline. In this ordinary BYO mode, on first run it asks for your own US Super Mario 64 ROM
(`.z64`); it is stored in the browser's IndexedDB and never uploaded anywhere.
Extra command-line arguments can be passed with
`?args=...` (for example `?args=--skip-intro`).

Release builds have no debug info. For debugging, `make clean` first (flags aren't tracked), then
`make TARGET_WEB=1 DEBUG=1` (`-O0`, DWARF), or `DEBUG_INFO_LEVEL=2` to keep `-O2` with DWARF, or
`EXTRA_WEB_LDFLAGS="-sASSERTIONS=2 --profiling-funcs"` for assertions and function names.

## Differences from the desktop build

- `TARGET_WEB=1` turns off the Discord Game SDK, CoopNet and the updater.
- Rendering uses the existing GLES2 path (`USE_GLES`), which maps to WebGL.
- The game runs with `-sASYNCIFY`, and `gfx_sdl` yields to the browser once per
  frame, so the existing blocking loops (loading screen, main loop) work unchanged.
- The upstream sound data (`sound/sound_data_compressed.*`, `sound/sequences_compressed.bin`) is laid
  out for 64-bit pointers. The build converts it for wasm32 with `tools/web/sound_data_32bit.py`,
  keeping the samples and sequences at the offsets the game copies them to from the ROM.
- "Direct connection" networking uses `src/pc/network/websocket/` instead of UDP sockets.
- `Module._web_debug_players()` returns the connected players, names and positions as JSON (used by `web/tests/coop-test.cjs`).
- `Module._web_debug_controls(preset)` (only in builds made with `WEB_TEST_HOOKS=1`) sets the control preset (0 Classic, 1 Mouse + Keyboard, -1 only reports) and returns
  preset, camera and pointer-lock state as JSON (used by the mouse+keyboard lab).
- `Module._web_debug_stats()` returns game ticks (30 per second is normal speed), drawn frames, time per
  tick and the audio queue as JSON (used by `web/tests/perf-test.cjs`).
- In the browser the main loop waits for `requestAnimationFrame` and draws frames until the next 30 Hz
  tick is due; when drawing can't keep up it skips frames rather than slowing the game down.
- The game connects to `Module.relayUrl` as given (the page puts the ticket in it) and calls `Module.onRelayClosed(code, reason)` when the relay drops it.
- Lua is linked from `lib/lua/web/liblua53.a`; rebuild it with `tools/web/build_lua.sh`.

## Restricted networks

If Emscripten can't download its SDL2/zlib ports (codeload.github.com blocked),
clone `libsdl-org/SDL` at `release-2.32.10` and `madler/zlib` at `v1.3.2` with
git, copy them to `<emsdk>/upstream/emscripten/cache/ports/sdl2/SDL-release-2.32.10`
and `.../ports/zlib/zlib-1.3.2`, write each port's URL into a `.emscripten_url`
file in `ports/sdl2` and `ports/zlib`, then run `embuilder build sdl2 zlib`.
