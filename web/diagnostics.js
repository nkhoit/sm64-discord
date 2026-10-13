const MAX_BODY_BYTES = 16 * 1024;
const HISTORY_LIMIT = 6;
const REPORT_INTERVAL_MS = 15000;
const SAMPLE_INTERVAL_MS = 1000;
const UPLOAD_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1500];
const PREF_KEY = 'sm64-debug-reporting';
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'RuntimeError']);
const CATEGORIES = ['audio', 'performance', 'network', 'runtime', 'other'];
const ENUMS = {
  phase: ['loading', 'playing', 'closed'],
  audioState: ['unavailable', 'suspended', 'running', 'closed', 'interrupted'],
  networkState: ['loading', 'connecting', 'connected', 'closed', 'offline', 'unknown'],
  errorName: ['none', ...ERROR_NAMES],
};

// This schema is the upload boundary. Collectors may only contribute these named fields.
const SAMPLE_SCHEMA = {
  uptimeMs: ['number', 0, 604800000],
  phase: ['enum', ENUMS.phase],
  visible: ['boolean'],
  game: {
    ticksPerSec: ['number', 0, 1000],
    framesPerSec: ['number', 0, 1000],
    worstTickMs: ['number', 0, 600000],
  },
  audio: {
    state: ['enum', ENUMS.audioState],
    sampleRate: ['number', 0, 384000],
    queueFrames: ['number', 0, 1000000],
    emptyDelta: ['integer', 0, 1000000],
    droppedDelta: ['integer', 0, 100000000],
    peak: ['number', 0, 32768],
    callbacks: ['integer', 0, 100000000],
    lateCallbacks: ['integer', 0, 100000000],
    maxCallbackGapMs: ['number', 0, 600000],
    sampledFrames: ['integer', 0, 100000000],
    clippedSamples: ['integer', 0, 100000000],
    boundaryJumps: ['integer', 0, 100000000],
  },
  performance: {
    longTasks: ['integer', 0, 1000000],
    longestTaskMs: ['number', 0, 600000],
    maxRafGapMs: ['number', 0, 600000],
  },
  network: {
    state: ['enum', ENUMS.networkState],
    closeCode: ['integer', 0, 4999],
    rejoins: ['integer', 0, 10000],
    uploadFailures: ['integer', 0, 10000],
  },
  runtime: {
    errors: ['integer', 0, 10000],
    lastError: ['enum', ENUMS.errorName],
  },
};

const FIELD_LABELS = {
  uptimeMs: 'Page uptime (ms)', phase: 'Activity phase', visible: 'Page visible',
  'game.ticksPerSec': 'Game ticks / second', 'game.framesPerSec': 'Drawn frames / second', 'game.worstTickMs': 'Worst observed tick (ms)',
  'audio.state': 'Audio context state', 'audio.sampleRate': 'Output sample rate (Hz)', 'audio.queueFrames': 'Queued frames',
  'audio.emptyDelta': 'Empty queue ticks (last sample)', 'audio.droppedDelta': 'Dropped frames (last sample)',
  'audio.peak': 'Game-produced peak', 'audio.callbacks': 'Audio callbacks', 'audio.lateCallbacks': 'Late callbacks observed',
  'audio.maxCallbackGapMs': 'Largest callback gap (ms)', 'audio.sampledFrames': 'Output frames sampled',
  'audio.clippedSamples': 'Near-full-scale samples', 'audio.boundaryJumps': 'Large sample-boundary jumps',
  'performance.longTasks': 'Long tasks observed', 'performance.longestTaskMs': 'Longest task (ms)',
  'performance.maxRafGapMs': 'Largest visible frame gap (ms)',
  'network.state': 'Transport state', 'network.closeCode': 'Relay close code', 'network.rejoins': 'Recent rejoins',
  'network.uploadFailures': 'Save upload failures', 'runtime.errors': 'Runtime error events', 'runtime.lastError': 'Last error class',
};

const GROUPS = [
  ['General', ['uptimeMs', 'phase', 'visible']],
  ['Audio', ['audio.state', 'audio.sampleRate', 'audio.queueFrames', 'audio.emptyDelta', 'audio.droppedDelta', 'audio.peak',
    'audio.callbacks', 'audio.lateCallbacks', 'audio.maxCallbackGapMs', 'audio.sampledFrames', 'audio.clippedSamples', 'audio.boundaryJumps']],
  ['Performance', ['game.ticksPerSec', 'game.framesPerSec', 'game.worstTickMs', 'performance.longTasks', 'performance.longestTaskMs', 'performance.maxRafGapMs']],
  ['Connection', ['network.state', 'network.closeCode', 'network.rejoins', 'network.uploadFailures']],
  ['Errors', ['runtime.errors', 'runtime.lastError']],
];

function finite(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) { return undefined; }
  const bounded = Math.min(max, Math.max(min, value));
  return integer ? Math.trunc(bounded) : bounded;
}

function safeField(rule, value) {
  if (rule[0] === 'boolean') { return typeof value === 'boolean' ? value : undefined; }
  if (rule[0] === 'enum') { return typeof value === 'string' && rule[1].includes(value) ? value : undefined; }
  return finite(value, rule[1], rule[2], rule[0] === 'integer');
}

