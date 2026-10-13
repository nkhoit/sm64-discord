// Exercise authenticated diagnostic ingestion against isolated mock-Discord relays.
// Usage: node server/tests/diagnostics-runner.cjs [path/to/sm64-relay]
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '../..');
const relay = path.resolve(process.argv[2] || path.join(repo, 'server/build/sm64-relay'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sm64-diagnostics-run-'));
fs.chmodSync(scratch, 0o700);
const MEMBER_GUILD = '111111111111111111';
const OTHER_GUILD = '222222222222222222';
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok && !detail ? '' : detail ? ` (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
function start(command, args, env, logPath) {
  const child = spawn(command, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(logPath, { mode: 0o600 });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.once('close', () => log.end());
  return child;
}
async function connect(port, timeout = 500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(timeout);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(new Error('connect timeout')); });
  });
}
async function waitReady(port, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) { throw new Error(`relay exited before port ${port} became ready`); }
    try { await connect(port); return; } catch { await sleep(50); }
  }
  throw new Error(`port ${port} did not become ready`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) { return; }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    sleep(3000).then(() => { if (child.exitCode === null) { child.kill('SIGKILL'); } }),
  ]);
}
async function call(url, method, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
function sample() {
  return {
    uptimeMs: 1234.5, phase: 'playing', visible: true,
    game: { ticksPerSec: 30, framesPerSec: 60, worstTickMs: 12.25 },
    audio: { state: 'running', sampleRate: 48000, queueFrames: 256, emptyDelta: 1, droppedDelta: 0,
      peak: 22000, callbacks: 1200, lateCallbacks: 2, maxCallbackGapMs: 18.5, sampledFrames: 48000,
      clippedSamples: 0, boundaryJumps: 1 },
    performance: { longTasks: 0, longestTaskMs: 0, maxRafGapMs: 18 },
    network: { state: 'connected', closeCode: 0, rejoins: 0, uploadFailures: 0 },
    runtime: { errors: 0, lastError: 'none' },
  };
}
function maximumSample() {
  return {
    uptimeMs: 604800000, phase: 'closed', visible: false,
    game: { ticksPerSec: 1000, framesPerSec: 1000, worstTickMs: 600000 },
    audio: { state: 'interrupted', sampleRate: 384000, queueFrames: 1000000, emptyDelta: 1000000,
      droppedDelta: 100000000, peak: 32768, callbacks: 100000000, lateCallbacks: 100000000,
      maxCallbackGapMs: 600000, sampledFrames: 100000000, clippedSamples: 100000000, boundaryJumps: 100000000 },
    performance: { longTasks: 1000000, longestTaskMs: 600000, maxRafGapMs: 600000 },
    network: { state: 'offline', closeCode: 4999, rejoins: 10000, uploadFailures: 10000 },
    runtime: { errors: 10000, lastError: 'Other' },
  };
}
const report = (ticket, seq = 1, kind = 'periodic') => ({
  ticket, version: 1, kind, category: 'audio', seq, sample: sample(),
});
function readJsonl(directory) {
  if (!fs.existsSync(directory)) { return []; }
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl'));
  return files.flatMap((name) => fs.readFileSync(path.join(directory, name), 'utf8').split('\n').filter(Boolean));
}
function websocketOpen(base, ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?ticket=${ticket}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket open timed out')); }, 3000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket failed')); }, { once: true });
  });
}

(async () => {
  const children = [];
  const ports = [];
  try {
    for (let i = 0; i < 4; i++) {
      const port = await reservePort();
      if (!ports.includes(port)) { ports.push(port); } else { i--; }
    }
    const [mockPort, enabledPort, disabledPort, failedStorePort] = ports;
    const baseEnv = { ...process.env };
    delete baseEnv.SM64_DIAGNOSTICS;
    const mock = start(process.env.PYTHON || 'python3', [path.join(repo, 'server/tests/mock_discord.py'), String(mockPort)],
                       baseEnv, path.join(scratch, 'mock.log'));
    children.push(mock);
    const shared = {
      ...baseEnv, DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'mock-secret',
      DISCORD_API_BASE: `http://127.0.0.1:${mockPort}`, DISCORD_GUILD_IDS: MEMBER_GUILD,
    };
    const www = path.join(scratch, 'www');
    fs.mkdirSync(www);
    const data = path.join(scratch, 'data');
    const enabled = start(relay, ['--port', String(enabledPort), '--www', www, '--data', data, '--allow-lan-test'],
                          shared, path.join(scratch, 'relay-enabled.log'));
    children.push(enabled);
    const disabled = start(relay, ['--port', String(disabledPort), '--www', www, '--data', path.join(scratch, 'disabled-data'), '--allow-lan-test'],
                           { ...shared, SM64_DIAGNOSTICS: '0' }, path.join(scratch, 'relay-disabled.log'));
    children.push(disabled);

    const failData = path.join(scratch, 'fail-data');
    fs.mkdirSync(failData);
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(failData, 'diagnostics'));
    const failedStore = start(relay, ['--port', String(failedStorePort), '--www', www, '--data', failData, '--allow-lan-test'],
                              shared, path.join(scratch, 'relay-failed-store.log'));
    children.push(failedStore);
    for (const [port, child] of [[mockPort, mock], [enabledPort, enabled], [disabledPort, disabled], [failedStorePort, failedStore]]) {
      await waitReady(port, child);
    }
    const base = `http://127.0.0.1:${enabledPort}`;
    const disabledBase = `http://127.0.0.1:${disabledPort}`;
    const failBase = `http://127.0.0.1:${failedStorePort}`;
    const session = async (url, body, headers = {}) => call(`${url}/.proxy/api/session`, 'POST', body, headers);
    const diagnostics = (url, body, headers = {}, proxy = false) =>
      call(`${url}/${proxy ? '.proxy/' : ''}api/diagnostics`, 'POST', body, headers);
    const createGuildTicket = async (url, user, guild = MEMBER_GUILD) => {
      const result = await session(url, { mode: 'discord', access_token: `token-${user}`, guild_id: guild });
      return result.status === 200 ? result.json : null;
    };

    const config = await call(`${base}/api/config`, 'GET');
    check('config advertises diagnostics enabled', config.status === 200 && config.json?.diagnostics === true);
    const disabledConfig = await call(`${disabledBase}/api/config`, 'GET');
    check('SM64_DIAGNOSTICS=0 disables diagnostics in config', disabledConfig.json?.diagnostics === false);

    const pendingHost = await createGuildTicket(base, 'alice');
    check('mock Discord creates an authenticated pending host ticket', !!pendingHost?.ticket && pendingHost.role === 'host');
    let first = null;
    if (pendingHost?.ticket) {
      first = await diagnostics(base, report(pendingHost.ticket, 1), {}, true);
      check('pending unexpired allowlisted host ticket stores through proxy route', first.status === 202
        && first.json?.stored === true && /^[a-f0-9]{32}$/.test(first.json?.sessionId || ''));
      const burst = [];
      for (let seq = 2; seq <= 5; seq++) { burst.push(await diagnostics(base, report(pendingHost.ticket, seq))); }
      check('per-ticket rate bucket allows burst of four and rejects the fifth report',
        burst.filter((r) => r.status === 202).length === 3 && burst.at(-1).status === 429);
    }

    const stale = await diagnostics(base, report('stale-ticket-0000000000000000'));
    check('stale or unknown ticket is forbidden without echoing the ticket',
      stale.status === 403 && !stale.text.includes('stale-ticket-0000000000000000'));

    if (pendingHost?.ticket) {
      const invalid = [
        [{ ...report(pendingHost.ticket, 10), role: 'client' }, 400, 'unknown top-level role is rejected'],
        [{ ...report(pendingHost.ticket, 10), ip: '203.0.113.2' }, 400, 'privacy-bearing IP field is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { ...sample(), deviceId: 'device' } }, 400, 'unknown sample device field is rejected'],
        [{ ...report(pendingHost.ticket, 10), version: 2 }, 400, 'unsupported schema version is rejected'],
        [{ ...report(pendingHost.ticket, 10), seq: Number.MAX_SAFE_INTEGER + 1 }, 400, 'sequence above JavaScript safe integer is rejected'],
        [{ ...report(pendingHost.ticket, 10), kind: 'debug' }, 400, 'wrong kind enum is rejected'],
        [{ ...report(pendingHost.ticket, 10), category: 'voice' }, 400, 'wrong category enum is rejected'],
        [{ ...report(pendingHost.ticket, 0) }, 400, 'zero sequence is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { uptimeMs: -1 } }, 400, 'out-of-range uptime is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { uptimeMs: 604800001 } }, 400, 'uptime above seven days is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { phase: 'paused' } }, 400, 'wrong phase enum is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { visible: 1 } }, 400, 'visibility must be boolean'],
        [{ ...report(pendingHost.ticket, 10), sample: { game: { ticksPerSec: 1001 } } }, 400, 'out-of-range game rate is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { game: { worstTickMs: 0.5, memoryBytes: 10 } } }, 400, 'unknown game field is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { audio: { state: 'crackling' } } }, 400, 'wrong audio state enum is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { audio: { peak: 32769 } } }, 400, 'out-of-range audio peak is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { audio: { queueFrames: 0.5 } } }, 400, 'integer audio counters reject fractions'],
        [{ ...report(pendingHost.ticket, 10), sample: { audio: { droppedDelta: 100000001 } } }, 400, 'out-of-range dropped counter is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { audio: { deviceId: 'private-device' } } }, 400, 'unknown audio device field is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { performance: { longTasks: 1000001 } } }, 400, 'out-of-range long-task counter is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { network: { closeCode: 5000 } } }, 400, 'out-of-range close code is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { network: { state: 'online' } } }, 400, 'wrong network state enum is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { runtime: { lastError: 'secret stack' } } }, 400, 'runtime strings outside the enum are rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: { runtime: { message: 'private error' } } }, 400, 'unknown runtime message field is rejected'],
        [{ ...report(pendingHost.ticket, 10), history: Array(7).fill(sample()) }, 400, 'history over six samples is rejected'],
        [{ ...report(pendingHost.ticket, 10), history: [{}] }, 400, 'empty history sample is rejected'],
        [{ ...report(pendingHost.ticket, 10), sample: {} }, 400, 'empty sample is rejected'],
      ];
      for (const [body, status, name] of invalid) {
        const response = await diagnostics(base, body);
        check(name, response.status === status && !response.text.includes(pendingHost.ticket));
      }
      const nan = await diagnostics(base, `{"ticket":"${pendingHost.ticket}","version":1,"kind":"error","category":"other","seq":10,"sample":{"uptimeMs":NaN}}`);
      check('non-JSON NaN is rejected', nan.status === 400);
      const huge = await diagnostics(base, `{"ticket":"${pendingHost.ticket}","version":1,"kind":"error","category":"other","seq":10,"sample":{"uptimeMs":1e9999}}`);
      check('overflowing exponent is rejected', huge.status === 400);
      const malformed = await diagnostics(base, '{broken');
      check('malformed JSON is rejected', malformed.status === 400);
      const oversized = await diagnostics(base, ' '.repeat(16 * 1024 + 1));
      check('request body over 16 KiB is rejected', oversized.status === 413);
    }

    const openHost = pendingHost?.ticket ? await websocketOpen(base, pendingHost.ticket) : null;
    const client = await createGuildTicket(base, 'bob');
    check('mock relay issues the second player a client ticket', !!client?.ticket && client.role === 'client');
    if (client?.ticket) {
      const clientReport = await diagnostics(base, report(client.ticket, 1, 'issue'));
      check('connected-room client ticket is accepted with server-derived client role',
        clientReport.status === 202 && clientReport.json?.stored === true);
      const maximum = { ticket: client.ticket, version: 1, kind: 'error', category: 'runtime',
        seq: Number.MAX_SAFE_INTEGER, sample: maximumSample(),
        history: [{ phase: 'loading' }, { visible: false }, { game: {} }, { audio: {} }, { network: {} }, { runtime: {} }] };
      const maximumAccepted = await diagnostics(base, maximum);
      check('inclusive schema maxima, JavaScript-safe sequence and six history samples are accepted',
        maximumAccepted.status === 202 && maximumAccepted.json?.stored === true
          && maximumAccepted.json?.sessionId === clientReport.json?.sessionId
          && clientReport.json?.sessionId !== first?.json?.sessionId);
    }
    const overloadTickets = [];
    for (let i = 0; i < 40; i++) {
      const issued = await session(base, { mode: 'lan', room: `diagnostics-overload-${i}`, name: 'test' });
      if (issued.status === 200 && issued.json?.ticket) { overloadTickets.push(issued.json.ticket); }
    }
    const overloadResponses = await Promise.all(overloadTickets.map((ticket) => diagnostics(base, report(ticket))));
    check('concurrent diagnostic wave receives only accepted or bounded unavailable responses',
      overloadTickets.length === 40 && overloadResponses.length === overloadTickets.length
        && overloadResponses.every((response) => response.status === 202 || response.status === 503));
    if (openHost) { openHost.close(); }

    const otherGuild = await createGuildTicket(base, 'dual', OTHER_GUILD);
    check('mock Discord creates ticket for a valid but non-allowlisted guild', !!otherGuild?.ticket);
    if (otherGuild?.ticket) {
      const denied = await diagnostics(base, report(otherGuild.ticket));
      check('production diagnostics refuses a guild outside DISCORD_GUILD_IDS', denied.status === 403);
    }

    const lan = await session(base, { mode: 'lan', room: 'diagnostics-lan', name: 'Private tester' });
    check('existing LAN mode issues an authenticated relay ticket', !!lan.json?.ticket);
    if (lan.json?.ticket) {
      const proxyDenied = await diagnostics(base, report(lan.json.ticket), { 'X-Forwarded-For': '203.0.113.4' });
      check('LAN diagnostics obey existing non-proxy policy', proxyDenied.status === 403);
      const lanAccepted = await diagnostics(base, report(lan.json.ticket), {}, true);
      check('legacy LAN ticket is accepted on the direct local network', lanAccepted.status === 202);
    }

    const disabledTicket = await createGuildTicket(disabledBase, 'disabled');
    const disabledPost = disabledTicket?.ticket ? await diagnostics(disabledBase, report(disabledTicket.ticket)) : null;
    check('disabled diagnostics endpoint fails closed with 503 and skips storage initialization',
      disabledPost?.status === 503 && !fs.existsSync(path.join(scratch, 'disabled-data', 'diagnostics')));
    const failedTicket = await createGuildTicket(failBase, 'storage-failure');
    const failedPost = failedTicket?.ticket ? await diagnostics(failBase, report(failedTicket.ticket)) : null;
    check('unsafe or unavailable storage fails gracefully without echoing the report',
      failedPost?.status === 503 && !failedPost.text.includes('storage-failure') && fs.readdirSync(outside).length === 0);

    const beforeGet = readJsonl(path.join(data, 'diagnostics')).length;
    const get = await call(`${base}/api/diagnostics`, 'GET');
    const getWithTicket = await call(`${base}/api/diagnostics?ticket=${pendingHost?.ticket || 'none'}`, 'GET');
    check('GET diagnostics is method-rejected and never reads or echoes telemetry', get.status === 405
      && getWithTicket.status === 405 && !getWithTicket.text.includes(pendingHost?.ticket || 'none')
      && readJsonl(path.join(data, 'diagnostics')).length === beforeGet);

    const directory = path.join(data, 'diagnostics');
    const lines = readJsonl(directory);
    const records = lines.map((line) => JSON.parse(line));
    const secretsAbsent = lines.every((line) => !line.includes('ticket') && !line.includes('token-')
      && !line.includes('access_token') && !line.includes('alice') && !line.includes('bob')
      && !line.includes('Private tester') && !line.includes('diagnostics-lan') && !line.includes('diagnostics-overload'));
    check('stored records omit raw tickets, OAuth tokens and player names', lines.length >= 6 && secretsAbsent);
    check('persisted envelope contains only receive time, pseudonymous ID, derived room/role and report',
      records.length > 0 && records.every((r) => JSON.stringify(Object.keys(r).sort())
        === JSON.stringify(['receivedAt', 'report', 'role', 'room', 'sessionId'].sort()) && r.report?.ticket === undefined));
    check('records persist UTC receipt, derived room/role, pseudonymous session and sanitized report',
      records.some((r) => /^\d{4}-\d\d-\d\dT.*Z$/.test(r.receivedAt || '')
        && r.room === `g${MEMBER_GUILD}` && r.role === 'host'
        && /^[a-f0-9]{32}$/.test(r.sessionId || '') && r.report?.category === 'audio'));
    check('server persists the client role from the client ticket, not the payload', records.some((r) => r.role === 'client'));
    const allTickets = [pendingHost?.ticket, client?.ticket, otherGuild?.ticket, lan.json?.ticket,
      disabledTicket?.ticket, failedTicket?.ticket, ...overloadTickets].filter(Boolean);
    const logFiles = ['relay-enabled.log', 'relay-disabled.log', 'relay-failed-store.log', 'mock.log'];
    const logs = logFiles.map((name) => fs.readFileSync(path.join(scratch, name), 'utf8')).join('\n');
    check('relay and mock logs do not contain raw tickets or OAuth bearer material',
      allTickets.every((ticket) => !logs.includes(ticket)) && !logs.includes('token-alice') && !logs.includes('token-bob'));
    const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl')) : [];
    const privateFiles = files.length > 0 && files.every((name) => (fs.statSync(path.join(directory, name)).mode & 0o777) === 0o600);
    check('persisted diagnostic files are owner-only', privateFiles
      && (fs.statSync(directory).mode & 0o777) === 0o700);

    if (files.length) {
      const firstFile = path.join(directory, files[0]);
      fs.appendFileSync(firstFile, '{malformed line\n');
      fs.appendFileSync(firstFile, `${'x'.repeat(70 * 1024)}\n`);
      fs.appendFileSync(firstFile, `${'['.repeat(1100)}0${']'.repeat(1100)}\n`);
      fs.appendFileSync(firstFile, `{"n":${'9'.repeat(5000)}}\n`);
      fs.appendFileSync(firstFile, `${JSON.stringify({
        receivedAt: new Date().toISOString(), sessionId: '0'.repeat(32),
        report: { category: [], kind: 'issue', sample: {} },
      })}\n`);
    }
    const cli = spawnSync('python3', [path.join(repo, 'server/tools/diagnostics-summary.py'), directory,
      '--last', '100', '--hours', '168'], { encoding: 'utf8' });
    check('owner CLI summarizes unique categories, sessions and audio indicators and skips malformed lines',
      cli.status === 0 && cli.stdout.includes('Categories (unique reports)') && cli.stdout.includes('Sessions')
        && cli.stdout.includes('Audio indicators') && cli.stdout.includes('malformed lines skipped: 5')
        && !cli.stdout.includes('token-') && !cli.stdout.includes('ticket'));
    const cliBounded = spawnSync('python3', [path.join(repo, 'server/tools/diagnostics-summary.py'), directory,
      '--last', '1', '--hours', '1'], { encoding: 'utf8' });
    check('owner CLI enforces a recent last-N/time-window summary',
      cliBounded.status === 0 && cliBounded.stdout.includes('1 unique recent report(s)') && cliBounded.stdout.includes('Audio indicators: 1 unique report sample(s)'));
    const cliUnbounded = spawnSync('python3', [path.join(repo, 'server/tools/diagnostics-summary.py'), directory,
      '--last', '1001'], { encoding: 'utf8' });
    check('owner CLI rejects an unbounded record request', cliUnbounded.status === 2);

    const failures = checks.filter((item) => !item.ok);
    console.log(`Diagnostics integration checks: ${checks.length - failures.length}/${checks.length}`);
    if (failures.length) { process.exitCode = 1; }
    else { console.log(`Private diagnostic test evidence: ${scratch}`); }
  } finally {
    for (const child of children.reverse()) { await stop(child); }
    for (const port of ports) {
      try { await connect(port, 150); throw new Error(`owned test port ${port} is still listening`); }
      catch (error) { if (error.message.includes('still listening')) { throw error; } }
    }
    if (process.env.DIAGNOSTICS_KEEP_TMP !== '1') { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
