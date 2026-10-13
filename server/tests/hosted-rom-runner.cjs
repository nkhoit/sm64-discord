// Start isolated mock Discord + hosted/unconfigured relays, run the synthetic hosted-ROM API suite, and clean up.
// Usage: node server/tests/hosted-rom-runner.cjs [path/to/sm64-relay]
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const repo = path.resolve(__dirname, '../..');
const relay = path.resolve(process.argv[2] || path.join(repo, 'server/build/sm64-relay'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sm64-hosted-rom-run-'));
const fixture = path.join(scratch, 'synthetic-hosted-rom.fixture');
const hostedSource = path.join(scratch, 'hosted-source.fixture');
const largeSource = path.join(scratch, 'synthetic-large-hosted-rom.fixture');
const hostedWww = path.join(scratch, 'www-hosted');
const emptyWww = path.join(scratch, 'www-empty');
const MEMBER_GUILD = '222222222222222222';
const RESOURCE_GUILD = '111111111111111111';
fs.mkdirSync(hostedWww);
fs.mkdirSync(emptyWww);
fs.writeFileSync(fixture, Buffer.concat([
  Buffer.from('SYNTHETIC TEST FIXTURE - NOT A GAME ROM\0', 'ascii'),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
]));
fs.copyFileSync(fixture, hostedSource);
fs.writeFileSync(path.join(hostedWww, 'public.js'), 'PUBLIC STATIC FALLBACK');
// These static aliases point at the configured source inode but have ordinary static extensions.
// The source name is replaced after relay startup below, leaving only these hard links to test the
// inode identity captured during startup.
fs.utimesSync(hostedSource, new Date(), new Date(Date.now() + 5000));
fs.linkSync(hostedSource, path.join(hostedWww, 'public.data'));
fs.linkSync(hostedSource, path.join(hostedWww, 'public.js.br'));
// The resource test uses a maximum-size synthetic fixture to exercise backpressure without game data.
fs.writeFileSync(largeSource, Buffer.alloc(32 * 1024 * 1024, 0x53));

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
  const log = fs.createWriteStream(logPath);
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
    if (child.exitCode !== null) { throw new Error(`process exited before port ${port} became ready (status ${child.exitCode})`); }
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
async function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repo, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

(async () => {
  const ports = [];
  while (ports.length < 5) {
    const port = await reservePort();
    if (!ports.includes(port)) { ports.push(port); }
  }
  const [mockPort, hostedPort, noLanPort, plainPort, resourcePort] = ports;
  const children = [];
  try {
    const baseEnv = { ...process.env };
    const mock = start(process.env.PYTHON || 'python3', [path.join(repo, 'server/tests/mock_discord.py'), String(mockPort)],
                       baseEnv, path.join(scratch, 'mock-discord.log'));
    children.push(mock);
    const discordEnv = {
      ...baseEnv,
      DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'mock-secret',
      DISCORD_API_BASE: `http://127.0.0.1:${mockPort}`,
      SM64_ROM_PATH: hostedSource, DISCORD_GUILD_IDS: MEMBER_GUILD,
    };
    const hosted = start(relay, ['--port', String(hostedPort), '--www', hostedWww, '--data', path.join(scratch, 'data-hosted'), '--allow-lan-test'],
                         discordEnv, path.join(scratch, 'relay-hosted-lan.log'));
    children.push(hosted);
    const noLan = start(relay, ['--port', String(noLanPort), '--www', emptyWww, '--data', path.join(scratch, 'data-no-lan')],
                        discordEnv, path.join(scratch, 'relay-hosted-no-lan.log'));
    children.push(noLan);
    const plainEnv = { ...baseEnv, DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'mock-secret',
                       DISCORD_API_BASE: `http://127.0.0.1:${mockPort}` };
    delete plainEnv.SM64_ROM_PATH;
    delete plainEnv.DISCORD_GUILD_IDS;
    const plain = start(relay, ['--port', String(plainPort), '--www', emptyWww, '--data', path.join(scratch, 'data-plain')],
                        plainEnv, path.join(scratch, 'relay-unconfigured.log'));
    children.push(plain);
    const resourceEnv = {
      ...baseEnv,
      DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'mock-secret',
      DISCORD_API_BASE: `http://127.0.0.1:${mockPort}`,
      SM64_ROM_PATH: largeSource, DISCORD_GUILD_IDS: RESOURCE_GUILD,
    };
    const resource = start(relay, ['--port', String(resourcePort), '--www', emptyWww, '--data', path.join(scratch, 'data-resource')],
                           resourceEnv, path.join(scratch, 'relay-resource.log'));
    children.push(resource);

    for (const [port, child] of [[mockPort, mock], [hostedPort, hosted], [noLanPort, noLan], [plainPort, plain], [resourcePort, resource]]) {
      await waitReady(port, child);
    }
    // Replace the configured pathname after startup. The relay must keep protecting the original
    // source inode cached in memory, not just its old filename.
    fs.unlinkSync(hostedSource);
    fs.writeFileSync(hostedSource, 'REPLACED SOURCE PATH');
    const failures = [];
    for (const [script, args] of [
      ['hosted-rom-test.cjs', [`http://127.0.0.1:${hostedPort}`, `http://127.0.0.1:${noLanPort}`,
        `http://127.0.0.1:${plainPort}`, fixture]],
      ['hosted-rom-resource-test.cjs', [`http://127.0.0.1:${resourcePort}`]],
    ]) {
      try { await run(process.execPath, [path.join(repo, 'server/tests', script), ...args], process.env); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) { throw new Error(failures.map((error) => error.message).join('; ')); }
    console.log(`Hosted ROM relay logs and synthetic fixture: ${scratch}`);
  } finally {
    for (const child of children.reverse()) { await stop(child); }
    for (const port of ports) {
      try { await connect(port, 150); throw new Error(`owned test port ${port} is still listening`); }
      catch (error) { if (error.message.includes('still listening')) { throw error; } }
    }
    if (process.env.HOSTED_ROM_KEEP_TMP !== '1') { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
