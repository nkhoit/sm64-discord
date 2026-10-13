// Loaded by boot.js once it has an asset session (it also loads diagnostics.js with it).
const createDiagnostics = window.createDiagnostics;

// Starts the game in one of two modes:
//
//   Discord:  launched as an Activity (the URL has frame_id). Signs in through the Embedded App SDK;
//             the relay checks the player's membership and puts everyone in that server into one room.
//   LAN test: a plain browser on the relay's local network, for testing without Discord. Only works
//             when the relay was started with --allow-lan-test. Query: ?room=name&name=Player
//
// Either way the relay answers with a ticket and a role. The host loads the server's save before the
// game starts and uploads it whenever it changes; clients get the save from the host when they join.
//
// When the host leaves, the relay closes the room and every page reloads itself after a short, randomly
// spread countdown. Reloading signs in again silently, and the first page back becomes the new host
// (loading the save it last uploaded) while the rest wait for it and join. The game can't be restarted
// inside a running page, so a reload is the only clean way to start over. Other drops retry the same
// way with backoff, then leave a Rejoin button.

const SAVE_DIR = '/save';
const ROM_PATH = SAVE_DIR + '/baserom.us.z64';
const SAVE_PATH = SAVE_DIR + '/sm64_save_file.bin';
// How often the host checks for a changed save to upload. Reading it is cheap (it's in memory).
const SAVE_CHECK_INTERVAL_MS = 1000;

// After the host leaves, wait this long plus up to the jitter before reloading.
const HOST_LEFT_DELAY_MS = 3000;
const HOST_LEFT_JITTER_MS = 3000;
// After any other drop, wait this long before each retry (each ±25%), then give up. About a minute in
// all, enough to ride out a relay restart.
const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];
// Stop rejoining automatically after this many rejoins within REJOIN_WINDOW_MS (something is wrong).
const MAX_REJOINS = 6;
const REJOIN_WINDOW_MS = 5 * 60 * 1000;
// Once a session has lasted this long, earlier failures no longer count towards giving up.
const STABLE_SESSION_MS = 60 * 1000;
const REJOIN_STATE_KEY = 'sm64-rejoin';

const query = new URLSearchParams(location.search);
const inDiscord = query.has('frame_id');
// Discord's mobile apps pass platform=mobile. There are no touch controls yet.
const onMobile = query.get('platform') === 'mobile';
// Inside Discord every request to our server goes through its proxy under /.proxy.
const base = inDiscord ? '/.proxy' : '';
// Extra command line arguments for testing, e.g. ?args=--skip-intro
const extraArgs = (query.get('args') || '').split(' ').filter(Boolean);

const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const setStatus = (text) => { statusEl.textContent = text; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A problem to show the player as is, with a Rejoin button if `canRetry` (e.g. the world is full).
class UserError extends Error {
  constructor(message, canRetry = false) {
    super(message);
    this.canRetry = canRetry;
  }
}
// A problem worth retrying (the relay is busy or unreachable); the message is shown while retrying.
class RetryableError extends Error {}

// Carried across the reloads that rejoin: { failures, rejoins: [timestamps] }. Only rejoin() saves it,
// right before reloading, and it's used once: session storage is shared by the whole Discord window, so
// a later launch of the activity must start afresh.
const rejoinState = (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(REJOIN_STATE_KEY));
    sessionStorage.removeItem(REJOIN_STATE_KEY);
    if (saved && Array.isArray(saved.rejoins) && Date.now() - saved.savedAt < 60000) {
      return { failures: saved.failures || 0, rejoins: saved.rejoins.filter((t) => Date.now() - t < REJOIN_WINDOW_MS) };
    }
  } catch {}
  return { failures: 0, rejoins: [] };
})();
const isRejoin = rejoinState.rejoins.length > 0;
const diagnostics = createDiagnostics({
  root: document.getElementById('debug-panel-host'), document, window, Module,
  fetch: (...args) => fetch(...args),
  base,
  storage: (() => { try { return window.localStorage; } catch { return null; } })(),
  now: () => window.performance?.now?.() ?? Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (id) => clearInterval(id),
  AbortController: window.AbortController,
  PerformanceObserver: window.PerformanceObserver,
  requestAnimationFrame: typeof window.requestAnimationFrame === 'function' ? (callback) => window.requestAnimationFrame(callback) : undefined,
  cancelAnimationFrame: typeof window.cancelAnimationFrame === 'function' ? (id) => window.cancelAnimationFrame(id) : undefined,
});
diagnostics.setRejoins(rejoinState.rejoins.length);
addEventListener('pagehide', () => diagnostics.stop(), { once: true });

