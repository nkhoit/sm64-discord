// Checks the relay's HTTP API against the mock Discord API (mock_discord.py).
//
//   python3 server/tests/mock_discord.py 8199 &
//   DISCORD_CLIENT_ID=1 DISCORD_CLIENT_SECRET=mock-secret DISCORD_API_BASE=http://127.0.0.1:8199 \
//       server/build/sm64-relay --port 8124 --data /tmp/relay-data --allow-lan-test &
//   server/build/sm64-relay --port 8125 --www /tmp/relay-www-2 --data /tmp/relay-data-2 &   # no LAN test or Discord
//   node server/tests/api-test.cjs http://127.0.0.1:8124 http://127.0.0.1:8125 /tmp/relay-data /tmp/relay-www-2
//
// The second relay's --www directory is filled with test files by this script, and a third relay
// (server/build/sm64-relay, or $SM64_RELAY) is started on it with a known SM64_ASSET_SECRET and
// DISCORD_GUILD_IDS, to check asset sessions the test signs itself.
//
// Takes ~35 s (keepalive checks wait for the relay's ping timeout). Needs freshly started relays.
const fs = require('fs');
const path = require('path');
const { makeSave } = require('./save-fixture.cjs');

const [base, baseNoLan, dataDir, wwwDir] = process.argv.slice(2);
if (!base || !baseNoLan || !dataDir || !wwwDir) {
  console.error('usage: node api-test.cjs <relay with --allow-lan-test> <relay without it> <first relay\'s --data dir> '
                + '<second relay\'s --www dir>');
  process.exit(2);
}

const MEMBER_GUILD = '111111111111111111';
let failures = 0;

function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`);
  if (!ok) { failures++; }
}

async function call(url, method, body, headers = {}) {
  const raw = body instanceof Uint8Array;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(text.toString()); } catch {}
  return { status: res.status, json, bytes: text };
}

const session = (b, body, headers) => call(`${b}/.proxy/api/session`, 'POST', body, headers);
const token = async (user) => (await call(`${base}/.proxy/api/token`, 'POST', { code: `code-${user}` })).json?.access_token;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A plain HTTP request (fetch would add and undo Accept-Encoding itself).
function raw(url, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
// Asset sessions: "<expiry>.<hex HMAC-SHA256(secret, 'sm64-assets:v1:<expiry>')>", as the relay makes them.
const crypto = require('crypto');
const ASSET_SECRET = 'api-test-asset-secret-0123456789abcdef';
const mintSession = (secret, expires) =>
  `${expires}.${crypto.createHmac('sha256', secret).update(`sm64-assets:v1:${expires}`).digest('hex')}`;

// Starts another relay (SM64_RELAY, or server/build/sm64-relay) serving `www` on a free port. With
// `expectExit`, waits for it to exit instead and returns its exit code and stderr.
async function startRelay(www, env, expectExit = false) {
  const { spawn } = require('child_process');
  const os = require('os');
  const binary = process.env.SM64_RELAY || path.join(__dirname, '..', 'build', 'sm64-relay');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-relay-'));
  const child = spawn(binary, ['--port', String(port), '--www', www, '--data', data],
                      { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', () => {});
  if (expectExit) {
    const exitCode = await new Promise((resolve) => child.on('exit', resolve));
    return { exitCode, stderr };
  }
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/config`); return { child, base: `http://127.0.0.1:${port}` }; } catch {}
    await sleep(100);
  }
  throw new Error('the extra relay did not start: ' + stderr);
}

const wsUrl = (ticket) => `${base.replace(/^http/, 'ws')}/.proxy/ws?ticket=${ticket}`;

// Opens /ws with a ticket. `closed` resolves with the close code and reason; `received` counts messages.
function connect(ticket) {
  const ws = new WebSocket(wsUrl(ticket));
  ws.binaryType = 'arraybuffer';
  const conn = { ws, received: 0, isOpen: false };
  conn.opened = new Promise((resolve) => {
    ws.onopen = () => { conn.isOpen = true; resolve(true); };
  });
  conn.closed = new Promise((resolve) => {
    ws.onclose = (e) => { conn.isOpen = false; resolve({ code: e.code, reason: e.reason }); };
  });
  ws.onmessage = () => { conn.received++; };
  return conn;
}
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'timeout')]);

