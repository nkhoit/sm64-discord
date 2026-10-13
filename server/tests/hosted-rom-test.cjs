// Integration checks for operator-configured ROM delivery. The fixture is synthetic and contains no ROM data.
// Usage: node server/tests/hosted-rom-test.cjs <hosted-lan-url> <hosted-no-lan-url> <unconfigured-url> <fixture>
const fs = require('fs');
const http = require('http');

const [hosted, hostedNoLan, unconfigured, fixturePath] = process.argv.slice(2);
if (![hosted, hostedNoLan, unconfigured, fixturePath].every(Boolean)) {
  console.error('usage: node hosted-rom-test.cjs <hosted-lan-url> <hosted-no-lan-url> <unconfigured-url> <fixture>');
  process.exit(2);
}
const fixture = fs.readFileSync(fixturePath);
const MEMBER_GUILD = '222222222222222222';
const OTHER_MEMBER_GUILD = '111111111111111111';
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`);
  if (!ok) { failures++; }
}
async function call(base, method, body, headers = {}, prefix = '') {
  const response = await fetch(`${base}${prefix}/api/rom`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}
function staticCall(base, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const request = http.request(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}
const discord = (access_token, guild_id = MEMBER_GUILD) => ({ mode: 'discord', access_token, guild_id });
const noFixture = (r) => !r.bytes.equals(fixture);

(async () => {
  const configured = await fetch(`${hosted}/api/config`).then((r) => r.json());
  check('config advertises hosted ROM when valid path and allowlist are configured', configured.hostedRom === true, configured);
  const notConfigured = await fetch(`${unconfigured}/api/config`).then((r) => r.json());
  check('config leaves hosted ROM off when no file is configured', notConfigured.hostedRom === false, notConfigured);

  // Static files other than the bootstrap need an asset session (LAN test mode is on for this relay).
  const assets = await fetch(`${hosted}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                       body: JSON.stringify({ mode: 'lan' }) }).then((r) => r.json());
  const s = `?s=${encodeURIComponent(assets.session || '')}`;
  const anonAlias = await staticCall(hosted, '/public.data');
  check('static hard-link alias without an asset session is 401 without bytes', anonAlias.status === 401 && noFixture(anonAlias),
        { status: anonAlias.status, bytes: anonAlias.bytes.length });
  const hardlinkAlias = await staticCall(hosted, '/public.data' + s);
  check('static hard-link alias (with an asset session) to original hosted ROM inode is denied after source pathname replacement',
        hardlinkAlias.status === 404 && noFixture(hardlinkAlias), { status: hardlinkAlias.status, bytes: hardlinkAlias.bytes.length });
  const compressedAlias = await staticCall(hosted, '/public.js' + s, { 'Accept-Encoding': 'br' });
  check('precompressed hard-link alias is skipped and the safe static base is served',
        compressedAlias.status === 200 && compressedAlias.bytes.equals(Buffer.from('PUBLIC STATIC FALLBACK'))
          && !compressedAlias.headers['content-encoding'],
        { status: compressedAlias.status, encoding: compressedAlias.headers['content-encoding'], bytes: compressedAlias.bytes.length });

  const wrongMethod = await call(hosted, 'GET');
  check('ROM endpoint rejects GET', wrongMethod.status === 405 && noFixture(wrongMethod), wrongMethod.status);
  const malformed = await call(hosted, 'POST', '{not-json');
  check('ROM endpoint rejects malformed JSON without bytes', malformed.status === 400 && noFixture(malformed), malformed.status);
  const missingIdentity = await call(hosted, 'POST', { mode: 'discord', guild_id: MEMBER_GUILD });
  check('ROM endpoint requires a token', missingIdentity.status === 400 && noFixture(missingIdentity), missingIdentity.status);
  const malformedGuild = await call(hosted, 'POST', { mode: 'discord', access_token: 'token-dual', guild_id: '../bad' });
  check('ROM endpoint rejects malformed guild IDs without bytes', malformedGuild.status === 400 && noFixture(malformedGuild), malformedGuild.status);
  const unsupportedMode = await call(hosted, 'POST', { mode: 'other', access_token: 'token-dual', guild_id: MEMBER_GUILD });
  check('ROM endpoint rejects unsupported modes without bytes', unsupportedMode.status === 400 && noFixture(unsupportedMode), unsupportedMode.status);
  const badToken = await call(hosted, 'POST', discord('garbage'));
  check('ROM endpoint rejects an invalid token without bytes', badToken.status === 403 && noFixture(badToken), badToken.status);
  const nonmember = await call(hosted, 'POST', discord('token-alice'));
  check('ROM endpoint rejects a nonmember without bytes', nonmember.status === 403 && noFixture(nonmember), nonmember.status);
  const disallowedMember = await call(hosted, 'POST', discord('token-dual', OTHER_MEMBER_GUILD));
  check('a verified member in a non-allowlisted guild receives no bytes', disallowedMember.status === 403 && noFixture(disallowedMember), disallowedMember.status);

  const allowed = await call(hosted, 'POST', discord('token-dual'));
  check('allowlisted member receives the exact configured bytes', allowed.status === 200 && allowed.bytes.equals(fixture),
        { status: allowed.status, bytes: allowed.bytes.length });
  check('ROM response is non-cacheable and treated as binary', allowed.headers.get('cache-control') === 'no-store'
        && allowed.headers.get('content-type') === 'application/octet-stream'
        && allowed.headers.get('x-content-type-options') === 'nosniff'
        && /attachment/.test(allowed.headers.get('content-disposition') || ''),
        Object.fromEntries(allowed.headers.entries()));
  const proxiedAllowed = await call(hosted, 'POST', discord('token-dual'), {}, '/.proxy');
  check('Discord /.proxy mapping returns the same bytes', proxiedAllowed.status === 200 && proxiedAllowed.bytes.equals(fixture), proxiedAllowed.status);
  const rateLimited = await call(hosted, 'POST', discord('token-dual'));
  check('hosted ROM repeats are rate-limited per Discord identity', rateLimited.status === 429 && noFixture(rateLimited), rateLimited.status);

  const lan = await call(hosted, 'POST', { mode: 'lan' });
  check('direct loopback LAN ROM access works only under the LAN-test flag', lan.status === 200 && lan.bytes.equals(fixture), lan.status);
  const lanViaProxy = await call(hosted, 'POST', { mode: 'lan' }, { 'X-Forwarded-For': '203.0.113.10' }, '/.proxy');
  check('LAN ROM access through a proxy is denied with no bytes', lanViaProxy.status === 403 && noFixture(lanViaProxy), lanViaProxy.status);
  const lanWithoutFlag = await call(hostedNoLan, 'POST', { mode: 'lan' });
  check('LAN ROM access is denied without --allow-lan-test', lanWithoutFlag.status === 403 && noFixture(lanWithoutFlag), lanWithoutFlag.status);
  const unavailable = await call(unconfigured, 'POST', discord('token-dual'));
  check('unconfigured relay never sends a fixture', unavailable.status === 404 && noFixture(unavailable), unavailable.status);

  console.log(failures ? `${failures} hosted ROM check(s) failed` : 'PASS: all hosted ROM checks');
  process.exit(failures ? 1 : 0);
})();
