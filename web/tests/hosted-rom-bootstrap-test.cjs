// Production web/app.js bootstrap tests with a VM-backed browser/Discord/network boundary.
// Usage: node web/tests/hosted-rom-bootstrap-test.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('node:url');
const appPath = path.join(__dirname, '..', 'app.js');
let source = fs.readFileSync(appPath, 'utf8');
// boot.js loads diagnostics.js (with the asset session) and hands createDiagnostics to app.js.
const diagnosticsImport = "const createDiagnostics = window.createDiagnostics;";
let createDiagnostics;
if (!source.includes(diagnosticsImport)) { throw new Error('production diagnostics import boundary changed; update this test to load the real module'); }
source = source.replace(diagnosticsImport, '');
const sdkImport = "await import('./vendor/discord-sdk.js')";
if (!source.includes(sdkImport)) { throw new Error('production Discord SDK import boundary changed; update the mock explicitly'); }
source = source.replace(sdkImport, 'await Promise.resolve({ DiscordSDK: MockDiscordSDK })');
const hostedBytes = Buffer.from('SYNTHETIC HOSTED FIXTURE - NOT A GAME ROM\0', 'utf8');
const staleBytes = Buffer.from('STALE BROWSER ROM - MUST NOT BE USED', 'utf8');
const userRom = Buffer.from('SYNTHETIC BYO FIXTURE - NOT A GAME ROM', 'utf8');
const GUILD = '222222222222222222';

