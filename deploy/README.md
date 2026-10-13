# Deploying

The Activity is two things: the browser build (static files) and `sm64-relay`, which serves those
files, signs players in and relays packets. Discord only loads Activities over HTTPS, so the relay
always sits behind something that terminates TLS: for example a Cloudflare tunnel, or Caddy/nginx on a server.
By default the relay does not need the game ROM. For optional hosted delivery, the operator places a
readable copy on the relay host; deployment never copies it into the web release.

| File | What it is |
| --- | --- |
| `deploy.sh` | builds (or takes) the web release and the relay, installs them under `$PREFIX`, restarts the relay if its binary changed |
| `sm64-relay.env.example` | the relay's `EnvironmentFile`: Discord client credentials, the asset session secret, and optional hosted-ROM path/allowlist |
| `examples/sm64-relay.user.service` | systemd user unit for the relay (`%h` paths, option A) |
| `examples/sm64-tunnel.user.service` | systemd user unit for `cloudflared tunnel run sm64` (option A) |
| `examples/cloudflared-tunnel.yml` | example `~/.cloudflared/sm64.yml`: `sm64.example.com` → `http://127.0.0.1:8080` |
| `examples/sm64-relay.system.service` | hardened systemd system unit for the relay (option B) |
| `examples/Caddyfile`, `examples/nginx.conf` | TLS, compression and WebSocket proxying in front of the relay (option B) |

## deploy.sh

```sh
deploy/deploy.sh                       # build both, install to ~/sm64, restart the relay if it changed
deploy/deploy.sh --www build/us_web/dist --relay server/build/sm64-relay   # install prebuilt files
PREFIX=/tmp/sm64-test SYSTEMCTL=true deploy/deploy.sh --no-restart          # try it out somewhere else
```

It installs to:

```
$PREFIX/releases/<time>/   one directory per web release (the last 3 are kept)
$PREFIX/www                symlink to the current release, switched atomically
$PREFIX/bin/sm64-relay
$PREFIX/data/              saves: created if missing, never touched otherwise
```

If `build/us_web` predates release builds without debug info, `rm -rf build/us_web` once first;
otherwise the old objects get relinked into the 60 MB debug `.wasm` (see `web/README.md`).

Building the web release needs emsdk (it sources `~/emsdk/emsdk_env.sh` if `emcc` isn't on the
`PATH`); building the relay needs CMake, Boost and OpenSSL (see `server/README.md`). A web-only
change goes live without restarting the relay, so games in progress keep running. When the relay
binary changes it is restarted, which ends every game in progress: each player's page retries on its
own (after about 2 seconds, then backing off for about a minute), the first one back hosts on the
last uploaded save, and the others join it. Hosts upload within about a second of a save change, so
little is lost, but don't restart in the middle of a boss fight. If that
restart fails or is skipped with `--no-restart`, the next run restarts it. If `systemctl` can't be
reached when a restart is due (e.g. no user bus under cron or `sudo -u`), it stops before installing
anything. Running it again with nothing changed does nothing. `deploy.sh --help` lists the options.

## Optional hosted ROM

Hosted delivery is off when `SM64_ROM_PATH` is unset, so the existing client BYO-ROM flow remains
available. To turn it on, configure both variables in the relay's protected environment file:

```ini
SM64_ROM_PATH=/srv/sm64-private/baserom.us.z64
DISCORD_GUILD_IDS=123456789012345678,234567890123456789
```

Use an absolute path outside `$PREFIX/www` and every deployed web release. The relay validates that
the target is a readable, nonempty regular file (maximum 32 MiB), canonicalizes symlinks, rejects
files in the static web tree, and loads the bytes once at startup. The relay process account needs
read permission on the file and execute/traverse permission on its parent directories; keep the env
file mode `600`. For a user service, make the file readable by that user. For a system
service, make it readable by `sm64` without making it world-readable (for example a `sm64`-owned
`0640` file and private parent directory).

Every authorized client receives the ROM bytes in its browser. Discord membership plus the explicit
guild allowlist is access control, not DRM or a redistribution license; configure only a copy whose
use and delivery are permitted. The file is not copied into `$PREFIX/www` or deploy release folders.

Changing only the environment file does not trigger `deploy.sh`'s binary-change restart. After adding,
removing, or switching the path/allowlist, restart explicitly:

```sh
systemctl --user restart sm64-relay       # user unit (option A)
sudo systemctl restart sm64-relay          # system unit (option B)
```

A restart ends active rooms; clients reconnect on their normal retry cycle. To switch versions,
point `SM64_ROM_PATH` at the new file and restart; to revert, restore the previous value (or remove
both hosted settings to return to BYO mode) and restart again. An invalid path, missing allowlist, or
invalid ID list makes startup fail closed; restore the prior environment and restart, then inspect the
relay journal. Do not edit live services as part of a source build/test.

## Hosting options

Discord loads Activities only from a **public HTTPS** host name, so put something that terminates TLS
in front of the relay (which listens on plain HTTP, port 8080 in the examples). Pick one:

| Option | Files | Good for |
| --- | --- | --- |
| A. Cloudflare tunnel, user services | `examples/sm64-relay.user.service`, `examples/sm64-tunnel.user.service`, `examples/cloudflared-tunnel.yml` | a home machine or any box without open ports; no root after setup |
| B. Reverse proxy on a server, system service | `examples/sm64-relay.system.service` plus `examples/Caddyfile` or `examples/nginx.conf` | a VPS/VM with ports 80 and 443 open |