function normalizeErrorClass(error) {
  let name = '';
  try {
    if (typeof error === 'string') { return 'Other'; }
    name = error?.name || error?.constructor?.name || '';
  } catch { return 'Other'; }
  return ERROR_NAMES.has(name) ? name : 'Other';
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

export function createDiagnostics(options = {}) {
  const root = options.root;
  const doc = options.document || globalThis.document;
  const win = options.window || globalThis.window;
  const Module = options.Module || globalThis.Module || {};
  const fetchFn = options.fetch || globalThis.fetch?.bind(globalThis);
  const base = typeof options.base === 'string' ? options.base : '';
  const storage = options.storage || (() => { try { return globalThis.localStorage; } catch { return null; } })();
  const now = options.now || (() => globalThis.performance?.now?.() ?? Date.now());
  const setTimeoutFn = options.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  const setIntervalFn = options.setInterval || globalThis.setInterval.bind(globalThis);
  const clearIntervalFn = options.clearInterval || globalThis.clearInterval.bind(globalThis);
  const AbortControllerCtor = options.AbortController || globalThis.AbortController;
  const Observer = Object.hasOwn(options, 'PerformanceObserver') ? options.PerformanceObserver : globalThis.PerformanceObserver;
  const requestFrame = options.requestAnimationFrame || win?.requestAnimationFrame?.bind(win);
  const cancelFrame = options.cancelAnimationFrame || win?.cancelAnimationFrame?.bind(win);
  const startedAt = now();
  const collectors = new Map();
  const listeners = [];
  const audioRecords = new Map();
  const audioMetrics = { callbacks: 0, lateCallbacks: 0, maxCallbackGapMs: 0, sampledFrames: 0, clippedSamples: 0, boundaryJumps: 0 };
  const performanceMetrics = { longTasks: 0, longestTaskMs: 0, maxRafGapMs: 0 };
  let lastStats = null;
  let priorCounters = null;
  let phase = 'loading';
  let networkState = 'loading';
  let closeCode;
  let rejoinCount = 0;
  let saveUploadFailures = 0;
  let runtimeErrors = 0;
  let lastError = 'none';
  let reportRuntimeErrors = 0;
  let reportLastError = 'none';
  let ticket = null;
  let serverEnabled = false;
  let reportingEnabled = readPreference();
  let sessionEnded = false;
  let lastPeriodicAt = startedAt;
  let errorTimer = null;
  let sampleTimer = null;
  let observer = null;
  let observerAvailable = false;
  let rafAvailable = typeof requestFrame === 'function';
  let rafId = null;
  let lastRafAt = null;
  let latestSample = initialSample();
  const history = [];
  let sequence = 0;
  let flight = null;
  let pendingManualIssue = null;
  let stopped = false;
  const ui = buildUi();

  function readPreference() {
    try { return storage?.getItem(PREF_KEY) !== 'false'; } catch { return true; }
  }

  function writePreference(value) {
    try { storage?.setItem(PREF_KEY, String(value)); } catch {}
  }

  function el(tag, id, text) {
    const node = doc?.createElement?.(tag);
    if (!node) { return null; }
    if (id) { node.id = id; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function buildUi() {
    if (!root || !doc?.createElement) { return {}; }
    root.textContent = '';
    const toggle = el('button', 'debug-toggle', 'Debug');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'debug-panel');
    const reportingControls = el('div', 'debug-reporting-controls');
    const reportingNotice = el('p', 'debug-reporting-notice', 'Technical diagnostics go automatically to the relay when reports are on; no recordings.');
    const reportingLabel = el('label', 'debug-reporting-label');
    const reporting = el('input', 'debug-reporting');
    reporting.type = 'checkbox';
    reporting.checked = reportingEnabled;
    reporting.setAttribute('aria-label', 'Allow automatic technical reports');
    const reportingText = el('span', null, `Automatic reports: ${reportingEnabled ? 'on' : 'off'}`);
    reportingLabel?.append(reporting, reportingText);
    reportingControls?.append(reportingNotice, reportingLabel);
    const panel = el('section', 'debug-panel');
    panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'debug-heading');
    const heading = el('h2', 'debug-heading', 'Technical debug panel');
    const notice = el('p', 'debug-privacy-notice',
      'Local metrics stay in this browser until a session is assigned. When reporting is enabled, automatic and manual reports send allowlisted technical counters and recent samples to the relay. A session ticket is sent solely to authenticate delivery and is removed before the relay stores the sanitized report privately. Reports do not include Discord OAuth credentials or passwords, microphone, voice, or game-audio recordings, ROM bytes, or free text. Output samples are inspected transiently and never stored. Audio indicators are observations, not a diagnosis or proof of the cause of static.');
    const uploadStatus = el('p', 'debug-upload-status', 'Reports are local until a session is assigned.');
    uploadStatus.setAttribute('role', 'status');
    uploadStatus.setAttribute('aria-live', 'polite');
    const groups = el('div', 'debug-groups');
    const fields = new Map();
    for (const [title, names] of GROUPS) {
      const section = el('section', `debug-group-${title.toLowerCase()}`);
      const subheading = el('h3', null, title);
      const list = el('dl', null);
      for (const key of names) {
        const id = `debug-field-${key.replaceAll('.', '-')}`;
        const dt = el('dt', null, FIELD_LABELS[key]);
        const dd = el('dd', id, '—');
        list?.append(dt, dd);
        fields.set(key, dd);
      }
      section?.append(subheading, list);
      groups?.append(section);
    }
    const reportsHeading = el('h3', null, 'Send a report');
    const reportsDescription = el('p', null, 'Choose a category; the report contains counters and recent samples only, with no free-text field.');
    const reports = el('div', 'debug-report-buttons');
    const buttons = new Map();
    for (const category of CATEGORIES) {
      const button = el('button', `debug-report-${category}`, `Report ${category} issue`);
      button.type = 'button';
      button.disabled = true;
      button.setAttribute('aria-label', `Send ${category} technical report`);
      reports?.append(button);
      buttons.set(category, button);
    }
    panel?.append(heading, notice, uploadStatus, groups, reportsHeading, reportsDescription, reports);
    root.append(toggle, reportingControls, panel);
    const stopEvent = (event) => event.stopPropagation?.();
    for (const eventName of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'touchstart', 'touchend', 'wheel']) {
      listen(root, eventName, stopEvent);
    }
    listen(toggle, 'click', () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
    });
    listen(reporting, 'change', () => {
      reportingEnabled = reporting.checked === true;
      reportingText.textContent = `Automatic reports: ${reportingEnabled ? 'on' : 'off'}`;
      writePreference(reportingEnabled);
      if (!reportingEnabled) { cancelFlight(); setUploadStatus('Automatic reporting is off. Local diagnostics remain available.'); }
      else if (!serverEnabled) { setUploadStatus('Server reporting is disabled; local diagnostics remain available.'); }
      else { setUploadStatus('Reporting is enabled for this tab; reports begin after session assignment.'); }
      refreshControls();
    });
    for (const [category, button] of buttons) {
      listen(button, 'click', () => { void sendReport('issue', category); });
    }
    return { toggle, panel, reporting, uploadStatus, fields, buttons };
  }

  function listen(target, type, handler) {
    if (!target?.addEventListener) { return; }
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener?.(type, handler));
  }

  function setUploadStatus(text) {
    if (ui.uploadStatus) { ui.uploadStatus.textContent = text; }
  }

  function canSend() {
    return !stopped && !sessionEnded && serverEnabled && reportingEnabled && typeof ticket === 'string' && ticket.length > 0 && typeof fetchFn === 'function';
  }

  function refreshControls() {
    if (ui.reporting) {
      ui.reporting.checked = reportingEnabled;
      ui.reporting.setAttribute('aria-describedby', 'debug-upload-status');
    }
    for (const button of ui.buttons?.values?.() || []) { button.disabled = !canSend(); }
  }

  function initialSample() {
    return { uptimeMs: 0, phase, visible: doc?.visibilityState !== 'hidden',
      audio: { state: 'unavailable', callbacks: 0, lateCallbacks: 0, maxCallbackGapMs: 0, sampledFrames: 0, clippedSamples: 0, boundaryJumps: 0 },
      network: { state: networkState, rejoins: 0, uploadFailures: 0 },
      runtime: { errors: 0, lastError: 'none' } };
  }

  function registerCollector(section, collect) {
    if (!Object.hasOwn(SAMPLE_SCHEMA, section) || !SAMPLE_SCHEMA[section] || typeof SAMPLE_SCHEMA[section] !== 'object' || Array.isArray(SAMPLE_SCHEMA[section])) {
      throw new TypeError('collector section is not in the diagnostics schema');
    }
    if (typeof collect !== 'function') { throw new TypeError('collector must be a function'); }
    if (!collectors.has(section)) { collectors.set(section, new Set()); }
    const bucket = collectors.get(section);
    if (bucket.size >= 8) { throw new RangeError('collector limit reached for this diagnostics section'); }
    bucket.add(collect);
    return () => bucket.delete(collect);
  }

  function collectSection(section, context) {
    const schema = SAMPLE_SCHEMA[section];
    const result = {};
    for (const collect of collectors.get(section) || []) {
      let candidate;
      try { candidate = collect(context); } catch { continue; }
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { continue; }
      for (const [key, rule] of Object.entries(schema)) {
        if (Object.hasOwn(result, key) || !Object.hasOwn(candidate, key)) { continue; }
        const value = safeField(rule, candidate[key]);
        if (value !== undefined) { result[key] = value; }
      }
    }
    return result;
  }

  function statsNumber(stats, key, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return finite(stats?.[key], min, max);
  }

  function counterDelta(current, prior, max) {
    const safeCurrent = finite(current, 0, max, true);
    if (safeCurrent === undefined) { return 0; }
    if (prior === undefined || prior === null) { return 0; }
    return safeCurrent >= prior ? safeCurrent - prior : safeCurrent;
  }

  function sampleStats() {
    try {
      if (typeof Module._web_debug_stats !== 'function' || typeof Module.UTF8ToString !== 'function') { return; }
      const json = Module.UTF8ToString(Module._web_debug_stats());
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return; }
      const time = now();
      const ticks = statsNumber(parsed, 'ticks');
      const frames = statsNumber(parsed, 'frames');
      const empty = finite(parsed.audioEmpty, 0, 100000000, true);
      const dropped = finite(parsed.audioDropped, 0, 100000000, true);
      const elapsed = priorCounters ? Math.max(0.001, (time - priorCounters.at) / 1000) : 1;
      const game = {};
      if (priorCounters && ticks !== undefined && priorCounters.ticks !== undefined) {
        game.ticksPerSec = Math.max(0, ticks >= priorCounters.ticks ? ticks - priorCounters.ticks : ticks) / elapsed;
      } else { game.ticksPerSec = 0; }
      if (priorCounters && frames !== undefined && priorCounters.frames !== undefined) {
        game.framesPerSec = Math.max(0, frames >= priorCounters.frames ? frames - priorCounters.frames : frames) / elapsed;
      } else { game.framesPerSec = 0; }
      const worst = finite(parsed.worstTickMs, 0, 600000);
      if (worst !== undefined) { game.worstTickMs = worst; }
      const audio = {};
      if (empty !== undefined) { audio.emptyDelta = counterDelta(empty, priorCounters?.empty, 1000000); }
      if (dropped !== undefined) { audio.droppedDelta = counterDelta(dropped, priorCounters?.dropped, 100000000); }
      const queue = finite(parsed.audioQueued, 0, 1000000);
      if (queue !== undefined) { audio.queueFrames = queue; }
      const peak = finite(Math.abs(Number(parsed.audioPeak)), 0, 32768);
      if (peak !== undefined && Number.isFinite(peak)) { audio.peak = peak; }
      lastStats = { game, audio };
      priorCounters = { at: time, ticks, frames, empty, dropped };
    } catch {
      // The exported C stats are best-effort; malformed data must not affect the game.
    }
  }

  function audioContext() {
    try { return Module.SDL2?.audioContext || Module.SDL2?.audio?.context || null; } catch { return null; }
  }

  function audioState() {
    const context = audioContext();
    if (!context) { return 'unavailable'; }
    try {
      const state = context.state;
      return ENUMS.audioState.includes(state) ? state : 'unavailable';
    } catch { return 'unavailable'; }
  }

  function saturatingIncrement(target, field, max, amount = 1) {
    target[field] = Math.min(max, target[field] + amount);
  }

  function compareAudioBoundary(event, state) {
    const buffer = event?.outputBuffer;
    if (doc?.visibilityState === 'hidden' || audioState() !== 'running' || !buffer) {
      state.boundaries = undefined; state.boundaryShape = undefined;
      return;
    }
    try {
      const length = finite(buffer.length, 0, 1000000, true);
      const channels = finite(buffer.numberOfChannels, 0, 32, true);
      if (!length || !channels || typeof buffer.getChannelData !== 'function') { throw new Error('audio boundary unavailable'); }
      const selectedChannels = Math.min(2, channels);
      const starts = [];
      const ends = [];
      const shapes = [];
      for (let channel = 0; channel < selectedChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        const count = Math.min(length, Number(samples?.length) || 0);
        if (!count) { throw new Error('audio channel unavailable'); }
        const first = Number(samples[0]);
        const last = Number(samples[count - 1]);
        if (!Number.isFinite(first) || !Number.isFinite(last)) { throw new Error('audio endpoint unavailable'); }
        starts.push(first); ends.push(last); shapes.push(count);
      }
      const shape = `${channels}:${length}:${shapes.join(',')}`;
      if (state.boundaryShape === shape && state.boundaries?.length === starts.length) {
        for (let channel = 0; channel < starts.length; channel++) {
          if (Math.abs(starts[channel] - state.boundaries[channel]) >= 0.75) {
            saturatingIncrement(audioMetrics, 'boundaryJumps', 100000000);
          }
        }
      }
      state.boundaries = ends;
      state.boundaryShape = shape;
    } catch {
      state.boundaries = undefined; state.boundaryShape = undefined;
    }
  }

  function monitorAudioCallback(event) {
    const current = now();
    const buffer = event?.outputBuffer;
    let duration = finite(buffer?.duration * 1000, 0, 600000);
    if (duration === undefined) {
      const length = finite(buffer?.length, 0, 1000000);
      const rate = finite(buffer?.sampleRate || audioContext()?.sampleRate, 0, 384000);
      if (length !== undefined && rate > 0) { duration = length * 1000 / rate; }
    }
    if (this.lastAt !== undefined && doc?.visibilityState !== 'hidden') {
      const gap = finite(current - this.lastAt, 0, 600000);
      if (gap !== undefined) {
        audioMetrics.maxCallbackGapMs = Math.max(audioMetrics.maxCallbackGapMs, gap);
        if (duration > 0 && gap > duration * 1.5 + 2) { saturatingIncrement(audioMetrics, 'lateCallbacks', 100000000); }
      }
    }
    this.lastAt = current;
    saturatingIncrement(audioMetrics, 'callbacks', 100000000);
    this.sampleCounter = (this.sampleCounter + 1) % 8;
    compareAudioBoundary(event, this);
    if (this.sampleCounter !== 0 || !buffer) { return; }
    try {
      const length = finite(buffer.length, 0, 1000000, true);
      const channels = finite(buffer.numberOfChannels, 0, 32, true);
      if (!length || !channels || typeof buffer.getChannelData !== 'function') { return; }
      const frameCount = Math.min(256, length);
      const selectedChannels = Math.min(2, channels);
      let sampledChannels = 0;
      let clipped = 0;
      for (let channel = 0; channel < selectedChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        if (!samples || typeof samples.length !== 'number') { continue; }
        const count = Math.min(frameCount, samples.length);
        if (!count) { continue; }
        sampledChannels++;
        for (let index = 0; index < count; index++) {
          const sample = Number(samples[index]);
          if (Number.isFinite(sample)) {
            if (Math.abs(sample) >= 0.999) { clipped++; }
          }
        }
      }
      if (sampledChannels) {
        saturatingIncrement(audioMetrics, 'sampledFrames', 100000000, frameCount);
        saturatingIncrement(audioMetrics, 'clippedSamples', 100000000, clipped);
      }
    } catch {
      // A browser callback's transient AudioBuffer is never retained or allowed to affect playback.
    }
  }

  function wrapAudioCallback() {
    let node;
    try { node = Module.SDL2?.audio?.scriptProcessorNode; } catch { return; }
    if (!node || typeof node.onaudioprocess !== 'function') { return; }
    let record = audioRecords.get(node);
    if (record?.wrapper === node.onaudioprocess) { return; }
    const original = node.onaudioprocess;
    const metricState = { lastAt: undefined, sampleCounter: 0, boundaries: undefined };
    const wrapper = function (...args) {
      let result;
      try { result = original.apply(this, args); }
      catch (error) {
        metricState.boundaries = undefined; metricState.boundaryShape = undefined;
        try { monitorAudioCallback.call(metricState, args[0]); } catch {}
        throw error;
      }
      try { monitorAudioCallback.call(metricState, args[0]); } catch {}
      return result;
    };
    record = { original, wrapper, metricState };
    audioRecords.set(node, record);
    try { node.onaudioprocess = wrapper; } catch {}
  }

  function readNetwork() {
    return { state: networkState, ...(closeCode === undefined ? {} : { closeCode }), rejoins: rejoinCount, uploadFailures: saveUploadFailures };
  }

  function buildSample() {
    const raw = {
      uptimeMs: Math.min(604800000, Math.max(0, now() - startedAt)),
      phase,
      visible: doc?.visibilityState !== 'hidden',
      game: lastStats?.game || {},
      audio: {
        state: audioState(),
        sampleRate: finite(audioContext()?.sampleRate, 0, 384000) ?? 0,
        ...(lastStats?.audio || {}),
        ...audioMetrics,
      },
      performance: {
        ...(observerAvailable ? { longTasks: performanceMetrics.longTasks, longestTaskMs: performanceMetrics.longestTaskMs } : {}),
        ...(rafAvailable ? { maxRafGapMs: performanceMetrics.maxRafGapMs } : {}),
      },
      network: readNetwork(),
      runtime: { errors: runtimeErrors, lastError },
    };
    // Run every contribution through the fixed wire schema, independent of collector contents.
    const result = {};
    for (const [key, rule] of Object.entries(SAMPLE_SCHEMA)) {
      if (!Array.isArray(rule)) { continue; }
      const value = safeField(rule, raw[key]);
      if (value !== undefined) { result[key] = value; }
    }
    for (const section of ['game', 'audio', 'performance', 'network', 'runtime']) {
      const ruleSet = SAMPLE_SCHEMA[section];
      const merged = {};
      const baseValues = raw[section] || {};
      for (const [field, rule] of Object.entries(ruleSet)) {
        if (!Object.hasOwn(baseValues, field)) { continue; }
        const value = safeField(rule, baseValues[field]);
        if (value !== undefined) { merged[field] = value; }
      }
      for (const [field, value] of Object.entries(collectSection(section, { phase, visible: result.visible, now: now() }))) {
        if (!Object.hasOwn(merged, field)) { merged[field] = value; }
      }
      if (Object.keys(merged).length) { result[section] = merged; }
    }
    return result;
  }

  function renderSample(sample = latestSample) {
    for (const [key, node] of ui.fields || []) {
      let value = sample?.[key];
      if (key.includes('.')) { const [section, field] = key.split('.'); value = sample?.[section]?.[field]; }
      if (value === undefined) { node.textContent = 'Unavailable'; }
      else if (typeof value === 'boolean') { node.textContent = value ? 'Yes' : 'No'; }
      else if (typeof value === 'number') { node.textContent = Number.isInteger(value) ? String(value) : value.toFixed(1); }
      else if (key === 'network.state' && value === 'unknown') { node.textContent = 'Transport state unavailable'; }
      else { node.textContent = value; }
    }
    refreshControls();
  }

  function takeSample() {
    if (stopped) { return; }
    sampleStats();
    wrapAudioCallback();
    latestSample = buildSample();
    if (ticket) {
      const reportableSample = reportSample(latestSample);
      history.push(reportableSample);
      while (history.length > HISTORY_LIMIT) { history.shift(); }
    }
    renderSample(latestSample);
    if (phase === 'playing' && latestSample.visible && canSend() && now() - lastPeriodicAt >= REPORT_INTERVAL_MS) {
      lastPeriodicAt = now();
      void sendReport('periodic', 'other');
    }
  }

  function setupPerformance() {
    if (typeof Observer === 'function') {
      try {
        observer = new Observer((entries) => {
          let safeEntries = [];
          try {
            const source = typeof entries?.getEntries === 'function' ? entries.getEntries() : entries;
            if (source && typeof source[Symbol.iterator] === 'function') { safeEntries = Array.from(source); }
          } catch { safeEntries = []; }
          for (const entry of safeEntries) {
            const duration = finite(entry?.duration, 0, 600000);
            if (duration !== undefined) {
              saturatingIncrement(performanceMetrics, 'longTasks', 1000000);
              performanceMetrics.longestTaskMs = Math.max(performanceMetrics.longestTaskMs, duration);
            }
          }
          latestSample = buildSample(); renderSample(latestSample);
        });
        observer.observe({ entryTypes: ['longtask'] });
        observerAvailable = true;
      } catch { observer = null; observerAvailable = false; }
    }
    if (typeof requestFrame === 'function') {
      const onFrame = (timestamp) => {
        if (stopped) { return; }
        const current = finite(timestamp, 0, Number.MAX_SAFE_INTEGER) ?? now();
        if (doc?.visibilityState !== 'hidden' && lastRafAt !== null) {
          const gap = finite(current - lastRafAt, 0, 600000);
          if (gap !== undefined) { performanceMetrics.maxRafGapMs = Math.max(performanceMetrics.maxRafGapMs, gap); }
        }
        lastRafAt = current;
        try { rafId = requestFrame(onFrame); } catch { rafId = null; rafAvailable = false; }
      };
      try { rafId = requestFrame(onFrame); } catch { rafId = null; rafAvailable = false; }
    }
  }

  function onVisibilityChange() {
    lastRafAt = null;
    for (const record of audioRecords.values()) {
      record.metricState.lastAt = undefined;
      record.metricState.boundaries = undefined;
      record.metricState.boundaryShape = undefined;
    }
    lastPeriodicAt = now();
    latestSample = buildSample(); renderSample(latestSample);
  }

  function onRuntimeError(event) {
    let error;
    try { error = event?.error; } catch { error = null; }
    recordRuntimeError(error);
  }

  function onUnhandledRejection(event) {
    let reason;
    try { reason = event?.reason; } catch { reason = null; }
    recordRuntimeError(reason);
  }

  function recordRuntimeError(error) {
    if (stopped) { return; }
    runtimeErrors = Math.min(10000, runtimeErrors + 1);
    lastError = normalizeErrorClass(error);
    if (canSend()) {
      reportRuntimeErrors = Math.min(10000, reportRuntimeErrors + 1);
      reportLastError = lastError;
    }
    latestSample = buildSample(); renderSample(latestSample);
    if (canSend()) {
      if (errorTimer !== null) { return; }
      errorTimer = setTimeoutFn(() => {
        errorTimer = null;
        if (canSend()) { void sendReport('error', 'runtime'); }
      }, 750);
    }
  }

  function payloadBody(kind, category, captured) {
    sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
    const safeCurrent = captured ? cloneJson(captured.sample) : reportSample(latestSample || buildSample());
    const safeHistory = captured ? captured.history.map(cloneJson) : history.slice(-HISTORY_LIMIT).map(cloneJson);
    const bodyObject = { ticket, version: 1, kind, category, seq: sequence, sample: safeCurrent, history: safeHistory };
    let body = JSON.stringify(bodyObject);
    while (bodyBytes(body) > MAX_BODY_BYTES && bodyObject.history.length) {
      bodyObject.history.shift();
      body = JSON.stringify(bodyObject);
    }
    return bodyBytes(body) <= MAX_BODY_BYTES ? body : null;
  }

  function reportSample(sample) {
    const result = cloneJson(sample);
    if (result.runtime) {
      result.runtime.errors = reportRuntimeErrors;
      result.runtime.lastError = reportLastError;
    }
    return result;
  }

  function captureIssueSnapshot() {
    return { sample: reportSample(latestSample || buildSample()), history: history.slice(-HISTORY_LIMIT).map(cloneJson) };
  }

  function bodyBytes(body) {
    try { return new TextEncoder().encode(body).length; }
    catch { return unescape(encodeURIComponent(body)).length; }
  }

  function cancelPendingManualIssue() {
    if (!pendingManualIssue) { return; }
    const pending = pendingManualIssue;
    pendingManualIssue = null;
    pending.resolve(false);
  }

  function cancelFlight() {
    cancelPendingManualIssue();
    if (!flight) { return; }
    flight.cancelled = true;
    try { flight.controller?.abort(); } catch {}
    flight.cancelResolve?.({ cancelled: true });
    if (flight.timeout !== null) { clearTimeoutFn(flight.timeout); flight.timeout = null; }
    if (flight.retryTimer !== null) {
      clearTimeoutFn(flight.retryTimer); flight.retryTimer = null;
      flight.retryResolve?.(false); flight.retryResolve = null;
    }
  }

  async function waitRetry(currentFlight, delay) {
    if (currentFlight.cancelled) { return false; }
    return new Promise((resolve) => {
      currentFlight.retryResolve = resolve;
      currentFlight.retryTimer = setTimeoutFn(() => {
        currentFlight.retryTimer = null; currentFlight.retryResolve = null;
        resolve(!currentFlight.cancelled);
      }, delay);
    });
  }

  async function sendReport(kind, category, capturedSnapshot = null) {
    if (!canSend() || !CATEGORIES.includes(category) || !['periodic', 'issue', 'error'].includes(kind)) { return false; }
    if (flight) {
      if (kind !== 'issue') { return flight.promise; }
      const snapshot = captureIssueSnapshot();
      return new Promise((resolve) => {
        const replaced = pendingManualIssue !== null;
        cancelPendingManualIssue();
        pendingManualIssue = { category, snapshot, resolve };
        setUploadStatus(replaced
          ? `A newer ${category} issue report is queued; the previous queued issue was replaced.`
          : `${category} issue report queued; it will send after the current report.`);
      });
    }
    const captured = capturedSnapshot || (kind === 'issue' ? captureIssueSnapshot() : null);
    const body = payloadBody(kind, category, captured);
    if (!body) { setUploadStatus('Report is too large to send safely.'); return false; }
    const currentFlight = { cancelled: false, controller: null, timeout: null, retryTimer: null, retryResolve: null, cancelResolve: null, cancelPromise: null, promise: null };
    currentFlight.cancelPromise = new Promise((resolve) => { currentFlight.cancelResolve = resolve; });
    flight = currentFlight;
    const operation = async () => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (currentFlight.cancelled || !canSend()) { return false; }
        let timedOut = false;
        let controller = null;
        try { if (typeof AbortControllerCtor === 'function') { controller = new AbortControllerCtor(); } } catch {}
        currentFlight.controller = controller;
        setUploadStatus(attempt ? 'Relay busy; retrying technical report.' : 'Sending technical report…');
        let rejectTimeout;
        const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
        currentFlight.timeout = setTimeoutFn(() => {
          timedOut = true;
          try { controller?.abort(); } catch {}
          rejectTimeout(new Error('request timeout'));
        }, UPLOAD_TIMEOUT_MS);
        let response;
        try {
          const request = Promise.resolve().then(() => fetchFn(`${base}/api/diagnostics`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
            ...(controller ? { signal: controller.signal } : {}),
          }));
          response = await Promise.race([request, timeoutPromise, currentFlight.cancelPromise]);
        } catch {
          if (currentFlight.timeout !== null) { clearTimeoutFn(currentFlight.timeout); currentFlight.timeout = null; }
          if (currentFlight.cancelled || !canSend()) { return false; }
          setUploadStatus(timedOut ? 'Report timed out; gameplay continues and nothing was queued.' : 'Report could not reach the relay; gameplay continues.');
          return false;
        }
        if (response?.cancelled || currentFlight.cancelled || !canSend()) {
          if (currentFlight.timeout !== null) { clearTimeoutFn(currentFlight.timeout); currentFlight.timeout = null; }
          return false;
        }
        if (response?.status === 202) {
          let data = {};
          try { data = await Promise.race([Promise.resolve().then(() => response.json()), timeoutPromise, currentFlight.cancelPromise]); }
          catch {
            if (currentFlight.timeout !== null) { clearTimeoutFn(currentFlight.timeout); currentFlight.timeout = null; }
            if (currentFlight.cancelled || !canSend()) { return false; }
            setUploadStatus(timedOut ? 'Report timed out; gameplay continues and nothing was queued.' : 'Relay response was incomplete; gameplay continues.');
            return false;
          }
          if (currentFlight.timeout !== null) { clearTimeoutFn(currentFlight.timeout); currentFlight.timeout = null; }
          if (data?.cancelled || currentFlight.cancelled || !canSend()) { return false; }
          if (data?.stored === true && typeof data.sessionId === 'string' && data.sessionId.length > 0 && data.sessionId.length <= 256) {
            setUploadStatus(`Report stored · session ${data.sessionId}`);
            return true;
          }
          setUploadStatus('Relay did not confirm that the report was stored.');
          return false;
        }
        if (currentFlight.timeout !== null) { clearTimeoutFn(currentFlight.timeout); currentFlight.timeout = null; }
        if (response?.status === 403) {
          cancelPendingManualIssue();
          ticket = null; sessionEnded = true;
          setUploadStatus('This session ticket expired; no further reports will be accepted.');
          refreshControls();
          return false;
        }
        if ((response?.status === 429 || response?.status === 503) && attempt < MAX_RETRIES) {
          if (!await waitRetry(currentFlight, RETRY_DELAYS_MS[attempt])) { return false; }
          continue;
        }
        setUploadStatus('Relay did not accept the report. Gameplay continues; reports are not queued.');
        return false;
      }
      setUploadStatus('Relay did not accept the report. Gameplay continues; reports are not queued.');
      return false;
    };
    currentFlight.promise = operation().catch(() => {
      if (!currentFlight.cancelled) { setUploadStatus('Report failed safely; gameplay continues.'); }
      return false;
    }).finally(() => {
      if (flight === currentFlight) { flight = null; }
      if (!stopped) { refreshControls(); flushPendingManualIssue(); }
    });
    return currentFlight.promise;
  }

  function flushPendingManualIssue() {
    if (!pendingManualIssue) { return; }
    const pending = pendingManualIssue;
    pendingManualIssue = null;
    if (!canSend()) { pending.resolve(false); return; }
    void sendReport('issue', pending.category, pending.snapshot).then(pending.resolve, () => pending.resolve(false));
  }

  function setServerEnabled(value) {
    serverEnabled = value === true;
    if (!serverEnabled) {
      cancelFlight();
      setUploadStatus('Server reporting is disabled; local diagnostics remain available.');
    } else if (ticket && reportingEnabled) { setUploadStatus('Reporting ready for this session.'); }
    refreshControls();
  }

  function setTicket(value) {
    if (typeof value !== 'string' || !value) {
      ticket = null;
      history.length = 0;
      reportRuntimeErrors = 0; reportLastError = 'none';
      cancelFlight(); refreshControls();
      return;
    }
    cancelFlight();
    ticket = value;
    sessionEnded = false;
    history.length = 0;
    reportRuntimeErrors = 0; reportLastError = 'none';
    latestSample = buildSample();
    renderSample(latestSample);
    lastPeriodicAt = now();
    refreshControls();
    if (canSend()) { setUploadStatus('Reporting ready for this session.'); }
  }

  function setPhase(value) {
    if (!ENUMS.phase.includes(value)) { return; }
    if (phase !== value && value === 'playing') { lastPeriodicAt = now(); }
    phase = value;
    latestSample = buildSample(); renderSample(latestSample);
  }

  function setNetworkState(value, code) {
    if (!ENUMS.networkState.includes(value)) { return; }
    networkState = value;
    if (value === 'closed') { sessionEnded = true; cancelFlight(); }
    if (value === 'offline' && !ticket) { setUploadStatus('Offline; reports remain local until a session is assigned.'); }
    const normalized = finite(code, 0, 4999, true);
    closeCode = value === 'closed' && normalized !== undefined ? normalized : undefined;
    latestSample = buildSample(); renderSample(latestSample);
  }

  function setRejoins(value) { rejoinCount = finite(value, 0, 10000, true) ?? rejoinCount; }
  function recordSaveUploadFailure() { saveUploadFailures = Math.min(10000, saveUploadFailures + 1); latestSample = buildSample(); renderSample(latestSample); }

  function stop() {
    if (stopped) { return; }
    stopped = true;
    cancelFlight();
    if (sampleTimer !== null) { clearIntervalFn(sampleTimer); sampleTimer = null; }
    if (errorTimer !== null) { clearTimeoutFn(errorTimer); errorTimer = null; }
    if (observer) { try { observer.disconnect(); } catch {} observer = null; }
    if (rafId !== null) { try { cancelFrame?.(rafId); } catch {} rafId = null; }
    for (const [node, record] of audioRecords) {
      try { if (node.onaudioprocess === record.wrapper) { node.onaudioprocess = record.original; } } catch {}
    }
    audioRecords.clear();
    for (const remove of listeners.splice(0)) { try { remove(); } catch {} }
    for (const [eventName, handler] of eventListeners) {
      try { win?.removeEventListener?.(eventName, handler); } catch {}
    }
    eventListeners.clear();
    try { doc?.removeEventListener?.('visibilitychange', onVisibilityChange); } catch {}
  }

  const eventListeners = new Map();
  for (const [name, callback] of [['error', onRuntimeError], ['unhandledrejection', onUnhandledRejection]]) {
    if (typeof win?.addEventListener === 'function') {
      try { win.addEventListener(name, callback); eventListeners.set(name, callback); } catch {}
    }
  }
  try { doc?.addEventListener?.('visibilitychange', onVisibilityChange); } catch {}
  setupPerformance();
  sampleTimer = setIntervalFn(takeSample, SAMPLE_INTERVAL_MS);
  renderSample(latestSample);

  return {
    setServerEnabled,
    setTicket,
    setPhase,
    setNetworkState,
    setRejoins,
    recordSaveUploadFailure,
    recordRuntimeError,
    registerCollector,
    snapshot: () => cloneJson(latestSample),
    sendReport,
    stop,
  };
}

export { SAMPLE_SCHEMA, normalizeErrorClass };
