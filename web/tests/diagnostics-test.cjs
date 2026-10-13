// Production-module diagnostics tests; all network/audio inputs are synthetic.
// Usage: node web/tests/diagnostics-test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let createDiagnostics;

class Node {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) { this.listeners.set(name, []); }
    this.listeners.get(name).push(callback);
  }
  removeEventListener(name, callback) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((fn) => fn !== callback));
  }
  dispatch(name, extra = {}) {
    const event = { type: name, target: this, stopPropagation() {}, preventDefault() {}, ...extra };
    for (const callback of this.listeners.get(name) || []) { callback(event); }
    return event;
  }
  click() { if (!this.disabled) { this.dispatch('click'); } }
}

function findById(root, id) {
  if (root.id === id) { return root; }
  for (const child of root.children) { const found = findById(child, id); if (found) { return found; } }
  return null;
}

class FakeClock {
  constructor() { this.time = 100; this.nextId = 1; this.jobs = new Map(); }
  setTimeout(fn, delay = 0) { return this.add(fn, delay, 0); }
  setInterval(fn, delay = 0) { return this.add(fn, delay, Math.max(1, delay)); }
  add(fn, delay, interval) {
    const id = this.nextId++;
    this.jobs.set(id, { id, fn, due: this.time + Math.max(0, delay), interval, order: id });
    return id;
  }
  clear(id) { this.jobs.delete(id); }
  async advance(ms) {
    const end = this.time + ms;
    for (let guard = 0; guard < 10000; guard++) {
      const job = [...this.jobs.values()].filter((item) => item.due <= end)
        .sort((a, b) => a.due - b.due || a.order - b.order)[0];
      if (!job) { break; }
      this.time = job.due;
      if (!this.jobs.has(job.id)) { continue; }
      if (job.interval) { job.due += job.interval; }
      else { this.jobs.delete(job.id); }
      const result = job.fn();
      if (result && typeof result.then === 'function') { await result; }
      await Promise.resolve(); await Promise.resolve();
      if (guard === 9999) { throw new Error('fake timer runaway'); }
    }
    this.time = end;
    await Promise.resolve(); await Promise.resolve();
  }
}

