// Startup validation tests for optional hosted-ROM configuration; every input is a synthetic fixture.
// Usage: node server/tests/hosted-rom-config-test.cjs <sm64-relay>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const binary = process.argv[2];
if (!binary) { console.error('usage: node hosted-rom-config-test.cjs <sm64-relay>'); process.exit(2); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm64-hosted-rom-config-'));
const www = path.join(root, 'www');
fs.mkdirSync(www);
const outside = path.join(root, 'synthetic.fixture');
fs.writeFileSync(outside, Buffer.from('SYNTHETIC TEST FIXTURE - NOT A GAME ROM'));
const allowlist = '222222222222222222';
let failures = 0;
function check(name, env, expected, extraArgs = []) {
  const childEnv = { ...process.env, DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'mock-secret',
    SM64_ROM_PATH: outside, DISCORD_GUILD_IDS: allowlist, ...env };
  for (const [key, value] of Object.entries(childEnv)) { if (value === null) { delete childEnv[key]; } }
  const result = spawnSync(binary, ['--port', '0', '--www', www, '--data', path.join(root, 'data'), ...extraArgs], {
    env: childEnv, encoding: 'utf8', timeout: 1500,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const ok = result.status === 1 && output.includes(expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` status=${result.status} ${JSON.stringify(output)}`}`);
  if (!ok) { failures++; }
}
check('hosted ROM refuses missing guild allowlist', { DISCORD_GUILD_IDS: '' }, 'DISCORD_GUILD_IDS');
check('hosted ROM refuses malformed guild allowlist', { DISCORD_GUILD_IDS: '123,not-a-snowflake' }, 'DISCORD_GUILD_IDS');
check('hosted ROM refuses missing file', { SM64_ROM_PATH: path.join(root, 'missing') }, 'SM64_ROM_PATH');
check('hosted ROM requires Discord credentials unless LAN test is explicit', { DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '' }, 'requires Discord credentials');
check('hosted ROM requires an absolute path', { SM64_ROM_PATH: 'synthetic.fixture' }, 'must be an absolute path');
check('hosted ROM refuses a directory', { SM64_ROM_PATH: root }, 'SM64_ROM_PATH');
const empty = path.join(root, 'empty.fixture');
fs.writeFileSync(empty, '');
check('hosted ROM refuses an empty file', { SM64_ROM_PATH: empty }, '32 MiB');
const large = path.join(root, 'oversized.fixture');
fs.writeFileSync(large, Buffer.alloc(32 * 1024 * 1024 + 1, 0x53));
check('hosted ROM refuses a file over the size bound', { SM64_ROM_PATH: large }, '32 MiB');
const inRoot = path.join(www, 'inside.data');
fs.writeFileSync(inRoot, Buffer.from('SYNTHETIC TEST FIXTURE - NOT A GAME ROM'));
check('hosted ROM refuses a file in the static tree', { SM64_ROM_PATH: inRoot }, 'outside the canonical --www tree');
const symlink = path.join(root, 'outside-link.fixture');
fs.symlinkSync(inRoot, symlink);
check('hosted ROM refuses an outside symlink that resolves inside the static tree', { SM64_ROM_PATH: symlink }, 'outside the canonical --www tree');
const insideAlias = path.join(www, 'rom-alias.data');
fs.symlinkSync(outside, insideAlias);
check('hosted ROM refuses a symlink inside the static tree that targets an outside file', { SM64_ROM_PATH: insideAlias }, 'outside the canonical --www tree');
function checkStarts(name, env, args) {
  const childEnv = { ...process.env, DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'mock-secret',
    DISCORD_GUILD_IDS: allowlist, ...env };
  for (const [key, value] of Object.entries(childEnv)) { if (value === null) { delete childEnv[key]; } }
  const result = spawnSync(binary, ['--port', '0', '--www', www, '--data', path.join(root, 'data'), ...args], {
    env: childEnv, encoding: 'utf8', timeout: 2000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const ok = output.includes('hosted ROM on') && !output.includes('configuration error');
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(output)}`}`);
  if (!ok) { failures++; }
}
checkStarts('CLI --rom path works when SM64_ROM_PATH is unset', { SM64_ROM_PATH: null, DISCORD_GUILD_IDS: '111111111111111111, 222222222222222222' }, ['--rom', outside]);
checkStarts('SM64_ROM_PATH takes precedence over --rom', { SM64_ROM_PATH: outside }, ['--rom', inRoot]);
console.log(failures ? `${failures} hosted ROM config check(s) failed` : 'PASS: all hosted ROM config checks');
fs.rmSync(root, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
