# Browser labs

End-to-end checks that boot the real game in full Chromium against a local relay. They need a ROM and a
test build, so they are not part of CI.

| Lab | Checks |
|---|---|
| `controls-lab.mjs` | Every control preset and bind, mouse look, pointer lock across pause, resume, chat and the console, and configs saved by older builds |
| `pause-lab.mjs` | The pause menu has no Server Settings, Stop Hosting or Disconnect, the disconnect key does nothing, and stock server settings apply (the player limit is always 16) whatever the saved config says |

`mkb-probe.lua` is a small mod that the controls lab installs into the game's `/save/mods` to log
controller state.

## Running

From the repository root:

```sh
# 1. a web build with the test hooks (Module._web_debug_* etc.)
make -j"$(nproc)" TARGET_WEB=1 WEB_TEST_HOOKS=1 web-dist
# 2. the relay
cmake -S server -B server/build -DCMAKE_BUILD_TYPE=Release && cmake --build server/build -j"$(nproc)"
# 3. Playwright with full Chromium
npm i playwright && npx playwright install chromium
# 4. the labs, with your own ROM (it is only read, never copied into the repo)
ROM=path/to/baserom.us.z64 web/tests/labs/run-labs.sh controls   # or: pause, all
```

`run-labs.sh` starts the relay (and, for the pause lab, a second relay with a hosted ROM plus the mock
Discord API from `server/tests/mock_discord.py`) on `PORT`..`PORT+2` (default 8124). It runs the lab and
stops everything when done. Results (`*-results.json`, logs, screenshots) go to `OUT`
(default `$TMPDIR/sm64-labs`). `RELAY` and `DIST` override the relay binary and the build directory.
The script exits non-zero if a check fails.

The labs launch Playwright's `chromium` channel, which is full Chromium in new headless mode. Don't use
`chrome-headless-shell`; its WebGL can't run the game.

## Timing

The game reads input once per frame (30/s). A Playwright `keyboard.press()` releases the key about a
millisecond after pressing it, so on a busy machine the game can miss it entirely. One missed pause or
resume key then makes every check after it fail. The labs therefore hold keys for 200 ms and wait for
the expected state (for example the cursor being released) instead of sleeping a fixed time. Results are
most reliable on an otherwise idle machine. Run one lab at a time, since two runs compete for the CPU
(and for the ports).
