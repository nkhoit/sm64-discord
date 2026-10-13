# sm64-relay

A small C++17 server (Boost.Asio/Beast, single-threaded) that:

- serves the browser build (`build/us_web`) over HTTP,
- signs players in with Discord and checks they belong to the server (guild) they launched from,
- optionally delivers the operator-configured read-only hosted ROM after an independent identity,
  membership, and `DISCORD_GUILD_IDS` allowlist check,
- relays co-op packets over WebSockets at `/ws?ticket=...`, one room per Discord server, and
- keeps one save file per Discord server.

Discord Activities can only use WebSockets through Discord's proxy, so every
packet goes through this relay instead of UDP. Requests under `/.proxy/` are
treated like the same path without the prefix, to match Discord's URL mapping.

```sh
sudo apt install libboost-dev libssl-dev   # Boost >= 1.75 (headers only), OpenSSL
cmake -S server -B server/build -DCMAKE_BUILD_TYPE=Release
cmake --build server/build -j
DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... \
    server/build/sm64-relay --port 8080 --www build/us_web --data relay-data
```

| Option | Meaning |
| --- | --- |
| `--port` | HTTP and WebSocket port (default 8080) |
| `--www` | the browser build to serve (default `build/us_web`). Only `.html .js .wasm .data .css .png .ico .json` files are served, so build objects next to them never are. |
| `--data` | where saves and diagnostic reports are kept (default `relay-data`; see [Saves](#saves) and [Diagnostics](#diagnostics-and-privacy)) |
| `--rom` | optional absolute hosted ROM path when `SM64_ROM_PATH` is unset; environment variable takes precedence |
| `--allow-lan-test` | let plain browsers on the local network play without Discord (see below). **Leave off on a public server.** It also gates direct LAN hosted-ROM downloads. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | the Discord application's OAuth2 credentials. Without them, Discord sign-in is off. |
| `DISCORD_GUILD_IDS` | comma-separated numeric Discord server IDs allowed to download a configured hosted ROM and to submit hosted-session diagnostics. Required with `SM64_ROM_PATH`; it does not restrict legacy BYO sessions. |
| `SM64_DIAGNOSTICS` | disable diagnostics ingestion with the exact value `0`; enabled by default. |
| `SM64_ROM_PATH` | optional absolute path to the operator's ROM. Must resolve to a readable, nonempty regular file outside the canonical `--www` tree and be at most 32 MiB. Loaded once into relay memory at startup; invalid configuration stops startup. |
| `DISCORD_API_BASE` | only for tests: point Discord API calls at `server/tests/mock_discord.py` |

## How a player gets in

1. Inside Discord the page signs in with the Embedded App SDK (`authorize`), and the relay
   exchanges the code for a token (`POST /api/token`).
2. If hosted delivery is configured, the page requests `POST /api/rom` with the token and SDK's
   `guild_id` before reserving a room. The relay requires the server ID in `DISCORD_GUILD_IDS`, then
   verifies the user and live/cached membership with Discord. The binary response is `no-store`; no
   ticket can substitute for this check. The browser writes the bytes to its in-memory `/save` tree.
3. `POST /api/session` with the token and the SDK's `guild_id`. The relay again asks Discord who the
   player is and whether they are a member of that server (`guilds.members.read`), so a player can't
   join another server's save by editing the request.
4. The answer is a ticket and a role. The first player into an empty room hosts; while that host
   is still loading, everyone else gets `409 {wait:true}` and retries, so a room never has two hosts.
5. The host downloads the server's save (`GET /api/save?ticket=`) before the game starts and
   uploads it within a second or two of a change (`PUT /api/save?ticket=`). Only the host's
   ticket can do either; a host that just left may still upload for 30 seconds (until someone
   else starts hosting), so the upload its page sends while closing isn't lost. Clients get the
   save from the host when they join, as in normal sm64coopdx.
6. The game connects to `/ws?ticket=...`. Unused tickets expire after 90 seconds.

When the host leaves, the room closes (`host left`) and every other page rejoins by itself after a
3–6 second countdown, spread at random: it reloads, signs in again silently, and the first one back
becomes the new host and loads the last uploaded save while the rest wait for it (`409`) and join.
Other drops retry the same way with backoff for about a minute, then show a Rejoin button. See
`web/app.js`. (No seamless host migration yet: everyone briefly reloads.)

## Hosted ROM safety and configuration

Hosted delivery is opt-in. Set `SM64_ROM_PATH` to an absolute path readable by the relay user and
`DISCORD_GUILD_IDS` to a comma-separated allowlist of numeric server IDs. A path passed through
`--rom FILE` is used only when the environment variable is unset. The relay requires an allowlist
whenever a path is configured, resolves symlinks, refuses a file inside the canonical `--www` tree,
requires a readable nonempty regular file no larger than 32 MiB, and loads it once at startup so HTTP
requests do not block the relay's I/O thread on disk. Invalid or missing configuration fails startup;
with no ROM configured, legacy BYO behavior remains active.

`POST /api/rom` accepts the same Discord mode, access token, and guild ID as session creation. It
checks the guild allowlist and verifies the token's user and guild membership with Discord (reusing
the short-lived server-side membership cache); tickets and client assertions are not sufficient.
LAN test delivery is possible only with `--allow-lan-test`, from a local direct connection, and is
refused through forwarded/proxy requests. Responses use `application/octet-stream`, `no-store`, and
`nosniff`; static serving refuses symlinks outside the canonical web root and any hard-link alias to the
configured ROM's startup file identity, including precompressed candidates. That identity remains
protected if the source pathname is later replaced or removed.

This sends the configured game bytes to authorized clients. Authentication is an access-control
boundary, not DRM and not a redistribution license. Keep the source file and env file appropriately
permissioned and use only a copy for which you have the applicable rights. For deployment/restart
and rollback steps see [`deploy/README.md`](../deploy/README.md).

## Diagnostics and privacy

The relay accepts only authenticated `POST /api/diagnostics` (including Discord's `/.proxy/` path).
A report must carry an existing Relay ticket and match the version-1 bounded schema; tickets are
resolved in memory, and the server derives the room and `host`/`client` role. Pending unexpired tickets
are valid. Hosted reports require the ticket's guild to exactly match `DISCORD_GUILD_IDS`. LAN reports
require a legacy ticket created through `--allow-lan-test`, a direct local-network connection, and the
same forwarded/proxy refusal as LAN session creation. `GET` never reads reports. The endpoint can be
disabled by setting `SM64_DIAGNOSTICS=0` before launch; restart the process to apply environment changes.

Reports are written on a dedicated single-thread worker to `<dataDir>/diagnostics`, outside the
canonical `--www` tree. The directory is mode `0700`, JSONL files are `0600`, each file is limited to
8 MiB, total storage to 64 MiB, and retention to seven days. Ingestion allows 16 KiB per body, at most
32 pending writes globally, and a burst of four then one report per ticket per five seconds. Unsafe,
full, or unavailable storage fails the report with `503`; it does not block room I/O or stop the relay.

Stored rows contain UTC receive time, a random pseudonymous session ID, the allowlisted guild key
or coarse `lan` marker, the server-derived role, and the sanitized payload without the ticket. They
never persist Discord user IDs, IPs, names, OAuth tokens, ROM/audio/voice samples, error messages, stacks,
URLs, console strings, or device IDs.
The schema accepts only bounded counters/indicators and fixed enums. The remote values are untrusted;
for example, a high `boundaryJumps` count or callback gap does **not** prove crackling or identify an
audio defect. Do not treat a report as a substitute for reproduction or as proof of a particular cause.

Owners can summarize recent records without handing files to the player:

```sh
python3 server/tools/diagnostics-summary.py relay-data/diagnostics --last 100 --hours 24
```

Defaults are limited to the latest 100 records and 24 hours; at most 16 files/64 MiB are streamed, and
malformed lines are skipped. The summary shows categories, pseudonymous session counts, and aggregate
audio indicators only; it never prints raw reports or ticket values. Treat remote data as untrusted.

## Static files


Every file is sent with `ETag`, `Last-Modified` and `Cache-Control: no-cache`. The file names
aren't content-hashed, so browsers check on every load, but an unchanged file (including the
large `.wasm` and `.data`) costs only a `304`. ETags are compared weakly, since Cloudflare marks
them weak when it compresses.

If `<file>.br` or `<file>.gz` exists, is at least as new as `<file>`, and the client accepts that
encoding, it is sent instead with `Content-Encoding` (Brotli preferred). This is optional:
Cloudflare and Caddy can compress on their own.

## Limits

All in `src/limits.hpp`. None of them use IP addresses: behind Discord's proxy or a tunnel every
player has the proxy's address, and the headers carrying the real one can be forged when the relay
is reachable directly.

| Limit | Value | When it's hit |
| --- | --- | --- |
| Players per room, host included | 16 (sm64coopdx's `MAX_PLAYERS`) | `409 {full:true}`; the page says the world is full |
| Rooms at once | 64 | `503`, for a server that has no room yet; existing rooms keep working |
| Tickets + connections per Discord account | 3 | `429`; leaves room for a reload while the old connection closes |
| Discord API calls waiting at once | 32 | `503`, try again |
| WebSocket message size | 4 KiB (packets are ≤ 3000 bytes) | connection closed (1009) |
| Messages per second, client | 300, bursts of 2000 | extra messages are dropped; more than 300 dropped in a second closes the connection (`sending too fast`) |
| Messages per second, host | 1500 per connected client, bursts of 6000 per client (22,500/s with 15 clients) | extra messages are dropped; the host is never disconnected for this, since that would end the room |
| Unsent data queued for one player | 4 MiB | that player is disconnected (`connection too slow`) |
| Save uploads per room | 1 every 2 s, bursts of 10 | `429`; the page tries again on its next check |
| Hosted ROM downloads per identity | 1 every 2 s, bursts of 2; rate state capped at 1024 identities | `429`; wait before retrying. At the cap, only new identities fail closed with `503`; existing buckets are preserved |
| Hosted ROM response bodies in flight | 64 MiB aggregate and at most 4 responses | `503` before allocating a response copy; a lease is held until write completion, disconnect, or deadline |
| HTTP response write deadline | 30 s | stalled HTTP response is closed; hosted-ROM capacity is released with the write callback |
| Diagnostic report body | 16 KiB | `413`; unknown fields and values outside the versioned schema are rejected |
| Diagnostic writes waiting or running | 32 globally; one storage worker | `503`; saves, room I/O and Discord calls use separate paths |
| Diagnostic reports per ticket | burst of 4; 1 per 5 s sustained; 1024 ticket states | `429` per-ticket rate limit; at state-map capacity only expired/inactive tickets are pruned and new state fails closed |
| Diagnostic storage | 8 MiB per JSONL file; 64 MiB total; 7-day retention | `503`; startup and each append enforce bounds |

Save uploads are written one at a time, in the order they arrive, on their own thread (not the one
that waits on Discord). The page numbers its uploads (`&seq=`), and an upload older than one already
stored for the same ticket is ignored (`200 {stale:true}`). That can happen when the upload sent as
the page closes overtakes one still in flight. An upload identical to the current save writes
nothing.

The browser build sends one WebSocket message per packet per recipient, and the host relays every
player's state to every other player at 30 per second while they move. So the host sends about
30 × (N − 1)² messages per second for player state alone: ~1,500 with 8 players, ~6,750 with 16.
That's why its allowance grows with the room. A client sends its own state (30/s) plus acks and
object updates. A peer over its rate is logged at most every 10 seconds, with how many messages
were dropped (`journalctl ... | grep "over its message rate"`).

Membership checks are remembered for 5 minutes per (token, server), so players waiting for a host
don't ask Discord again on every retry.

**Keepalive:** a WebSocket that has been quiet for 15 seconds gets a ping, and one that sends
nothing at all (not even the pong) for 30 seconds is closed. This keeps proxies that drop idle
connections (Cloudflare after ~100 s) from cutting off a quiet player, and notices a vanished one.

## Saves

```
relay-data/
  g<guild id>.bin                          the server's current save
  snapshots/g<guild id>/<UTC time>-00.bin  earlier versions
```

An upload is only stored if it could have come from the game: exactly 512 bytes (the EEPROM
image), with the first copy of each save file and of the menu data either blank or carrying its
magic number and checksum (see `src/game/save_file.c`). Anything else gets `400`. Every file is
written to a temporary name, synced and renamed, so a crash leaves the old or the new version.

Each upload that changes the save also becomes a snapshot. The newest 10 snapshots are kept, plus
the newest one of each of the last 7 days (UTC). A save that existed before snapshots did (with a
`.prev.bin` next to it) is snapshotted, dated by its file time, before the first upload replaces it;
old `.prev.bin` files are left alone and can be deleted.

To roll a server back, copy a snapshot over the current save. The relay reads it fresh whenever a
host starts, so this works while it runs, but do it while nobody is playing (the current host would
upload over it):

```sh
cp relay-data/snapshots/g123/20261011T201500.123Z-00.bin relay-data/g123.bin.new
mv relay-data/g123.bin.new relay-data/g123.bin
```

## LAN test mode

`--allow-lan-test` lets a plain browser play without Discord, using `?room=name&name=Player` in
the page URL (rooms are prefixed `lan-` so they never touch a Discord server's save). It is only
accepted when:

- the relay was started with the flag,
- the request comes straight from a loopback or private address (10/8, 172.16/12, 192.168/16,
  link-local, fc00::/7), and
- it has none of the headers a proxy or CDN adds: `Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`,
  `True-Client-IP`, or any `CF-*` header. A reverse proxy (Caddy, nginx, Discord's own) adds one of
  these, and cloudflared, which connects from loopback, adds `CF-Connecting-IP` and `CF-Ray`, so
  putting the relay behind one turns LAN mode off for anything coming through it.

Without the flag, a plain browser just sees "Open this activity from Discord."

## Hosting

See [`deploy/`](../deploy/README.md): `deploy/deploy.sh` installs a release, with example systemd units for
running it behind a Cloudflare tunnel or a reverse proxy (Caddy or nginx), and the Discord Developer
Portal settings. Serve the output of `make TARGET_WEB=1 web-dist` (`build/us_web/dist`) rather than
`build/us_web`, and leave `--allow-lan-test` off on a public server.

## Protocol

Each WebSocket message is `[u32 peer, little-endian][sm64coopdx packet]`. Clients
send with the destination peer (always the host, peer 0); the relay delivers with
the source peer. The host can address any client.

## Tests

```sh
python3 server/tests/mock_discord.py 8199 &
DISCORD_CLIENT_ID=1 DISCORD_CLIENT_SECRET=mock-secret DISCORD_API_BASE=http://127.0.0.1:8199 \
    server/build/sm64-relay --port 8124 --www build/us_web --data /tmp/relay-data --allow-lan-test &
mkdir -p /tmp/relay-www-2   # api-test.cjs writes its static file fixtures here
server/build/sm64-relay --port 8125 --www /tmp/relay-www-2 --data /tmp/relay-data-2 &

# API: static files, sign-in, membership checks, LAN mode refusals, limits, keepalive, saves
# (needs fresh relays; takes ~35 s)
node server/tests/api-test.cjs http://127.0.0.1:8124 http://127.0.0.1:8125 /tmp/relay-data /tmp/relay-www-2

# Authenticated diagnostics schema, ticket policy, privacy, bounds and owner CLI; starts isolated mock relays.
TMPDIR="${TMPDIR:-/tmp}" node server/tests/diagnostics-runner.cjs server/build/sm64-relay

# Hosted-ROM source-only coverage; uses labeled synthetic bytes, not a game ROM. The runner starts
# its own mock Discord and five relays on ephemeral loopback ports, then stops only those processes.
# The large-fixture test stalls synthetic 32 MiB downloads to exercise aggregate response leases and
# their disconnect/write-deadline cleanup. These checks do not prove game-engine compatibility.
ctest --test-dir server/build --output-on-failure
node server/tests/hosted-rom-config-test.cjs server/build/sm64-relay
node web/tests/hosted-rom-bootstrap-test.cjs
node server/tests/hosted-rom-runner.cjs server/build/sm64-relay

# Players in headless Chromium. "discord" mocks the Embedded App SDK and also checks the mobile
# message, the save upload, and that when the host closes its tab the other two rejoin on their own
# (one hosting the uploaded save). "lan" also checks retrying while the server is unreachable.
# Restart the first relay between runs.
NODE_PATH=$(npm root -g) node web/tests/coop-test.cjs http://localhost:8124 baserom.us.z64 discord /tmp/relay-data
NODE_PATH=$(npm root -g) node web/tests/coop-test.cjs http://localhost:8124 baserom.us.z64 lan

# Single player game speed (30 ticks/s) and sound, inside a cross-origin iframe like Discord's. Serves
# the build itself on ports 8432-8433; add --gpu to render with the GPU instead of SwiftShader.
NODE_PATH=$(npm root -g) node web/tests/perf-test.cjs build/us_web baserom.us.z64
```