// A WebSocket client that never answers pings: the relay should ping it, then give up on it.
function silentPeer(ticket) {
  const net = require('net');
  const { hostname, port } = new URL(base);
  const socket = net.connect(Number(port), hostname);
  const start = Date.now();
  const result = { pingAfter: null, closedAfter: null };
  let buffer = Buffer.alloc(0), upgraded = false;
  socket.on('connect', () => socket.write(`GET /ws?ticket=${ticket} HTTP/1.1\r\nHost: ${hostname}\r\nUpgrade: websocket\r\n`
    + 'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) { return; }
      upgraded = buffer.subarray(0, 12).toString() === 'HTTP/1.1 101';
      buffer = buffer.subarray(end + 4);
    }
    // server frames are unmasked; opcode 9 is a ping
    while (buffer.length >= 2 && buffer.length >= 2 + (buffer[1] & 0x7f)) {
      if ((buffer[0] & 0x0f) === 9 && result.pingAfter === null) { result.pingAfter = (Date.now() - start) / 1000; }
      buffer = buffer.subarray(2 + (buffer[1] & 0x7f));
    }
  });
  result.done = new Promise((resolve) => socket.on('close', () => {
    result.closedAfter = (Date.now() - start) / 1000;
    resolve(result);
  }));
  return result;
}

