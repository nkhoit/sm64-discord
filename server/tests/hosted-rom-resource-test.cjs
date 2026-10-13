// Resource regression checks use only a maximum-size synthetic fixture and slow loopback readers.
// Usage: node server/tests/hosted-rom-resource-test.cjs <budget-relay-url>
const net = require('net');

const base = process.argv[2];
if (!base) { console.error('usage: node hosted-rom-resource-test.cjs <budget-relay-url>'); process.exit(2); }
const guild = '111111111111111111';
const fixtureBytes = 32 * 1024 * 1024;
const writeTimeoutMs = 30_000;
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`);
  if (!ok) { failures++; }
}
function pausedDownload(user) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/rom', base);
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.pause();
      const body = JSON.stringify({ mode: 'discord', access_token: `token-${user}`, guild_id: guild });
      socket.write(`POST /api/rom HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      resolve(socket);
    });
  });
}
async function requestStatus(user) {
  const response = await fetch(`${base}/api/rom`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'discord', access_token: `token-${user}`, guild_id: guild }),
  });
  const result = { status: response.status, contentLength: Number(response.headers.get('content-length') || 0) };
  if (response.body) { await response.body.cancel(); }
  return result;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const held = [];
  try {
    held.push(await pausedDownload('slow-a'));
    held.push(await pausedDownload('slow-b'));
    // Let the independent local mock membership checks finish and the writes fill the paused readers' receive windows.
    await sleep(500);
    const overloaded = await requestStatus('overload-c');
    check('two maximum-size stalled responses consume the 64 MiB aggregate budget and the next gets 503',
          overloaded.status === 503 && overloaded.contentLength < fixtureBytes,
          overloaded);

    const closed = held.map((socket) => socket.destroyed
      ? Promise.resolve()
      : new Promise((resolve) => socket.once('close', resolve)));
    for (const socket of held) { socket.destroy(); }
    await Promise.all(closed);
    await sleep(200);
    const afterDisconnect = await requestStatus('disconnect-recovery');
    check('disconnecting stalled readers releases their response leases',
          afterDisconnect.status === 200 && afterDisconnect.contentLength === fixtureBytes,
          afterDisconnect);

    held.length = 0;
    held.push(await pausedDownload('timeout-a'));
    held.push(await pausedDownload('timeout-b'));
    await sleep(writeTimeoutMs + 1000);
    const afterDeadline = await requestStatus('timeout-recovery');
    check('finite HTTP write deadline releases all stalled response leases',
          afterDeadline.status === 200 && afterDeadline.contentLength === fixtureBytes,
          afterDeadline);
  } finally {
    for (const socket of held) { socket.destroy(); }
  }
  console.log(failures ? `${failures} hosted ROM resource check(s) failed` : 'PASS: all hosted ROM resource checks');
  process.exitCode = failures ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