function response(status, payload = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

function harness(options = {}) {
  const clock = new FakeClock();
  const root = new Node('div'); root.id = 'debug-panel-host';
  const documentListeners = new Map();
  const document = {
    visibilityState: 'visible',
    createElement: (tag) => new Node(tag),
    addEventListener(name, fn) { documentListeners.set(name, fn); },
    removeEventListener(name, fn) { if (documentListeners.get(name) === fn) { documentListeners.delete(name); } },
  };
  const windowListeners = new Map();
  const window = {
    addEventListener(name, fn) { windowListeners.set(name, [...(windowListeners.get(name) || []), fn]); },
    removeEventListener(name, fn) {
      const remaining = (windowListeners.get(name) || []).filter((item) => item !== fn);
      if (remaining.length) { windowListeners.set(name, remaining); } else { windowListeners.delete(name); }
    }
  };
  const values = new Map(Object.entries(options.storage || {}));
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const requests = [];
  const responseQueue = [];
  let fetchBehavior = async () => responseQueue.length ? responseQueue.shift() : response(202, { stored: true, sessionId: 'opaque-synthetic-id' });
  const fetch = async (url, init) => { requests.push({ url, init }); return fetchBehavior(url, init); };
  let statsCalls = 0;
  const statsFactory = options.statsFactory || ((time) => ({
    time: time / 1000, ticks: Math.floor(time * 30 / 1000), frames: Math.floor(time * 60 / 1000),
    worstTickMs: 4, audioApi: 'sdl', audioStatus: 0, audioQueued: 2048,
    audioDropped: Math.floor(time / 10000), audioEmpty: Math.floor(time / 15000), audioPeak: 900,
  }));
  const Module = {
    UTF8ToString: () => options.badJson ? '{broken json' : JSON.stringify(statsFactory(clock.time)),
    _web_debug_stats: () => { statsCalls++; return 1; },
    SDL2: options.audioContext === false ? undefined : {
      audioContext: { state: 'running', sampleRate: 48000 },
      audio: options.processor ? { scriptProcessorNode: options.processor } : {},
    },
  };
  class AbortControllerMock {
    constructor() { this.signal = { aborted: false }; }
    abort() { this.signal.aborted = true; }
  }
  const observerInstances = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.observed = false; observerInstances.push(this); }
    observe() { this.observed = true; }
    disconnect() { this.observed = false; }
  }
  const rafCallbacks = new Map(); let nextRaf = 0;
  const requestAnimationFrame = options.noRaf ? undefined : (fn) => { const id = ++nextRaf; rafCallbacks.set(id, fn); return id; };
  const cancelAnimationFrame = (id) => rafCallbacks.delete(id);
  const api = createDiagnostics({
    root, document, window, Module, fetch, base: options.base || '', storage, now: () => clock.time,
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clear.bind(clock),
    setInterval: clock.setInterval.bind(clock), clearInterval: clock.clear.bind(clock),
    AbortController: AbortControllerMock,
    PerformanceObserver: options.noObserver ? undefined : Observer,
    requestAnimationFrame, cancelAnimationFrame,
  });
  return {
    api, clock, root, document, window, documentListeners, windowListeners, storage, values,
    requests, responseQueue, setFetchBehavior(fn) { fetchBehavior = fn; }, observerInstances, rafCallbacks,
    statsCalls: () => statsCalls, setStatsFactory(fn) { Module.UTF8ToString = () => JSON.stringify(fn(clock.time)); },
    module: Module, find: (id) => findById(root, id),
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function exactKeys(value, expected) { assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); }
const flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); } };