async function api(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: body instanceof Uint8Array ? { 'Content-Type': 'application/octet-stream' }
                                        : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    ...(path === '/api/rom' ? { cache: 'no-store' } : {}),
  });
  return response;
}

async function apiJson(method, path, body) {
  const response = await api(method, path, body);
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function syncFs(populate) {
  return new Promise((resolve, reject) => Module.FS.syncfs(populate, (err) => err ? reject(err) : resolve()));
}

// Resolves once the player has given us a ROM (stored in this browser only).
async function ensureRom() {
  const FS = Module.FS;
  if (FS.analyzePath(ROM_PATH).exists) { return; }
  setStatus('');
  const picker = document.getElementById('rom-picker');
  picker.hidden = false;
  const file = await new Promise((resolve) => {
    document.getElementById('rom-input').addEventListener('change', (event) => {
      if (event.target.files[0]) { resolve(event.target.files[0]); }
    });
  });
  picker.hidden = true;
  setStatus('Saving ROM…');
  FS.writeFile(ROM_PATH, new Uint8Array(await file.arrayBuffer()));
  await syncFs(false);
}

// Hosted bytes are received only after authentication and membership checks at the relay.
// The /save directory is left on Emscripten's in-memory FS (not IDBFS) for this launch.
async function loadHostedRom(request) {
  setStatus('Loading hosted ROM…');
  const response = await api('POST', '/api/rom', request);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new UserError(`Hosted ROM download failed (${response.status}): ${data.error || 'access denied'}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) { throw new UserError('Hosted ROM download failed: the server returned an empty file.'); }
  Module.FS.writeFile(ROM_PATH, bytes);
}

// Hosted mode keeps /save in memory (the ROM must not be cached), so only the settings file is
// carried across launches, in this origin's localStorage. Without it every launch would be a new player.
const HOSTED_SETTINGS_KEY = 'sm64.hostedSettings.v1';
const HOSTED_SETTINGS_FILE = SAVE_DIR + '/sm64config.txt';
// Never carried over: names, join addresses and passwords stay with this launch.
const HOSTED_SETTINGS_PRIVATE = /^\s*(coopnet_password|coop_player_name|coop_join_ip)(\s|$)/;
const hostedSettingsPublic = (text) => text.split('\n').filter((line) => !HOSTED_SETTINGS_PRIVATE.test(line)).join('\n');
const settingsStorage = (() => { try { return window.localStorage; } catch { return null; } })();
function restoreHostedSettings() {
  try {
    const text = settingsStorage && settingsStorage.getItem(HOSTED_SETTINGS_KEY);
    if (typeof text === 'string' && text.length > 0) { Module.FS.writeFile(HOSTED_SETTINGS_FILE, hostedSettingsPublic(text)); }
  } catch (e) { console.warn('could not restore settings', e); }
}
let hostedSettingsSaved = null;
function persistHostedSettings() {
  try {
    if (!settingsStorage || !Module.FS.analyzePath(HOSTED_SETTINGS_FILE).exists) { return; }
    const text = hostedSettingsPublic(Module.FS.readFile(HOSTED_SETTINGS_FILE, { encoding: 'utf8' }));
    if (text && text !== hostedSettingsSaved) { settingsStorage.setItem(HOSTED_SETTINGS_KEY, text); hostedSettingsSaved = text; }
  } catch (e) { console.warn('could not save settings', e); }
}
function watchHostedSettings() {
  setInterval(persistHostedSettings, 5000);
  if (typeof window.addEventListener === 'function') { window.addEventListener('pagehide', persistHostedSettings); }
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { persistHostedSettings(); } });
  }
}

async function discordSignIn(clientId) {
  // boot.js already signed in (it needed to, to load this file).
  if (window.bootRequest) { return window.bootRequest; }
  setStatus('Signing in with Discord…');
  const { DiscordSDK } = await import('./vendor/discord-sdk.js');
  const sdk = new DiscordSDK(clientId);
  if (sdk.platform === 'mobile') { throw new UserError(DESKTOP_ONLY); }
  await sdk.ready();
  if (!sdk.guildId) {
    throw new UserError('Start this activity from a voice channel in a server. Each server shares one save.');
  }
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds.members.read'],
  });
  const token = await apiJson('POST', '/api/token', { code });
  if (token.status !== 200) { throw new RetryableError('Discord sign-in failed.'); }
  await sdk.commands.authenticate({ access_token: token.data.access_token });
  return { mode: 'discord', access_token: token.data.access_token, guild_id: sdk.guildId };
}

// Asks the relay for a ticket, waiting while someone else is starting up as the host.
async function joinSession(request) {
  for (;;) {
    const { status, data } = await apiJson('POST', '/api/session', request);
    if (status === 200) { return data; }
    if (status === 409 && data.wait) {
      setStatus('Waiting for the host to finish loading…');
      await sleep(2000);
      continue;
    }
    if (status === 403 && request.mode === 'lan') {
      throw new UserError('Open this activity from Discord.');
    }
    if (status >= 500) {
      throw new RetryableError(data.error || `The server had a problem (${status}).`);
    }
    // 409 {full}: the world is full; 429: this account is already playing elsewhere
    throw new UserError(data.error || `The server refused to start a session (${status}).`, status === 409 || status === 429);
  }
}

// The host plays on the server's copy of the save; a missing copy means a fresh save.
async function loadServerSave(ticket) {
  const FS = Module.FS;
  const response = await api('GET', '/api/save?ticket=' + encodeURIComponent(ticket));
  if (response.status === 200) {
    FS.writeFile(SAVE_PATH, new Uint8Array(await response.arrayBuffer()));
  } else if (response.status === 404) {
    if (FS.analyzePath(SAVE_PATH).exists) { FS.unlink(SAVE_PATH); }
  } else {
    throw new RetryableError(`Could not load this server's save (${response.status}).`);
  }
  return FS.analyzePath(SAVE_PATH).exists ? FS.readFile(SAVE_PATH) : null;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
  return true;
}

// Uploads the save within about a second of the game writing it, so little is lost if the host leaves.
function watchSave(ticket, initial) {
  let uploaded = initial;
  let rejected = null; // a save the relay refused as invalid; not retried until it changes
  let uploading = false;
  // Uploads are numbered so the relay can ignore one that arrives after a newer one (the upload sent
  // as the page closes can overtake one still in flight).
  let seq = 0;
  const path = () => `/api/save?ticket=${encodeURIComponent(ticket)}&seq=${++seq}`;
  const readSave = () => Module.FS.analyzePath(SAVE_PATH).exists ? Module.FS.readFile(SAVE_PATH) : null;

  setInterval(async () => {
    const current = readSave();
    if (uploading || !current || sameBytes(current, uploaded) || sameBytes(current, rejected)) { return; }
    uploading = true;
    try {
      const response = await api('PUT', path(), current);
      if (response.ok) {
        uploaded = current;
      } else {
        // 429 (saving too often) is retried on the next check
        if (response.status === 400) { rejected = current; }
        diagnostics.recordSaveUploadFailure();
        console.warn('save upload failed', response.status);
      }
    } catch (e) {
      console.warn('save upload failed', e);
      diagnostics.recordSaveUploadFailure();
    } finally {
      uploading = false;
    }
  }, SAVE_CHECK_INTERVAL_MS);

  // Best effort when the activity is closed between uploads.
  addEventListener('pagehide', () => {
    const current = readSave();
    if (current && !sameBytes(current, uploaded)) {
      fetch(base + path(), { method: 'PUT', body: current, keepalive: true });
    }
  });
}

// Reloads the page to sign in and join again (see the top of this file). Only once the server answers:
// reloading while it's unreachable would replace the page with the browser's (or Discord's) error page,
// and nothing would be left to try again.
async function rejoin(manual) {
  document.getElementById('countdown').textContent = 'Rejoining…';
  if (manual) { rejoinState.failures = 0; rejoinState.rejoins = []; diagnostics.setRejoins(0); }
  try {
    const response = await fetch(base + '/api/config', { cache: 'no-store' });
    if (!response.ok) { throw new Error(`status ${response.status}`); }
  } catch (e) {
    console.warn('server unreachable', e);
    if (manual) { showClosed('Still can\'t reach the server.'); } else { retryAfterFailure('Can\'t reach the server.'); }
    return;
  }
  rejoinState.rejoins.push(Date.now());
  diagnostics.setRejoins(rejoinState.rejoins.length);
  try { sessionStorage.setItem(REJOIN_STATE_KEY, JSON.stringify({ ...rejoinState, savedAt: Date.now() })); } catch {}
  location.reload();
}

let countdown = null;
// Shows why the session ended, with a Rejoin button. With `delayMs`, also rejoins on its own after a
// visible countdown.
function showClosed(message, delayMs) {
  overlay.hidden = false;
  setStatus('');
  document.getElementById('closed').hidden = false;
  document.getElementById('closed-reason').textContent = message;
  const countdownEl = document.getElementById('countdown');
  const button = document.getElementById('reload');
  button.textContent = delayMs === undefined ? 'Rejoin' : 'Rejoin now';
  button.onclick = () => rejoin(true);
  clearInterval(countdown);
  countdownEl.textContent = '';
  if (delayMs === undefined) { return; }
  const deadline = Date.now() + delayMs;
  const tick = () => {
    const left = deadline - Date.now();
    if (left <= 0) {
      clearInterval(countdown);
      rejoin(false);
      return;
    }
    countdownEl.textContent = `Rejoining in ${Math.ceil(left / 1000)}…`;
  };
  tick();
  countdown = setInterval(tick, 200);
}

// Something went wrong that may fix itself: retry with backoff, or give up after a few tries.
function retryAfterFailure(message) {
  rejoinState.failures++;
  if (rejoinState.failures > RETRY_DELAYS_MS.length || rejoinState.rejoins.length >= MAX_REJOINS) {
    showClosed(message);
    return;
  }
  const delay = RETRY_DELAYS_MS[rejoinState.failures - 1] * (0.75 + Math.random() * 0.5);
  showClosed(message, delay);
}

let relayClosed = false;
function onRelayClosed(code, reason) {
  if (relayClosed) { return; }
  relayClosed = true;
  diagnostics.setNetworkState('closed', code);
  diagnostics.setPhase('closed');
  console.log('relay closed the connection', code, reason);
  if (reason === 'host left') {
    if (rejoinState.rejoins.length >= MAX_REJOINS) {
      showClosed('The host left, so this session ended.');
      return;
    }
    rejoinState.failures = 0;
    // Spread out, so one page gets back first and hosts while the others wait for it.
    showClosed('The host left. Everyone rejoins, and the first one back hosts.',
               HOST_LEFT_DELAY_MS + Math.random() * HOST_LEFT_JITTER_MS);
  } else if (reason === 'room is full') {
    showClosed('This world is full. Try again when someone leaves.');
  } else {
    retryAfterFailure('Lost connection to the server.');
  }
}

// Mouse look (free camera) holds the mouse with pointer lock, only during gameplay: the game itself
// leaves pointer lock for pause, menus, chat and the console, and re-takes it on the next click.
// This adds what the browser needs on top (same approach as halo-discord's hosted shell):
// - losing the lock without the game asking (the browser eats Esc) pauses, so nobody is stuck;
// - a click retries once after Chrome's ~1 s re-lock cooldown following an Esc unlock;
// - no Ctrl combination reaches the browser/Discord while locked (Ctrl crouches).
function setupPointerLock(canvas) {
  if (!canvas || typeof canvas.addEventListener !== 'function' || typeof document.addEventListener !== 'function' ||
      typeof window.addEventListener !== 'function') { return; }
  const wantsLock = () => typeof Module._web_controls_wants_pointer_lock === 'function' &&
                          Module._web_controls_wants_pointer_lock() === 1;
  let lastEscape = -Infinity, retryTimer = 0, retried = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { lastEscape = performance.now(); }
    if (e.ctrlKey && document.pointerLockElement === canvas) { e.preventDefault(); }
  }, true);
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) { clearTimeout(retryTimer); return; }
    // Esc that also reached the game already pauses it; don't press Start twice.
    setTimeout(() => {
      if (performance.now() - lastEscape < 400 || document.pointerLockElement === canvas) { return; }
      if (wantsLock() && typeof Module._web_controls_pointer_lock_lost === 'function') {
        Module._web_controls_pointer_lock_lost();
      }
    }, 150);
  });
  const requestLock = () => {
    if (document.pointerLockElement === canvas || !wantsLock()) { return; }
    try {
      const request = canvas.requestPointerLock();
      if (request && typeof request.catch === 'function') { request.catch(onLockError); }
    } catch (e) { onLockError(e); }
  };
  function onLockError() {
    if (retried) { return; }
    retried = true;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(requestLock, 1200); // once, after the re-lock cooldown
  }
  canvas.addEventListener('click', () => { retried = false; requestLock(); });
}
setupPointerLock(document.getElementById('canvas'));