Either way the relay must see the WebSocket at `/ws`, and `--allow-lan-test` stays off.

### A. Cloudflare tunnel (user services)

Everything runs as your user under systemd's user manager, so no root is needed except to let it
run while you're logged out. You need a domain on Cloudflare.

1. One-time setup:
   ```sh
   sudo loginctl enable-linger "$USER"    # keep user services running after logout
   mkdir -p ~/.config/systemd/user ~/.config/sm64-relay
   cp deploy/examples/sm64-relay.user.service ~/.config/systemd/user/sm64-relay.service
   cp deploy/examples/sm64-tunnel.user.service ~/.config/systemd/user/sm64-tunnel.service
   systemctl --user daemon-reload
   install -m 600 deploy/sm64-relay.env.example ~/.config/sm64-relay/env   # then fill it in
   ```
   Create the tunnel and `~/.cloudflared/sm64.yml` as described in `examples/cloudflared-tunnel.yml`
   (replace `sm64.example.com` with your host name).
2. Deploy and start:
   ```sh
   deploy/deploy.sh
   systemctl --user enable --now sm64-relay sm64-tunnel
   ```
3. Later updates: `git pull && deploy/deploy.sh`.

Logs: `journalctl --user -u sm64-relay -f`. Back up `~/sm64/data`; it also holds recent versions of
each server's save under `snapshots/` (see "Saves" in `server/README.md` to roll one back).

### B. Reverse proxy on a server (system service)

Any Linux server with a public IP works (the steps assume Debian/Ubuntu).

1. Point a DNS name (`sm64.example.com` below) at the server. Open ports 80 and 443 only, not 8080.
2. Install the relay's build dependencies and a reverse proxy, and create the service user and the
   install location (owned by you, so `deploy.sh` runs without sudo):
   ```sh
   sudo apt install -y git cmake g++ libboost-dev libssl-dev caddy     # or nginx + certbot
   sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin sm64
   sudo install -d -o "$USER" /opt/sm64
   sudo install -d -o sm64 -g sm64 -m 700 /opt/sm64/data
   sudo install -d -m 755 /etc/sm64-relay
   sudo install -m 600 deploy/sm64-relay.env.example /etc/sm64-relay/env   # then fill it in
   ```
3. Install the units (only `server/` and `deploy/` are needed on the server):
   ```sh
   sudo cp deploy/examples/sm64-relay.system.service /etc/systemd/system/sm64-relay.service
   sudo cp deploy/examples/Caddyfile /etc/caddy/Caddyfile       # put your host name in it
   # nginx instead: copy examples/nginx.conf to sites-available, enable it, run certbot --nginx
   sudo systemctl daemon-reload
   sudo systemctl enable sm64-relay
   sudo systemctl reload caddy
   ```
4. Build the web release on a machine with emsdk (`make -j TARGET_WEB=1 web-dist`, or download the
   `web-dist` artifact of a CI run) and copy it over: `rsync -a --delete build/us_web/dist/ <server>:web-dist/`.
5. On the server, install and start (this builds the relay there):
   ```sh
   PREFIX=/opt/sm64 SYSTEMCTL="sudo systemctl" deploy/deploy.sh --www ~/web-dist
   ```
   Repeat steps 4 and 5 to update.

Logs: `journalctl -u sm64-relay -f`. Back up `/opt/sm64/data` (saves, and their snapshots under
`snapshots/`; see "Saves" in `server/README.md`).

Caddy gets the certificate on its own and compresses responses (the `.wasm` is ~32 MB raw, ~7 MB
compressed); the nginx example enables gzip. A reverse proxy adds `X-Forwarded-For`, so LAN test
mode can't be reached through it even if the flag were set.

### Caching (CDNs and Cloudflare)

The relay serves every file with `Cache-Control: no-cache` plus an `ETag`; the game files, which need
a signed-in asset session (`?s=`, see "Static files" in `server/README.md`), with `private, no-cache`,
so a shared cache never hands them to someone who didn't sign in. Some proxies (Cloudflare's
default "Browser Cache TTL", for example) override `no-cache` for `.js` files. That is harmless here:
`make web-dist` gives every asset a per-release URL (`?v=<build id>`, see `web/version-dist.py`), and
only `index.html` is unversioned. You don't need any cache rules; just don't cache `index.html` for long,
and don't add a rule that caches everything regardless of `private`.

Set `SM64_ASSET_SECRET` in the env file (`openssl rand -hex 32`). Without it the relay makes a random
one at each start, which works but makes anyone loading the game during a restart reopen the Activity.

## What to watch for

The relay's limits (players per world, sessions per account, message rates; see "Limits" in
`server/README.md`) log when they drop messages or cut someone off. Worth a look after the first
big sessions: the message rates are estimated from how the game sends packets, not measured with
a full room. A host over its rate only lags (its extra messages are dropped); it is never
disconnected for it.

```sh
journalctl --user -u sm64-relay | grep -E "over its message rate|can't keep up"
```

## Discord Developer Portal

For the application the Activity runs as:

- **OAuth2**: copy the client ID and secret into the relay's env file. Add a redirect URI (any,
  e.g. `https://127.0.0.1`; the Embedded App SDK flow requires one to exist).
- **Activities → URL Mappings**: map `/` to your public host name (for example `sm64.example.com`,
  without `https://`).
- **Activities → Settings**: enable Activities and restrict platforms to desktop. Keep the app
  private and add testers under **App Testers**.