(async () => {
  // LAN test mode
  const lanHost = await session(base, { mode: 'lan', room: 'Api Test!', name: 'Tester' });
  check('LAN session from loopback is allowed', lanHost.status === 200 && lanHost.json.role === 'host'
        && lanHost.json.room === 'lan-apitest', lanHost);
  const lanWait = await session(base, { mode: 'lan', room: 'APITEST' });
  check('second player waits while the host is still loading', lanWait.status === 409 && lanWait.json.wait, lanWait);
  // Caddy/nginx add the first ones; cloudflared connects from loopback but adds CF-Connecting-IP and CF-Ray.
  for (const header of ['X-Forwarded-For', 'Forwarded', 'X-Real-IP', 'X-Forwarded-Proto', 'Via',
                        'CF-Connecting-IP', 'True-Client-IP', 'CF-Ray', 'cf-ray']) {
    const r = await session(base, { mode: 'lan', room: 'other' }, { [header]: header === 'CF-Ray' || header === 'cf-ray' ? '8c1d2e3f4a5b6c7d-LHR' : '203.0.113.9' });
    check(`LAN session through a proxy (${header}) is refused`, r.status === 403, r);
  }
  // Keepalive runs in the background (it takes ~30 s): a silent peer gets pinged, then dropped;
  // a quiet browser-like peer (which answers pings) stays connected.
  const silent = silentPeer((await session(base, { mode: 'lan', room: 'keepalive-silent' })).json.ticket);
  const quiet = connect((await session(base, { mode: 'lan', room: 'keepalive-quiet' })).json.ticket);

  const noLan = await session(baseNoLan, { mode: 'lan', room: 'other' });
  check('LAN session is refused without --allow-lan-test', noLan.status === 403, noLan);
  const noLanConfig = await call(`${baseNoLan}/api/config`, 'GET');
  check('config reports LAN test and Discord off', noLanConfig.json?.lanTest === false && noLanConfig.json?.discord === false,
        noLanConfig);

  // Static files. A third relay (started here) serves the second relay's --www directory with a known
  // asset session secret, so the test can sign its own sessions (also expired and forged ones).
  const zlib = require('zlib');
  fs.mkdirSync(path.join(wwwDir, 'sub.js'), { recursive: true });
  fs.mkdirSync(path.join(wwwDir, 'vendor'), { recursive: true });
  const appJs = 'console.log("hello");\n'.repeat(50);
  const files = {
    'index.html': '<!doctype html><title>t</title>', 'boot.js': 'export {};', 'vendor/discord-sdk.js': 'export {};',
    'app.js': appJs, 'app.js.br': zlib.brotliCompressSync(appJs), 'app.js.gz': zlib.gzipSync(appJs),
    'game.wasm': Buffer.alloc(1000, 1), 'game.data': Buffer.alloc(10, 2), 'only.js.gz': 'stale',
    'diagnostics.js': 'export {};', 'game.js': 'var Module;', 'style.css': 'body{}',
    'sm64coopdx.js': 'var Module;', 'sm64coopdx.wasm': Buffer.alloc(64, 3), 'sm64coopdx.data': Buffer.alloc(32, 4),
    'save_file.o': 'obj', 'save_file.c': 'src', 'save_file.d': 'dep', 'rules.mk': 'mk', 'notes.txt': 'txt',
  };
  for (const [name, body] of Object.entries(files)) { fs.writeFileSync(path.join(wwwDir, name), body); }
  fs.writeFileSync(path.join(wwwDir, 'only.js'), 'newer than its .gz');
  const privateFixture = path.join(path.dirname(wwwDir), 'synthetic-private-fixture.data');
  fs.writeFileSync(privateFixture, 'SYNTHETIC TEST FIXTURE - NOT A GAME ROM');
  fs.symlinkSync(privateFixture, path.join(wwwDir, 'private-rom.data'));
  const past = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(wwwDir, 'only.js.gz'), past, past);

  const authRelay = await startRelay(wwwDir, {
    SM64_ASSET_SECRET: ASSET_SECRET, DISCORD_GUILD_IDS: MEMBER_GUILD,
    DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'mock-secret', DISCORD_API_BASE: 'http://127.0.0.1:8199',
  });
  const baseAuth = authRelay.base;
  const good = mintSession(ASSET_SECRET, Math.floor(Date.now() / 1000) + 1800);
  // `url` plus the asset session, after any query it already has
  const withSession = (url, session = good) => url + (url.includes('?') ? '&' : '?') + 's=' + encodeURIComponent(session);
  const PUBLIC = ['index.html', 'boot.js', 'vendor/discord-sdk.js'];
  const GATED = ['sm64coopdx.js', 'sm64coopdx.wasm', 'sm64coopdx.data', 'app.js', 'diagnostics.js'];

  const page = await raw(`${baseAuth}/.proxy/`);
  check('the page is served with an ETag, Last-Modified and no-cache', page.status === 200 && page.headers.etag
        && page.headers['last-modified'] && page.headers['cache-control'] === 'no-cache'
        && page.headers['content-type'].startsWith('text/html'), page.headers);
  // Every kind of web asset, directly, through Discord's /.proxy prefix and with a release query string,
  // must be revalidated (no-cache + ETag + Last-Modified): nothing may sit in a browser cache unchecked.
  // The engine files are also "private", so no shared cache (Cloudflare's) keeps them for others.
  for (const name of ['index.html', 'boot.js', 'app.js', 'diagnostics.js', 'game.js', 'game.wasm', 'game.data', 'style.css']) {
    const cacheControl = PUBLIC.includes(name) ? 'no-cache' : 'private, no-cache';
    for (const plainUrl of [`/${name}`, `/.proxy/${name}`, `/.proxy/${name}?v=0123456789abcdef`]) {
      const url = PUBLIC.includes(name) ? plainUrl : withSession(plainUrl);
      const r = await raw(`${baseAuth}${url}`);
      check(`${url} is served ${cacheControl} with an ETag and Last-Modified`, r.status === 200
            && r.headers['cache-control'] === cacheControl && !!r.headers.etag && !!r.headers['last-modified'], [r.status, r.headers]);
      const again = await raw(`${baseAuth}${url}`, 'GET', { 'If-None-Match': r.headers.etag });
      check(`${url} revalidates to 304`, again.status === 304 && again.headers['cache-control'] === cacheControl, again.status);
    }
  }
  const byEtag = await raw(`${baseAuth}/index.html`, 'GET', { 'If-None-Match': page.headers.etag });
  check('a matching If-None-Match gets 304', byEtag.status === 304 && byEtag.body.length === 0
        && byEtag.headers.etag === page.headers.etag, byEtag.status);
  const byWeakEtag = await raw(`${baseAuth}/index.html`, 'GET', { 'If-None-Match': `"nope", W/${page.headers.etag}` });
  check('a weak ETag (as Cloudflare sends back) also gets 304', byWeakEtag.status === 304, byWeakEtag.status);
  const byDate = await raw(`${baseAuth}/index.html`, 'GET', { 'If-Modified-Since': page.headers['last-modified'] });
  check('If-Modified-Since gets 304', byDate.status === 304, byDate.status);
  const staleEtag = await raw(`${baseAuth}/index.html`, 'GET', { 'If-None-Match': '"old"',
                                                                  'If-Modified-Since': page.headers['last-modified'] });
  check('a stale ETag gets the file even if the date matches', staleEtag.status === 200, staleEtag.status);
  const head = await raw(`${baseAuth}${withSession('/game.wasm')}`, 'HEAD');
  check('HEAD answers with headers only', head.status === 200 && head.headers['content-length'] === '1000'
        && head.headers['content-type'] === 'application/wasm' && head.body.length === 0, head);
  const data = await raw(`${baseAuth}${withSession('/game.data')}`);
  check('.data files are served', data.status === 200 && data.body.length === 10, data.status);
  const escapedStatic = await raw(`${baseAuth}${withSession('/private-rom.data')}`);
  check('a static symlink outside the www root is not served', escapedStatic.status === 404
        && !escapedStatic.body.toString().includes('SYNTHETIC TEST FIXTURE'), escapedStatic.status);
  fs.unlinkSync(path.join(wwwDir, 'private-rom.data'));
  fs.unlinkSync(privateFixture);

  const br = await raw(`${baseAuth}${withSession('/app.js')}`, 'GET', { 'Accept-Encoding': 'gzip, deflate, br' });
  check('a .br copy is served to clients that accept it', br.status === 200 && br.headers['content-encoding'] === 'br'
        && zlib.brotliDecompressSync(br.body).toString() === appJs && br.headers.vary === 'Accept-Encoding', br.headers);
  const gz = await raw(`${baseAuth}${withSession('/app.js')}`, 'GET', { 'Accept-Encoding': 'gzip, br;q=0' });
  check('...else the .gz copy', gz.headers['content-encoding'] === 'gzip' && zlib.gunzipSync(gz.body).toString() === appJs,
        gz.headers);
  const plain = await raw(`${baseAuth}${withSession('/app.js')}`);
  check('...else the file itself', !plain.headers['content-encoding'] && plain.body.toString() === appJs, plain.headers);
  check('each encoding has its own ETag', new Set([br.headers.etag, gz.headers.etag, plain.headers.etag]).size === 3,
        [br.headers.etag, gz.headers.etag, plain.headers.etag]);
  const stale = await raw(`${baseAuth}${withSession('/only.js')}`, 'GET', { 'Accept-Encoding': 'gzip' });
  check('a compressed copy older than the file is ignored', !stale.headers['content-encoding']
        && stale.body.toString() === 'newer than its .gz', stale.headers);

  for (const name of ['save_file.o', 'save_file.c', 'save_file.d', 'rules.mk', 'notes.txt', 'app.js.br', 'app.js.gz', 'sub.js']) {
    const r = await raw(`${baseAuth}${withSession(`/${name}`)}`);
    check(`${name} is not served`, r.status === 404, r.status);
  }

  // Asset sessions: the engine files need one, the bootstrap doesn't
  for (const name of PUBLIC) {
    for (const url of [`/${name}`, `/.proxy/${name}?v=0123456789abcdef`]) {
      for (const [label, b] of [['', baseAuth], [' (relay with a random secret)', baseNoLan]]) {
        const r = await raw(`${b}${url}`);
        check(`public ${url} is served without a session${label}`, r.status === 200 && r.headers['cache-control'] === 'no-cache', r.status);
      }
    }
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const tamperedSig = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
  const [goodExp, goodSig] = good.split('.');
  const badSessions = {
    'a tampered signature': tamperedSig,
    'a tampered expiry': `${Number(goodExp) + 3600}.${goodSig}`,
    'an expired session': mintSession(ASSET_SECRET, nowSec - 5),
    'a session far in the future': mintSession(ASSET_SECRET, nowSec + 7 * 24 * 3600),
    'a session signed with another secret': mintSession('another-secret-another-secret-0000', nowSec + 1800),
    'garbage': 'not-a-session',
  };
  for (const name of GATED) {
    for (const url of [`/${name}`, `/.proxy/${name}`, `/.proxy/${name}?v=0123456789abcdef`]) {
      const anon = await raw(`${baseAuth}${url}`);
      check(`${url} without a session is 401 (not cacheable, no content)`, anon.status === 401
            && anon.headers['cache-control'] === 'no-store' && anon.body.length < 100, [anon.status, anon.headers['cache-control']]);
      const anonHead = await raw(`${baseAuth}${url}`, 'HEAD');
      check(`HEAD ${url} without a session is 401`, anonHead.status === 401, anonHead.status);
      const other = await raw(`${baseNoLan}${url}`);
      check(`${url} without a session is 401 on a relay with a random secret`, other.status === 401, other.status);
      const foreign = await raw(`${baseNoLan}${withSession(url)}`);
      check(`${url} with another relay's session is 403`, foreign.status === 403, foreign.status);
      const ok = await raw(`${baseAuth}${withSession(url)}`);
      check(`${url} with a session is 200, private, no-cache`, ok.status === 200
            && ok.headers['cache-control'] === 'private, no-cache', [ok.status, ok.headers['cache-control']]);
    }
    for (const [label, bad] of Object.entries(badSessions)) {
      const r = await raw(`${baseAuth}${withSession(`/.proxy/${name}?v=0123456789abcdef`, bad)}`);
      check(`/.proxy/${name} with ${label} is 403`, r.status === 403 && r.headers['cache-control'] === 'no-store', r.status);
    }
  }
  const missing = await raw(`${baseAuth}/nothing-here.js`);
  check('a missing engine file without a session is 401 (does not reveal what exists)', missing.status === 401, missing.status);

  // Discord sign-in
  const config = await call(`${base}/.proxy/api/config`, 'GET');
  check('config reports the client id', config.json?.clientId === '1' && config.json?.discord === true, config);
  const badCode = await call(`${base}/.proxy/api/token`, 'POST', { code: 'nonsense' });
  check('a bad OAuth code is rejected', badCode.status === 401, badCode);
  const alice = await token('alice');
  check('an OAuth code exchanges for a token', alice === 'token-alice', alice);
  const forged = await session(base, { mode: 'discord', access_token: 'token-alice', guild_id: '222222222222222222' });
  check('a server the player is not in is refused', forged.status === 403, forged);
  const badToken = await session(base, { mode: 'discord', access_token: 'garbage', guild_id: MEMBER_GUILD });
  check('an invalid access token is refused', badToken.status === 403, badToken);
  const notSnowflake = await session(base, { mode: 'discord', access_token: alice, guild_id: '../etc' });
  check('a malformed server id is refused', notSnowflake.status === 400, notSnowflake);
  const host = await session(base, { mode: 'discord', access_token: alice, guild_id: MEMBER_GUILD });
  check('a member gets a host ticket for the server room', host.status === 200 && host.json.role === 'host'
        && host.json.room === `g${MEMBER_GUILD}` && host.json.name === 'Alice', host);


  // Getting an asset session
  const lanAssets = await call(`${base}/api/assets`, 'POST', { mode: 'lan' });
  const lanSession = lanAssets.json?.session;
  const lanExpires = lanAssets.json?.expires_at - Math.floor(Date.now() / 1000);
  check('LAN test mode gets an asset session from loopback, valid for 30-90 minutes', lanAssets.status === 200
        && /^\d+\.[0-9a-f]{64}$/.test(lanSession || '') && lanExpires >= 1790 && lanExpires <= 5400
        && lanAssets.json.expires_in >= 1790, lanAssets);
  const lanApp = await raw(`${base}/.proxy/app.js?v=0123456789abcdef&s=${encodeURIComponent(lanSession)}`);
  check('...and it opens app.js, private, no-cache', lanApp.status === 200 && lanApp.headers['cache-control'] === 'private, no-cache',
        [lanApp.status, lanApp.headers['cache-control']]);
  const lanAnon = await raw(`${base}/.proxy/app.js`);
  check('...which needs it', lanAnon.status === 401, lanAnon.status);
  const lanProxied = await call(`${base}/api/assets`, 'POST', { mode: 'lan' }, { 'X-Forwarded-For': '203.0.113.9' });
  check('LAN asset sessions are refused through a proxy', lanProxied.status === 403, lanProxied);
  const noLanAssets = await call(`${baseNoLan}/api/assets`, 'POST', { mode: 'lan' });
  check('LAN asset sessions are refused without --allow-lan-test', noLanAssets.status === 403, noLanAssets);
  const getAssets = await call(`${base}/api/assets`, 'GET');
  check('/api/assets needs POST', getAssets.status === 405, getAssets);
  const noDiscord = await call(`${baseNoLan}/api/assets`, 'POST', { mode: 'discord', access_token: alice, guild_id: MEMBER_GUILD });
  check('Discord asset sessions are refused when Discord is not configured', noDiscord.status === 400, noDiscord);
  const assetsOf = (b, accessToken, guild, headers) =>
    call(`${b}/.proxy/api/assets`, 'POST', { mode: 'discord', access_token: accessToken, guild_id: guild }, headers);
  const aliceAssets = await assetsOf(base, alice, MEMBER_GUILD, { 'X-Forwarded-For': '203.0.113.9' });
  check('a member gets an asset session through the proxy', aliceAssets.status === 200 && !!aliceAssets.json?.session, aliceAssets);
  const aliceData = await raw(`${base}/.proxy/diagnostics.js?s=${encodeURIComponent(aliceAssets.json?.session)}`);
  check('...which opens the engine files', aliceData.status === 200 && aliceData.headers['cache-control'] === 'private, no-cache',
        aliceData.status);
  const sameHour = await assetsOf(base, alice, MEMBER_GUILD);
  check('sessions issued in the same hour are identical (stable URLs keep the browser cache useful)',
        sameHour.json?.session === aliceAssets.json?.session || sameHour.json?.expires_at !== aliceAssets.json?.expires_at, sameHour.json);
  const notMember = await assetsOf(base, alice, '222222222222222222');
  check('a server the player is not in gets no asset session', notMember.status === 403 && !notMember.json?.session, notMember);
  const badAccess = await assetsOf(base, 'garbage', MEMBER_GUILD);
  check('an invalid access token gets no asset session', badAccess.status === 403 && !badAccess.json?.session, badAccess);
  const badGuild = await assetsOf(base, alice, '../etc');
  check('a malformed server id gets no asset session', badGuild.status === 400, badGuild);
  // DISCORD_GUILD_IDS (set on the third relay): membership alone isn't enough
  const dual = await token('dual');
  const allowed = await assetsOf(baseAuth, dual, MEMBER_GUILD);
  check('with DISCORD_GUILD_IDS, a member of a listed server gets an asset session', allowed.status === 200, allowed);
  const unlisted = await assetsOf(baseAuth, dual, '222222222222222222');
  check('...but a member of a server not in DISCORD_GUILD_IDS does not', unlisted.status === 403 && !unlisted.json?.session, unlisted);
  const issued = await raw(`${baseAuth}/.proxy/sm64coopdx.wasm?v=0123456789abcdef&s=${encodeURIComponent(allowed.json?.session)}`);
  check('...and the issued session opens sm64coopdx.wasm', issued.status === 200 && issued.body.length === 64, issued.status);
  const shortSecret = await startRelay(wwwDir, { SM64_ASSET_SECRET: 'too-short' }, true);
  check('a too-short SM64_ASSET_SECRET is a configuration error', shortSecret.exitCode === 1 && /SM64_ASSET_SECRET/.test(shortSecret.stderr),
        shortSecret);
  authRelay.child.kill();

  // Saves
  const t = host.json?.ticket;
  const empty = await call(`${base}/api/save?ticket=${t}`, 'GET');
  check('a new server has no save', empty.status === 404, empty);
  const save = makeSave(1);
  const put = await call(`${base}/api/save?ticket=${t}`, 'PUT', save);
  check('the host can upload the save', put.status === 200, put);
  const got = await call(`${base}/.proxy/api/save?ticket=${t}`, 'GET');
  check('the save reads back unchanged', got.status === 200 && Buffer.compare(got.bytes, Buffer.from(save)) === 0,
        got.status);
  const noTicket = await call(`${base}/api/save?ticket=bogus`, 'GET');
  check('reading the save needs a host ticket', noTicket.status === 403, noTicket);
  const tooBig = await call(`${base}/api/save?ticket=${t}`, 'PUT', new Uint8Array(5000));
  check('an oversized save is rejected', tooBig.status === 400 || tooBig.status === 413, tooBig);

  // Only things the game could have written are stored
  const corrupt = makeSave(2);
  corrupt[20] ^= 0xff;
  const rejected = {
    'a save of the wrong size': makeSave(2).subarray(0, 511),
    'a save with a bad checksum': corrupt,
    'a save without signatures': new Uint8Array(512).map((_, i) => i & 0xff),
    'something else entirely': new TextEncoder().encode('<html>'.repeat(85) + 'xx'),
  };
  for (const [name, bytes] of Object.entries(rejected)) {
    const r = await call(`${base}/api/save?ticket=${t}`, 'PUT', bytes);
    check(`${name} is rejected`, r.status === 400, r.status);
  }
  const stillThere = await call(`${base}/api/save?ticket=${t}`, 'GET');
  check('rejected uploads leave the save alone', Buffer.compare(stillThere.bytes, Buffer.from(save)) === 0, stillThere.status);
  for (const [name, bytes] of [['a blank save', new Uint8Array(512)], ['a little-endian save', makeSave(3, { littleEndian: true })]]) {
    const r = await call(`${base}/api/save?ticket=${t}`, 'PUT', bytes);
    check(`${name} is accepted`, r.status === 200, r.status);
  }
  // Numbered uploads that arrive out of order: the older one is ignored
  const newer = await call(`${base}/api/save?ticket=${t}&seq=5`, 'PUT', makeSave(50));
  const older = await call(`${base}/api/save?ticket=${t}&seq=4`, 'PUT', makeSave(40));
  const afterOlder = await call(`${base}/api/save?ticket=${t}`, 'GET');
  check('an upload older than one already stored is ignored', newer.json?.saved === true && older.status === 200
        && older.json?.stale === true && Buffer.compare(afterOlder.bytes, Buffer.from(makeSave(50))) === 0, [newer.json, older.json]);
  const next = await call(`${base}/api/save?ticket=${t}&seq=6`, 'PUT', makeSave(60));
  const badSeq = await call(`${base}/api/save?ticket=${t}&seq=x7`, 'PUT', makeSave(70));
  check('...and later ones still land', next.json?.saved === true && badSeq.status === 400, [next.json, badSeq.status]);

  // Snapshots: the last 10 distinct uploads, plus the newest of each of the last 7 days
  const snapHost = (await session(base, { mode: 'lan', room: 'snap' })).json.ticket;
  const snapDir = path.join(dataDir, 'snapshots', 'lan-snap');
  const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  fs.mkdirSync(snapDir, { recursive: true });
  const seeded = [`${dayAgo(3)}T080000.000Z-00.bin`, `${dayAgo(3)}T200000.000Z-00.bin`, `${dayAgo(20)}T120000.000Z-00.bin`];
  for (const name of seeded) { fs.writeFileSync(path.join(snapDir, name), makeSave(99)); }
  let limited = false;
  const putSnap = async (bytes) => {
    for (;;) {
      const r = await call(`${base}/api/save?ticket=${snapHost}`, 'PUT', bytes);
      if (r.status !== 429) { return r; }
      limited = true;
      await sleep(1000);
    }
  };
  for (let i = 0; i < 12; i++) { await putSnap(makeSave(100 + i)); }
  await putSnap(makeSave(111)); // same as the last one
  check('save uploads are rate limited', limited);
  const snaps = fs.readdirSync(snapDir).sort();
  const today = snaps.filter((n) => !seeded.includes(n));
  check('the last 10 distinct uploads are kept', today.length === 10, snaps);
  check('the newest snapshot is the current save',
        Buffer.compare(fs.readFileSync(path.join(snapDir, today[today.length - 1])), Buffer.from(makeSave(111))) === 0
        && Buffer.compare(fs.readFileSync(path.join(dataDir, 'lan-snap.bin')), Buffer.from(makeSave(111))) === 0);
  check('older days keep their newest snapshot', snaps.includes(seeded[1]) && !snaps.includes(seeded[0]), snaps);
  check('snapshots older than a week are dropped', !snaps.includes(seeded[2]), snaps);
  check('no temporary files are left behind', !fs.readdirSync(dataDir).some((n) => n.includes('.tmp'))
        && !snaps.some((n) => n.includes('.tmp')), fs.readdirSync(dataDir));

  // A save from before snapshots existed gets kept as one before it's replaced
  fs.writeFileSync(path.join(dataDir, 'lan-legacy.bin'), makeSave(7));
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(path.join(dataDir, 'lan-legacy.bin'), twoDaysAgo, twoDaysAgo);
  const legacyHost = (await session(base, { mode: 'lan', room: 'legacy' })).json.ticket;
  await call(`${base}/api/save?ticket=${legacyHost}`, 'PUT', makeSave(8));
  const legacySnaps = fs.readdirSync(path.join(dataDir, 'snapshots', 'lan-legacy')).sort();
  check('an existing save is snapshotted before the first upload replaces it', legacySnaps.length === 2
        && legacySnaps[0].startsWith(dayAgo(2))
        && Buffer.compare(fs.readFileSync(path.join(dataDir, 'snapshots', 'lan-legacy', legacySnaps[0])), Buffer.from(makeSave(7))) === 0,
        legacySnaps);

  // A host's last upload as its page closes still lands, until someone else takes over
  const leaving = (await session(base, { mode: 'lan', room: 'leaving' })).json.ticket;
  const leavingWs = connect(leaving);
  await leavingWs.opened;
  leavingWs.ws.close();
  await leavingWs.closed;
  await sleep(200);
  const lateUpload = await call(`${base}/api/save?ticket=${leaving}`, 'PUT', makeSave(9));
  check('a host that just left can still upload the save', lateUpload.status === 200, lateUpload);
  const lateRead = await call(`${base}/api/save?ticket=${leaving}`, 'GET');
  check('...but not read it', lateRead.status === 403, lateRead.status);
  const nextHost = await session(base, { mode: 'lan', room: 'leaving' });
  const tooLate = await call(`${base}/api/save?ticket=${leaving}`, 'PUT', makeSave(10));
  check('...and not once the next host has started', nextHost.json?.role === 'host' && tooLate.status === 403, tooLate.status);

  // Room limits (LAN rooms, so no Discord account is involved)
  const fullHost = connect((await session(base, { mode: 'lan', room: 'full' })).json.ticket);
  await fullHost.opened;
  const clientTickets = [];
  for (let i = 0; i < 15; i++) { clientTickets.push((await session(base, { mode: 'lan', room: 'full' })).json?.ticket); }
  check('a room takes 15 players besides the host', clientTickets.every(Boolean), clientTickets);
  const seventeenth = await session(base, { mode: 'lan', room: 'full' });
  check('the 17th player is told the room is full', seventeenth.status === 409 && seventeenth.json.full
        && /full/.test(seventeenth.json.error) && !seventeenth.json.wait, seventeenth.json);

  const bigSender = connect(clientTickets[0]);
  await bigSender.opened;
  bigSender.ws.send(new Uint8Array(5000));
  const bigClosed = await within(bigSender.closed, 5000);
  check('a message over 4 KiB closes the connection', bigClosed.code === 1009, bigClosed);

  const flooder = connect(clientTickets[1]);
  await flooder.opened;
  const frame = new Uint8Array([0, 0, 0, 0, 1]);
  for (let i = 0; i < 8000 && flooder.isOpen; i++) { flooder.ws.send(frame); }
  const floodClosed = await within(flooder.closed, 10000);
  await sleep(200);
  check('a peer flooding messages is cut off', floodClosed.reason === 'sending too fast', floodClosed);
  check('the host only gets the allowed burst', fullHost.received >= 1500 && fullHost.received <= 2500, fullHost.received);

  // The host is only ever throttled (closing it would end the room), and may send more the more
  // clients it has: it relays every player's state to every other player.
  const hostFlood = async (room, clients) => {
    const host = connect((await session(base, { mode: 'lan', room })).json.ticket);
    await host.opened;
    const peers = [];
    for (let i = 0; i < clients; i++) {
      peers.push(connect((await session(base, { mode: 'lan', room })).json.ticket));
      await peers[i].opened;
    }
    await sleep(200);
    const toFirst = new Uint8Array([1, 0, 0, 0, 1]); // to peer 1
    for (let i = 0; i < 30000; i++) { host.ws.send(toFirst); }
    await sleep(2000);
    const flooded = peers[0].received;
    await sleep(1500);
    host.ws.send(toFirst);
    await sleep(500);
    const result = { hostOpen: host.isOpen, flooded, laterArrived: peers[0].received === flooded + 1 };
    host.ws.close();
    return result;
  };
  const oneClient = await hostFlood('host-flood-1', 1);
  check('a host sending over its rate is throttled', oneClient.flooded >= 6000 && oneClient.flooded < 15000, oneClient);
  check('...not disconnected, and gets through again afterwards', oneClient.hostOpen && oneClient.laterArrived, oneClient);
  const threeClients = await hostFlood('host-flood-3', 3);
  check('a host with more clients may send more', threeClients.flooded >= 18000 && threeClients.hostOpen, threeClients);

  const bystander = connect(clientTickets[2]);
  await bystander.opened;
  fullHost.ws.close();
  const hostLeft = await within(bystander.closed, 5000);
  check('clients are told when the host leaves', hostLeft.reason === 'host left', hostLeft);

  // Sessions per Discord account: the host plus two more, then refused
  const g111Host = connect(t);
  await g111Host.opened;
  const extra = [];
  for (let i = 0; i < 3; i++) { extra.push(await session(base, { mode: 'discord', access_token: alice, guild_id: MEMBER_GUILD })); }
  check('one account can hold three sessions', extra[0].status === 200 && extra[1].status === 200, extra.map((r) => r.status));
  check('a fourth session for the same account is refused', extra[2].status === 429 && extra[2].json.error, extra[2]);
  const bob = await session(base, { mode: 'discord', access_token: await token('bob'), guild_id: MEMBER_GUILD });
  check('another account can still join', bob.status === 200 && bob.json.role === 'client', bob);
  g111Host.ws.close();

  // Keepalive results
  const silentResult = await within(silent.done, 45000);
  check('the relay pings a quiet connection', silentResult.pingAfter !== null && silentResult.pingAfter < 20, silentResult);
  check('a peer that stops answering is dropped', silentResult.closedAfter !== null && silentResult.closedAfter < 40, silentResult);
  check('a quiet peer that answers pings stays connected', quiet.isOpen, silentResult);
  quiet.ws.close();

  // Total rooms: new rooms are refused once the cap is reached, existing ones still work
  let capped = null;
  for (let i = 0; i < 70 && !capped; i++) {
    const r = await session(base, { mode: 'lan', room: `cap-${i}` });
    if (r.status !== 200) { capped = { at: i, ...r }; }
  }
  check('new rooms are refused at the room limit', capped?.status === 503 && capped.at <= 64, capped);
  const existingRoom = await session(base, { mode: 'lan', room: 'cap-0' });
  check('existing rooms still answer at the room limit', existingRoom.status === 409 && existingRoom.json.wait, existingRoom);

  console.log(failures ? `${failures} check(s) failed` : 'PASS: all API checks');
  process.exit(failures ? 1 : 0);
})();