function uiElement(tagName) {
  let text = '';
  return {
    tagName: tagName.toUpperCase(), children: [], attributes: {}, listeners: [], hidden: false, disabled: false, checked: false,
    set textContent(value) { text = String(value); this.children = []; },
    get textContent() { return text + this.children.map((child) => child.textContent).join(''); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    append(...children) { this.children.push(...children); },
    addEventListener(name, fn) { this.listeners.push({ name, fn }); },
    removeEventListener(name, fn) { this.listeners = this.listeners.filter((item) => item.name !== name || item.fn !== fn); },
  };
}
function uiFind(root, id) {
  if (root.id === id) { return root; }
  for (const child of root.children || []) { const found = uiFind(child, id); if (found) { return found; } }
  return null;
}

function response(status, payload, headers = {}) {
  const bytes = Buffer.isBuffer(payload) ? Buffer.from(payload) : Buffer.from(JSON.stringify(payload || {}));
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => JSON.parse(bytes.toString()),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function runScenario({ search, hosted = false, romResult = 'ok', offline = false, stale = false, diagnosticsEnabled = true, bootRequest = undefined }) {
  const elements = new Map();
  for (const id of ['overlay', 'status', 'rom-picker', 'rom-input', 'closed', 'closed-reason', 'countdown', 'reload']) {
    elements.set(id, { id, hidden: id !== 'status', textContent: '', value: '', addEventListener: null, onclick: null });
  }
  const debugRoot = uiElement('div'); debugRoot.id = 'debug-panel-host'; elements.set(debugRoot.id, debugRoot);
  elements.get('rom-picker').hidden = true;
  elements.get('closed').hidden = true;
  const files = new Map();
  if (stale) { files.set('/save/baserom.us.z64', Uint8Array.from(staleBytes)); }
  const directories = new Set();
  const mounts = [];
  const syncs = [];
  const calls = [];
  const events = [];
  const timers = [];
  let mainArgs = null;
  let filePickerWasShown = false;
  const FS = {
    filesystems: { IDBFS: { name: 'IDBFS' } },
    mkdirTree: (p) => directories.add(p),
    mount: (filesystem, options, mountpoint) => mounts.push({ filesystem, mountpoint }),
    syncfs: (populate, cb) => { syncs.push(populate); cb(null); },
    analyzePath: (p) => ({ exists: files.has(p) }),
    writeFile: (p, bytes) => files.set(p, Uint8Array.from(bytes)),
    readFile: (p) => Uint8Array.from(files.get(p)),
    unlink: (p) => files.delete(p),
  };
  const picker = elements.get('rom-input');
  picker.addEventListener = (eventName, fn) => {
    if (eventName !== 'change') { throw new Error(`unexpected picker event ${eventName}`); }
    filePickerWasShown = !elements.get('rom-picker').hidden;
    queueMicrotask(() => fn({ target: { files: [{ arrayBuffer: async () => userRom.buffer.slice(userRom.byteOffset, userRom.byteOffset + userRom.byteLength) }] } }));
  };
  const sessionStorageValues = new Map();
  class MockDiscordSDK {
    constructor(clientId) {
      this.clientId = clientId;
      this.guildId = GUILD;
      this.platform = 'desktop';
      this.commands = {
        authorize: async () => ({ code: 'synthetic-code' }),
        authenticate: async () => ({ access_token: 'synthetic-token' }),
      };
    }
    async ready() {}
  }
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url, 'https://activity.invalid');
    const route = parsed.pathname;
    let body;
    try { body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : options.body; } catch {}
    calls.push({ url, route, method: options.method || 'GET', headers: options.headers, body, cache: options.cache });
    if (route.endsWith('/api/config')) {
      return offline ? response(404, { error: 'not a relay' })
        : response(200, { clientId: 'mock-client', discord: true, lanTest: true, hostedRom: hosted, diagnostics: diagnosticsEnabled });
    }
    if (route.endsWith('/api/token')) { return response(200, { access_token: 'synthetic-token' }); }
    if (route.endsWith('/api/rom')) {
      if (romResult === 'network') { throw new TypeError('Failed to fetch'); }
      if (romResult === 'denied') { return response(403, { error: 'server allowlist denied this guild' }); }
      return response(200, hostedBytes, { 'cache-control': 'no-store' });
    }
    if (route.endsWith('/api/session')) {
      events.push({ event: 'session', rom: files.get('/save/baserom.us.z64') && Array.from(files.get('/save/baserom.us.z64')) });
      return response(200, { ticket: 'ticket-1', role: 'host', room: 'g' + GUILD, name: 'Tester' });
    }
    if (route.includes('/api/save')) { return response(404, { error: 'no saved world yet' }); }
    throw new Error(`unexpected request ${route}`);
  };
  const location = { search, host: 'activity.invalid', protocol: 'https:', reload() {} };
  const storageValues = new Map();
  const localStorage = {
    getItem: (key) => storageValues.has(key) ? storageValues.get(key) : null,
    setItem: (key, value) => storageValues.set(key, String(value)),
  };
  const windowListeners = new Map();
  const window = {
    runtimeReady: Promise.resolve(), localStorage, AbortController, bootRequest,
    addEventListener: (name, fn) => windowListeners.set(name, fn),
    removeEventListener: (name, fn) => { if (windowListeners.get(name) === fn) { windowListeners.delete(name); } },
  };
  const documentListeners = new Map();
  const document = {
    visibilityState: 'visible', getElementById: (id) => elements.get(id), createElement: uiElement,
    addEventListener: (name, fn) => documentListeners.set(name, fn),
    removeEventListener: (name, fn) => { if (documentListeners.get(name) === fn) { documentListeners.delete(name); } },
  };
  const context = {
    createDiagnostics, window, Module: { FS, callMain: (args) => { mainArgs = args.slice(); } },
    document, location, URLSearchParams, URL, fetch, MockDiscordSDK, console: { log() {}, warn() {}, error() {} },
    sessionStorage: {
      getItem: (key) => sessionStorageValues.get(key) || null,
      setItem: (key, value) => sessionStorageValues.set(key, value),
      removeItem: (key) => sessionStorageValues.delete(key),
    },
    addEventListener: (name, fn) => events.push({ event: name, fn }),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval() {}, clearTimeout() {}, setTimeout: () => 1, Math, Date, Uint8Array, Buffer, TypeError,
  };
  vm.runInNewContext(source, context, { filename: appPath });
  for (let attempt = 0; attempt < 100 && !mainArgs && !elements.get('status').textContent && !elements.get('closed-reason').textContent; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { calls, events, files, mounts, syncs, timers, mainArgs, elements, window, filePickerWasShown };
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
  if (!ok) { failures++; }
}
const routeIndex = (calls, ending) => calls.findIndex((call) => call.route.endsWith(ending));

(async () => {
  ({ createDiagnostics } = await import(pathToFileURL(path.join(__dirname, '..', 'diagnostics.js'))));
  const launch = await runScenario({ search: '?frame_id=hosted&instance_id=test', hosted: true, stale: true });
  const romCall = launch.calls.find((call) => call.route.endsWith('/api/rom'));
  const sessionCall = launch.calls.find((call) => call.route.endsWith('/api/session'));
  check('hosted Discord launch signs in, downloads via same-origin proxy, then reserves', !!romCall && !!sessionCall
        && launch.calls[0].route === '/.proxy/api/config'
        && routeIndex(launch.calls, '/api/token') < routeIndex(launch.calls, '/api/rom')
        && routeIndex(launch.calls, '/api/rom') < routeIndex(launch.calls, '/api/session')
        && romCall.url === '/.proxy/api/rom' && romCall.method === 'POST'
        && romCall.headers?.['Content-Type'] === 'application/json'
        && romCall.cache === 'no-store' && romCall.body?.mode === 'discord'
        && romCall.body?.access_token === 'synthetic-token' && romCall.body?.guild_id === GUILD,
        launch.calls.map(({ route, method, cache }) => ({ route, method, cache })));
  check('hosted launch overwrites stale ROM bytes in memory before reservation and starts game',
        launch.mainArgs !== null
        && launch.files.get('/save/baserom.us.z64') && Buffer.from(launch.files.get('/save/baserom.us.z64')).equals(hostedBytes)
        && Buffer.from(sessionCall?.body ? launch.events.find((e) => e.event === 'session')?.rom || [] : []).equals(hostedBytes),
        { mainArgs: launch.mainArgs, staleWasLeft: Buffer.from(launch.files.get('/save/baserom.us.z64') || []).equals(staleBytes) });
  check('hosted mode skips picker and never mounts or syncs persistent IDBFS', !launch.filePickerWasShown
        && launch.elements.get('rom-picker').hidden && launch.mounts.length === 0 && launch.syncs.length === 0,
        { picker: launch.filePickerWasShown, mounts: launch.mounts.length, syncs: launch.syncs });
  check('production debug UI is mounted, retains no ticket in sessionInfo and has accessible controls',
        !!uiFind(launch.elements.get('debug-panel-host'), 'debug-toggle')
        && uiFind(launch.elements.get('debug-panel-host'), 'debug-toggle').getAttribute('aria-controls') === 'debug-panel'
        && !!uiFind(launch.elements.get('debug-panel-host'), 'debug-report-audio')
        && launch.window.sessionInfo && !Object.hasOwn(launch.window.sessionInfo, 'ticket')
        && !launch.calls.some((call) => call.route.endsWith('/api/diagnostics')),
        { infoKeys: Object.keys(launch.window.sessionInfo || {}), debugRequest: launch.calls.some((call) => call.route.endsWith('/api/diagnostics')) });
  check('gameplay reports relay transport as unavailable instead of leaving a false connecting state',
        launch.mainArgs !== null
        && uiFind(launch.elements.get('debug-panel-host'), 'debug-field-network-state')?.textContent === 'Transport state unavailable',
        uiFind(launch.elements.get('debug-panel-host'), 'debug-field-network-state')?.textContent);

  const denied = await runScenario({ search: '?frame_id=denied&instance_id=test', hosted: true, romResult: 'denied', stale: true });
  check('hosted ROM HTTP denial is reported and does not reserve a ticket or run the game',
        denied.calls.some((c) => c.route.endsWith('/api/rom')) && !denied.calls.some((c) => c.route.endsWith('/api/session'))
        && denied.mainArgs === null && denied.elements.get('status').textContent.includes('403')
        && denied.elements.get('status').textContent.includes('allowlist'), denied.elements.get('status').textContent);
  const network = await runScenario({ search: '?frame_id=network&instance_id=test', hosted: true, romResult: 'network', stale: true });
  check('hosted ROM network error is reported without falling back or reserving',
        network.calls.some((c) => c.route.endsWith('/api/rom')) && !network.calls.some((c) => c.route.endsWith('/api/session'))
        && network.mainArgs === null && network.elements.get('closed-reason').textContent.includes('reach the server'),
        network.elements.get('closed-reason').textContent);

  const signedIn = await runScenario({ search: '?frame_id=boot&instance_id=test', hosted: true,
    bootRequest: { mode: 'discord', access_token: 'boot-token', guild_id: GUILD } });
  const signedInRom = signedIn.calls.find((c) => c.route.endsWith('/api/rom'));
  check('a sign-in done by boot.js is reused (no second Discord authorization or token exchange)',
        signedIn.mainArgs !== null && !signedIn.calls.some((c) => c.route.endsWith('/api/token'))
        && signedInRom?.body?.access_token === 'boot-token',
        signedIn.calls.map(({ route }) => route));

  const offline = await runScenario({ search: '', offline: true });
  check('plain static/offline BYO mode still opens picker, saves in IDBFS and starts offline',
        offline.filePickerWasShown && offline.mounts.some((m) => m.mountpoint === '/save')
        && offline.syncs.includes(true) && offline.syncs.includes(false)
        && Buffer.from(offline.files.get('/save/baserom.us.z64') || []).equals(userRom)
        && offline.mainArgs?.includes('--savepath') && !offline.calls.some((c) => c.route.endsWith('/api/session'))
        && !offline.calls.some((c) => c.route.endsWith('/api/diagnostics'))
        && uiFind(offline.elements.get('debug-panel-host'), 'debug-report-audio').disabled,
        { picker: offline.filePickerWasShown, mounts: offline.mounts.length, syncs: offline.syncs, mainArgs: offline.mainArgs });

  const disabledReporting = await runScenario({ search: '?room=test', diagnosticsEnabled: false });
  const disabledRoot = disabledReporting.elements.get('debug-panel-host');
  check('server diagnostics=false disables reporting controls while leaving local panel and game flow intact',
        disabledReporting.mainArgs !== null && !!uiFind(disabledRoot, 'debug-toggle')
        && !uiFind(disabledRoot, 'debug-reporting').disabled
        && uiFind(disabledRoot, 'debug-report-audio').disabled
        && !disabledReporting.calls.some((c) => c.route.endsWith('/api/diagnostics')),
        { mainArgs: disabledReporting.mainArgs, diagnosticsPosted: disabledReporting.calls.some((c) => c.route.endsWith('/api/diagnostics')) });

  console.log(failures ? `${failures} browser bootstrap check(s) failed` : 'PASS: all browser bootstrap checks');
  process.exit(failures ? 1 : 0);
})();