(async () => {
  ({ createDiagnostics } = await import(pathToFileURL(path.join(__dirname, '..', 'diagnostics.js'))));

  test('opt-in defaults on; explicit opt-out persists across instances', async () => {
    const h = harness();
    assert.equal(h.find('debug-reporting').checked, true);
    h.find('debug-reporting').checked = false;
    h.find('debug-reporting').dispatch('change');
    assert.equal(h.values.get('sm64-debug-reporting'), 'false');
    h.api.stop();
    const again = harness({ storage: { 'sm64-debug-reporting': 'false' } });
    assert.equal(again.find('debug-reporting').checked, false);
    assert.equal(again.find('debug-report-audio').disabled, true);
    again.api.stop();
  });

  test('automatic relay disclosure and opt-out remain visible while the debug panel is closed', async () => {
    const h = harness();
    const panel = h.find('debug-panel');
    const disclosure = h.find('debug-reporting-notice');
    const reporting = h.find('debug-reporting');
    assert.equal(panel.hidden, true);
    assert.ok(disclosure && reporting);
    assert.match(disclosure.textContent, /automatically/i);
    assert.match(disclosure.textContent, /relay/i);
    assert.match(disclosure.textContent, /no recordings/i);
    assert.match(h.root.textContent, /Automatic reports: on/i);
    for (const node of [disclosure, reporting]) {
      for (let parent = node; parent; parent = parent.parentNode) { assert.notEqual(parent, panel); }
    }
    reporting.checked = false; reporting.dispatch('change');
    assert.match(h.root.textContent, /Automatic reports: off/i);
    assert.equal(h.values.get('sm64-debug-reporting'), 'false');
    assert.equal(h.find('debug-reporting').checked, false);
    h.api.stop();
  });

  test('no pre-auth/offline upload; local collectors remain available', async () => {
    const h = harness();
    h.api.setServerEnabled(true);
    h.api.setNetworkState('offline');
    h.api.setPhase('playing');
    await h.clock.advance(20000);
    assert.equal(h.requests.length, 0);
    assert.ok(h.api.snapshot().game.ticksPerSec >= 0);
    assert.match(h.find('debug-upload-status').textContent, /local|join|ready|not sent|offline/i);
    h.api.stop();
  });

  test('pre-ticket and offline errors and history stay local after ticket assignment', async () => {
    const h = harness();
    h.api.setServerEnabled(true);
    h.api.setNetworkState('offline');
    h.api.recordRuntimeError(new TypeError('pre-ticket secret message'));
    await h.clock.advance(2000);
    assert.equal(h.requests.length, 0);
    assert.equal(h.api.snapshot().runtime.errors, 1);
    h.api.setTicket('ticket-after-auth');
    h.api.setPhase('playing');
    await h.clock.advance(1000);
    await h.api.sendReport('issue', 'runtime'); await flush();
    const first = JSON.parse(h.requests[0].init.body);
    assert.equal(first.sample.runtime.errors, 0);
    assert.equal(first.sample.runtime.lastError, 'none');
    assert.equal(first.history.length, 1);
    assert.ok(first.history.every((sample) => sample.runtime.errors === 0 && sample.runtime.lastError === 'none'));
    assert.doesNotMatch(h.requests[0].init.body, /pre-ticket|TypeError/);
    h.api.recordRuntimeError(new RangeError('post-ticket secret message'));
    await h.clock.advance(750); await flush();
    const later = JSON.parse(h.requests.at(-1).init.body);
    assert.equal(later.kind, 'error');
    assert.equal(later.sample.runtime.errors, 1);
    assert.equal(later.sample.runtime.lastError, 'RangeError');
    assert.doesNotMatch(h.requests.at(-1).init.body, /pre-ticket|post-ticket secret/);
    h.api.stop();
  });

  test('automatic reports use exact allowlisted contract, same-origin route and 15s cadence', async () => {
    const h = harness({ base: '/.proxy' });
    h.api.setServerEnabled(true);
    h.api.setTicket('ticket-SECRET-marker');
    h.api.setNetworkState('connecting');
    h.api.setPhase('playing');
    await h.clock.advance(14999);
    assert.equal(h.requests.length, 0);
    await h.clock.advance(1);
    await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/.proxy/api/diagnostics');
    assert.equal(h.requests[0].init.method, 'POST');
    assert.equal(h.requests[0].init.headers['Content-Type'], 'application/json');
    const body = h.requests[0].init.body;
    const payload = JSON.parse(body);
    exactKeys(payload, ['ticket', 'version', 'kind', 'category', 'seq', 'sample', 'history']);
    assert.deepEqual({ ticket: payload.ticket, version: payload.version, kind: payload.kind, category: payload.category, seq: payload.seq },
      { ticket: 'ticket-SECRET-marker', version: 1, kind: 'periodic', category: 'other', seq: 1 });
    assert.ok(payload.history.length <= 6);
    const allowed = {
      uptimeMs: 'number', phase: 'string', visible: 'boolean',
      game: ['ticksPerSec', 'framesPerSec', 'worstTickMs'],
      audio: ['state', 'sampleRate', 'queueFrames', 'emptyDelta', 'droppedDelta', 'peak', 'callbacks', 'lateCallbacks', 'maxCallbackGapMs', 'sampledFrames', 'clippedSamples', 'boundaryJumps'],
      performance: ['longTasks', 'longestTaskMs', 'maxRafGapMs'],
      network: ['state', 'closeCode', 'rejoins', 'uploadFailures'],
      runtime: ['errors', 'lastError'],
    };
    const sampleKeys = ['uptimeMs', 'phase', 'visible', 'game', 'audio', 'performance', 'network', 'runtime'];
    for (const sample of [payload.sample, ...payload.history]) {
      assert.ok(Object.keys(sample).every((key) => sampleKeys.includes(key)), 'unknown sample key');
      for (const [key, value] of Object.entries(sample)) {
        if (Array.isArray(allowed[key])) {
          assert.ok(Object.keys(value).every((field) => allowed[key].includes(field)), `unknown ${key} field`);
        }
      }
    }
    assert.ok(Buffer.byteLength(body, 'utf8') <= 16 * 1024);
    assert.equal(body.match(/ticket-SECRET-marker/g)?.length, 1);
    assert.ok(!body.includes('access_token'));
    assert.ok(!body.includes('guild_id'));
    assert.ok(!body.includes('URLSearchParams'));
    assert.equal(h.find('debug-upload-status').textContent.includes('opaque-synthetic-id'), true);
    await h.clock.advance(14999);
    assert.equal(h.requests.length, 1);
    await h.clock.advance(1);
    await flush();
    assert.equal(h.requests.length, 2);
    h.api.stop();
  });

  test('ring history is bounded, malformed stats are harmless, resets do not create negative deltas', async () => {
    let ticks = 0, frames = 0, dropped = 0, empty = 0;
    const h = harness({ statsFactory: (time) => ({ time: time / 1000, ticks, frames, framesPerSec: 30,
      worstTickMs: 2, audioApi: 'sdl', audioQueued: 3000, audioDropped: dropped, audioEmpty: empty, audioPeak: 0 }) });
    h.api.setServerEnabled(true); h.api.setTicket('ticket'); h.api.setPhase('playing');
    await h.clock.advance(9000);
    assert.ok(h.api.snapshot().audio.emptyDelta >= 0);
    ticks = 2; frames = 3; dropped = 1; empty = 0;
    await h.clock.advance(1000);
    assert.ok(h.api.snapshot().game.ticksPerSec >= 0);
    h.find('debug-report-other').click(); await flush();
    const payload = JSON.parse(h.requests[0].init.body);
    assert.equal(payload.kind, 'issue');
    assert.equal(payload.category, 'other');
    assert.equal(payload.history.length, 6);
    const bad = harness({ badJson: true, noObserver: true, noRaf: true, audioContext: false });
    await bad.clock.advance(1000);
    assert.doesNotThrow(() => bad.api.snapshot());
    assert.equal(bad.statsCalls(), 1);
    bad.api.stop(); h.api.stop();
  });

  test('issue categories upload current sample and at most six recent samples; unknown keys are dropped', async () => {
    const h = harness();
    h.api.setServerEnabled(true); h.api.setTicket('ticket'); h.api.setPhase('playing');
    h.api.registerCollector('audio', () => ({ peak: 12, secret: 'DO-NOT-SEND', unexpected: { id: 'x' } }));
    await h.clock.advance(8000);
    h.find('debug-report-audio').click(); await flush();
    const body = h.requests[0].init.body;
    const payload = JSON.parse(body);
    assert.equal(payload.kind, 'issue'); assert.equal(payload.category, 'audio');
    assert.ok(payload.history.length <= 6);
    assert.ok(!body.includes('DO-NOT-SEND'));
    assert.ok(!body.includes('unexpected'));
    assert.throws(() => h.api.registerCollector('identity', () => ({ user: 'x' })), /section|collector/i);
    h.api.stop();
  });

  test('each issue button emits its selected bounded category', async () => {
    const h = harness(); h.api.setServerEnabled(true); h.api.setTicket('ticket');
    for (const category of ['audio', 'performance', 'network', 'runtime', 'other']) {
      h.find(`debug-report-${category}`).click(); await flush();
      const payload = JSON.parse(h.requests.at(-1).init.body);
      assert.equal(payload.kind, 'issue'); assert.equal(payload.category, category);
    }
    assert.equal(h.requests.length, 5);
    h.api.stop();
  });

  test('server config false and user opt-out disable all uploads/buttons but preserve local panel', async () => {
    const h = harness();
    h.api.setTicket('ticket'); h.api.setServerEnabled(false); h.api.setPhase('playing');
    assert.equal(h.find('debug-reporting').disabled, false);
    assert.equal(h.find('debug-report-audio').disabled, true);
    assert.ok(h.api.snapshot().audio);
    h.api.setServerEnabled(true);
    h.find('debug-reporting').checked = false; h.find('debug-reporting').dispatch('change');
    await h.clock.advance(20000);
    h.find('debug-report-performance').click(); await flush();
    assert.equal(h.requests.length, 0);
    assert.match(h.find('debug-upload-status').textContent, /off|disabled/i);
    h.api.stop();
  });

  test('runtime error uploads normalized class only and coalesces a burst', async () => {
    const h = harness(); h.api.setServerEnabled(true); h.api.setTicket('ticket'); h.api.setPhase('playing');
    for (const listener of h.windowListeners.get('error') || []) {
      listener({ error: Object.assign(new TypeError('RAW secret /auth?token=abc'), { stack: 'SECRET-STACK' }), message: 'RAW secret' });
    }
    for (const listener of h.windowListeners.get('unhandledrejection') || []) {
      listener({ reason: Object.assign(new RangeError('RAW second-secret'), { stack: 'SECRET-STACK' }) });
    }
    await h.clock.advance(1000); await flush();
    assert.equal(h.requests.length, 1);
    const payload = JSON.parse(h.requests[0].init.body);
    assert.equal(payload.kind, 'error'); assert.equal(payload.category, 'runtime');
    assert.equal(payload.sample.runtime.lastError, 'RangeError');
    assert.equal(payload.sample.runtime.errors, 2);
    assert.ok(!h.requests[0].init.body.includes('RAW'));
    assert.ok(!h.requests[0].init.body.includes('SECRET-STACK'));
    h.api.stop();
  });

  test('singleflight, bounded 503 retry/backoff, and timeout are visible not fatal', async () => {
    const h = harness(); h.api.setServerEnabled(true); h.api.setTicket('ticket'); h.api.setPhase('playing');
    let attempts = 0;
    h.setFetchBehavior(async () => { attempts++; return response(503, { error: 'secret body' }); });
    h.find('debug-report-audio').click(); h.find('debug-report-network').click();
    await flush();
    assert.equal(attempts, 1);
    await h.clock.advance(500); await flush();
    assert.equal(attempts, 2);
    await h.clock.advance(1500); await flush();
    assert.equal(attempts, 4);
    assert.equal(JSON.parse(h.requests[0].init.body).category, 'audio');
    assert.equal(JSON.parse(h.requests[3].init.body).category, 'network');
    assert.match(h.find('debug-upload-status').textContent, /not accept|unavailable|failed|retry|sending/i);
    assert.ok(!h.find('debug-upload-status').textContent.includes('secret'));
    h.api.stop();

    const timeout = harness(); timeout.api.setServerEnabled(true); timeout.api.setTicket('ticket');
    timeout.setFetchBehavior(() => new Promise(() => {}));
    timeout.find('debug-report-audio').click(); await flush();
    await timeout.clock.advance(5001); await flush();
    assert.match(timeout.find('debug-upload-status').textContent, /timed out|timeout/i);
    timeout.api.stop();

    const bodyTimeout = harness(); bodyTimeout.api.setServerEnabled(true); bodyTimeout.api.setTicket('ticket');
    bodyTimeout.setFetchBehavior(async () => ({ status: 202, json: () => new Promise(() => {}) }));
    bodyTimeout.find('debug-report-audio').click(); await flush();
    await bodyTimeout.clock.advance(5001); await flush();
    assert.match(bodyTimeout.find('debug-upload-status').textContent, /timed out|timeout/i);
    bodyTimeout.api.stop();
  });

  test('manual issue clicked during periodic upload is sent afterward with its category snapshot', async () => {
    const h = harness(); h.api.setServerEnabled(true); h.api.setTicket('ticket'); h.api.setPhase('playing');
    let resolvePeriodic;
    let active = 0; let maxActive = 0;
    h.setFetchBehavior(async () => {
      active++; maxActive = Math.max(maxActive, active);
      if (h.requests.length === 1) {
        return new Promise((resolve) => { resolvePeriodic = (value) => { active--; resolve(value); }; });
      }
      active--;
      return response(202, { stored: true, sessionId: 'queued-issue' });
    });
    const periodic = h.api.sendReport('periodic', 'other'); await flush();
    assert.equal(h.requests.length, 1);
    const issue = h.api.sendReport('issue', 'audio');
    assert.match(h.find('debug-upload-status').textContent, /queued/i);
    assert.equal(h.requests.length, 1);
    h.api.recordRuntimeError(new TypeError('newer local sample'));
    resolvePeriodic(response(202, { stored: true, sessionId: 'periodic' }));
    assert.equal(await periodic, true);
    await flush();
    assert.equal(h.requests.length, 2);
    const payload = JSON.parse(h.requests[1].init.body);
    assert.equal(payload.kind, 'issue');
    assert.equal(payload.category, 'audio');
    assert.equal(payload.sample.runtime.errors, 0);
    assert.equal(await issue, true);
    assert.equal(maxActive, 1);
    h.api.stop();
  });

  test('opt-out, expired ticket, and stop cancel a queued manual issue', async () => {
    async function queuedHarness() {
      const h = harness(); h.api.setServerEnabled(true); h.api.setTicket('ticket');
      let resolvePeriodic;
      h.setFetchBehavior(() => new Promise((resolve) => { resolvePeriodic = resolve; }));
      const periodic = h.api.sendReport('periodic', 'other'); await flush();
      const issue = h.api.sendReport('issue', 'audio');
      await flush();
      return { h, periodic, issue, resolvePeriodic };
    }

    const optedOut = await queuedHarness();
    optedOut.h.find('debug-reporting').checked = false;
    optedOut.h.find('debug-reporting').dispatch('change');
    assert.equal(await optedOut.issue, false);
    assert.equal(await optedOut.periodic, false);
    assert.equal(optedOut.h.requests.length, 1);
    assert.equal(optedOut.h.requests[0].init.signal.aborted, true);
    optedOut.h.api.stop();

    const expired = await queuedHarness();
    expired.resolvePeriodic(response(403));
    assert.equal(await expired.periodic, false);
    assert.equal(await expired.issue, false);
    await expired.h.clock.advance(6000);
    assert.equal(expired.h.requests.length, 1);
    expired.h.api.stop();

    const stopped = await queuedHarness();
    stopped.h.api.stop();
    assert.equal(await stopped.issue, false);
    assert.equal(await stopped.periodic, false);
    assert.equal(stopped.h.requests.length, 1);
    assert.equal(stopped.h.requests[0].init.signal.aborted, true);
  });

  test('opt-out cancels an in-flight upload immediately; expired tickets disable further reports', async () => {
    const h = harness(); h.api.setServerEnabled(true); h.api.setTicket('ticket');
    h.setFetchBehavior(() => new Promise(() => {}));
    h.find('debug-report-audio').click(); await flush();
    assert.equal(h.requests.length, 1);
    h.find('debug-reporting').checked = false; h.find('debug-reporting').dispatch('change');
    await flush();
    await h.clock.advance(6000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].init.signal.aborted, true);
    assert.match(h.find('debug-upload-status').textContent, /off/i);
    h.api.stop();

    const expired = harness(); expired.api.setServerEnabled(true); expired.api.setTicket('expired-ticket');
    expired.setFetchBehavior(async () => response(403));
    expired.find('debug-report-runtime').click(); await flush();
    assert.match(expired.find('debug-upload-status').textContent, /expired; no further reports/i);
    assert.equal(expired.find('debug-report-audio').disabled, true);
    expired.api.stop();
  });

  test('transparent audio wrapper preserves this, args, return, thrown value, no double wrap and cleanup', async () => {
    const processor = { onaudioprocess: null };
    const sentinel = { id: 'sentinel' };
    let seenThis, seenArgs, calls = 0;
    processor.onaudioprocess = function (event, second) { calls++; seenThis = this; seenArgs = [event, second]; return sentinel; };
    const h = harness({ processor });
    await h.clock.advance(1000);
    const original = processor.onaudioprocess;
    assert.notEqual(original, null); assert.notEqual(original, undefined);
    const event = { outputBuffer: { duration: 0.01, length: 480, numberOfChannels: 1, getChannelData: () => new Float32Array(480) } };
    assert.equal(original.call(processor, event, 'arg-two'), sentinel);
    assert.equal(seenThis, processor); assert.deepEqual(seenArgs, [event, 'arg-two']);
    await h.clock.advance(1000);
    assert.equal(processor.onaudioprocess, original);
    const boom = new TypeError('do not expose');
    const throwingOriginal = function () { throw boom; };
    processor.onaudioprocess = throwingOriginal;
    await h.clock.advance(1000);
    const throwing = processor.onaudioprocess;
    assert.throws(() => throwing.call(processor, event), (error) => error === boom);
    h.api.stop();
    assert.equal(processor.onaudioprocess, throwingOriginal);
    assert.equal(calls, 1);
  });

  test('bounded signal sampling reports injected late/clipped/boundary evidence without recording arrays', async () => {
    const processor = { onaudioprocess() {} };
    const h = harness({ processor });
    await h.clock.advance(1000);
    for (let i = 0; i < 16; i++) {
      h.clock.time += 30;
      const samples = new Float32Array(480);
      samples.fill(i === 7 ? 1 : i === 15 ? -1 : 0.02);
      processor.onaudioprocess({ outputBuffer: { duration: 0.01, length: 480, numberOfChannels: 1, getChannelData: () => samples } });
    }
    await h.clock.advance(1000);
    const audio = h.api.snapshot().audio;
    assert.ok(audio.callbacks >= 8);
    assert.ok(audio.lateCallbacks > 0);
    assert.ok(audio.maxCallbackGapMs >= 30);
    assert.ok(audio.sampledFrames > 0);
    assert.ok(audio.clippedSamples > 0);
    assert.ok(audio.boundaryJumps > 0);
    const text = h.root.textContent;
    assert.doesNotMatch(text, /0\.02|1,1,1|Float32Array/);
    h.api.stop();
  });

  test('continuous adjacent output endpoints do not create boundary jumps', async () => {
    const processor = { onaudioprocess() {} };
    const h = harness({ processor });
    await h.clock.advance(1000);
    let frame = 0;
    for (let callback = 0; callback < 16; callback++) {
      const samples = new Float32Array(480);
      for (let i = 0; i < samples.length; i++, frame++) { samples[i] = Math.sin(2 * Math.PI * frame / 1000); }
      processor.onaudioprocess({ outputBuffer: { duration: 0.01, length: 480, numberOfChannels: 1, getChannelData: () => samples } });
    }
    await h.clock.advance(1000);
    assert.equal(h.api.snapshot().audio.boundaryJumps, 0);
    h.api.stop();

    const discontinuousProcessor = { onaudioprocess() {} };
    const discontinuous = harness({ processor: discontinuousProcessor });
    await discontinuous.clock.advance(1000);
    for (let callback = 0; callback < 4; callback++) {
      const samples = new Float32Array(480); samples.fill(callback < 2 ? 0 : 1);
      discontinuousProcessor.onaudioprocess({ outputBuffer: { duration: 0.01, length: 480, numberOfChannels: 1, getChannelData: () => samples } });
    }
    await discontinuous.clock.advance(1000);
    assert.ok(discontinuous.api.snapshot().audio.boundaryJumps > 0);
    discontinuous.api.stop();
  });

  test('long-task observer handles native entry lists and RAF gap', async () => {
    const h = harness();
    const firstFrame = [...h.rafCallbacks.values()][0];
    assert.equal(typeof firstFrame, 'function');
    firstFrame(10);
    [...h.rafCallbacks.values()].at(-1)(1210);
    const observer = h.observerInstances[0];
    assert.equal(observer.observed, true);
    observer.callback([{ duration: 1200 }]);
    const nativeEntryList = { getEntries: () => [{ duration: 1500 }] };
    assert.equal(nativeEntryList[Symbol.iterator], undefined);
    assert.doesNotThrow(() => observer.callback(nativeEntryList), 'collector should not throw and trigger windowerror');
    assert.equal(h.api.snapshot().runtime.errors, 0);
    await h.clock.advance(1000);
    assert.equal(h.api.snapshot().performance.longTasks, 2);
    assert.ok(h.api.snapshot().performance.longestTaskMs >= 1500);
    assert.ok(h.api.snapshot().performance.maxRafGapMs >= 1200);
    h.api.stop();
    assert.equal(observer.observed, false);
  });

  test('panel is accessible, closed keyboard events are not captured, and UI text is safe', async () => {
    const h = harness();
    const toggle = h.find('debug-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-controls'), 'debug-panel');
    assert.equal(h.find('debug-panel').hidden, true);
    assert.match(h.root.textContent, /General/);
    assert.match(h.root.textContent, /Audio/);
    assert.match(h.root.textContent, /Performance/);
    assert.match(h.root.textContent, /Connection/);
    assert.match(h.root.textContent, /Errors/);
    assert.match(h.root.textContent, /microphone|voice|record/i);
    toggle.click();
    assert.equal(h.find('debug-panel').hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    h.api.recordRuntimeError(Object.assign(new Error('<img src=x onerror=secret>'), { name: 'Other' }));
    assert.doesNotMatch(h.root.textContent, /<img|onerror|secret/);
    assert.doesNotMatch(h.root.textContent, /ticket-[A-Za-z0-9_-]+/i);
    h.api.stop();
  });

  test('visible privacy notice discloses the authentication ticket and relay sanitization', async () => {
    const h = harness();
    const notice = h.find('debug-privacy-notice').textContent;
    assert.match(notice, /session ticket is sent solely to authenticate delivery/i);
    assert.match(notice, /removed before the relay stores the sanitized report privately/i);
    assert.doesNotMatch(notice, /no credentials or tokens/i);
    assert.match(notice, /Discord OAuth credentials/i);
    assert.match(notice, /passwords/i);
    h.api.stop();
  });

  test('playing relay state is explicitly unknown rather than falsely connected or connecting', async () => {
    const h = harness();
    h.api.setNetworkState('unknown');
    h.api.setPhase('playing');
    assert.equal(h.api.snapshot().network.state, 'unknown');
    assert.match(h.find('debug-field-network-state').textContent, /Transport state unavailable/i);
    h.api.stop();
  });

  test('client diagnostics regressions run in the web-and-relay CI workflow', async () => {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'web-and-relay.yaml'), 'utf8');
    assert.match(workflow, /node web\/tests\/diagnostics-test\.cjs/);
  });

  test('optional browser APIs missing do not crash; stop removes observers, listeners and callbacks', async () => {
    const h = harness({ noObserver: true, noRaf: true, audioContext: false, processor: undefined });
    await h.clock.advance(2000);
    assert.doesNotThrow(() => h.api.snapshot());
    assert.ok(h.api.snapshot().audio);
    h.api.stop();
    assert.equal(h.clock.jobs.size, 0);
    assert.equal(h.windowListeners.size, 0);
    assert.equal(h.documentListeners.size, 0);
  });

  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok  ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(failed ? `FAIL ${failed}/${tests.length} diagnostics checks` : `PASS: ${tests.length} production diagnostics checks`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