// The Debug button/panel is for menus, not gameplay: once the game runs it shows only while a DJUI
// menu (options, main menu) is open. Before that (loading, errors) it stays visible.
function showDebugPanelOnlyInMenus() {
  const host = document.getElementById('debug-panel-host');
  if (!host || typeof Module._web_ui_menu_open !== 'function') { return; }
  const update = () => { host.hidden = Module._web_ui_menu_open() !== 1; };
  update();
  setInterval(update, 250);
}

const DESKTOP_ONLY = 'This activity only works on desktop for now.';

async function main() {
  // index.html doesn't even load the game on mobile
  if (inDiscord && onMobile) { throw new UserError(DESKTOP_ONLY); }
  if (isRejoin) { setStatus('Rejoining…'); }
  await window.runtimeReady;
  const FS = Module.FS;
  FS.mkdirTree(SAVE_DIR);

  const config = await apiJson('GET', '/api/config');
  diagnostics.setServerEnabled(config.status === 200 && config.data.diagnostics !== false);
  diagnostics.setNetworkState(config.status === 200 ? 'connecting' : config.status === 404 ? 'offline' : 'unknown');
  const hostedRom = config.status === 200 && config.data.hostedRom === true;
  if (!hostedRom) {
    FS.mount(FS.filesystems.IDBFS, {}, SAVE_DIR);
    await syncFs(true);
  }
  if (config.status === 404 && !inDiscord) {
    // Served by a plain static file server (no relay): single player only.
    await ensureRom();
    overlay.hidden = true;
    setInterval(() => syncFs(false).catch((e) => console.warn('syncfs failed', e)), 5000);
    window.sessionInfo = { role: 'offline' };
    Module.callMain(['--savepath', SAVE_DIR, ...extraArgs]);
    showDebugPanelOnlyInMenus();
    diagnostics.setNetworkState('offline');
    diagnostics.setPhase('playing');
    return;
  }
  if (inDiscord && !config.data.discord) { throw new UserError('This server is not set up for Discord yet.'); }
  if (!inDiscord && !config.data.lanTest) { throw new UserError('Open this activity from Discord.'); }

  let request;
  if (hostedRom) {
    request = inDiscord
      ? await discordSignIn(config.data.clientId)
      : { mode: 'lan', room: query.get('room') || 'default', name: query.get('name') || '' };
    await loadHostedRom(request);
  } else {
    // Keep the legacy BYO flow: the player's local ROM is picked/cached before sign-in or reservation.
    await ensureRom();
    request = inDiscord
      ? await discordSignIn(config.data.clientId)
      : { mode: 'lan', room: query.get('room') || 'default', name: query.get('name') || '' };
  }

  setStatus('Joining…');
  const session = await joinSession(request);
  diagnostics.setTicket(session.ticket);
  diagnostics.setNetworkState('connecting');
  const wsBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base;
  Module.relayUrl = wsBase + '/ws?ticket=' + encodeURIComponent(session.ticket);
  Module.onRelayClosed = onRelayClosed;

  const args = ['--savepath', SAVE_DIR];
  // The game rejects names with spaces or unbalanced backslashes and falls back to "Player".
  const playerName = (session.name || '').replace(/\s+/g, '_').replace(/\\/g, '').slice(0, 20);
  if (playerName) { args.push('--playername', playerName); }
  if (session.role === 'host') {
    const initial = await loadServerSave(session.ticket);
    watchSave(session.ticket, initial);
    args.push('--server', '7777');
  } else {
    args.push('--client', 'relay', '7777');
  }

  overlay.hidden = true;
  // Legacy BYO mode persists the local ROM and settings. Hosted mode keeps the ROM in MEMFS and
  // carries only the settings file across launches.
  if (hostedRom) { restoreHostedSettings(); watchHostedSettings(); }
  if (!hostedRom) { setInterval(() => syncFs(false).catch((e) => console.warn('syncfs failed', e)), 5000); }
  window.sessionInfo = { role: session.role, room: session.room, name: session.name,
                         rejoined: isRejoin };
  setTimeout(() => { if (!relayClosed) { rejoinState.failures = 0; } }, STABLE_SESSION_MS);
  Module.callMain([...args, ...extraArgs]);
  showDebugPanelOnlyInMenus();
  if (!relayClosed) {
    diagnostics.setNetworkState('unknown'); // No trustworthy WebSocket-open callback reaches the page.
    diagnostics.setPhase('playing');
  }
}

main().catch((e) => {
  diagnostics.recordRuntimeError(e);
  if (e instanceof TypeError && /fetch/i.test(e.message)) { diagnostics.setNetworkState('unknown'); }
  console.error(e);
  overlay.hidden = false;
  if (e instanceof RetryableError) {
    retryAfterFailure(e.message);
  } else if (e instanceof TypeError && /fetch/i.test(e.message)) {
    retryAfterFailure('Could not reach the server.'); // fetch() itself failed
  } else if (e instanceof UserError && e.canRetry) {
    showClosed(e.message);
  } else {
    setStatus(e instanceof UserError ? e.message : 'Error: ' + e);
  }
});
