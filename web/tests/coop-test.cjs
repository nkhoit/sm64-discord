// Two-player smoke test: opens a host tab and a guest tab against a running sm64-relay, walks the
// guest's Mario, and checks the host sees it move.
//
//   lan:      plain browser tabs, relay started with --allow-lan-test. Also drops the guest's
//             connection while the server seems unreachable, and checks the guest keeps retrying
//             and rejoins once it's back.
//   discord:  tabs pretend to be inside Discord (frame_id, a mocked Embedded App SDK) and the relay
//             talks to server/tests/mock_discord.py. Also checks that Discord's mobile app gets a
//             desktop-only message, and the server save round trip: the host uploads its save, a
//             third player joins, the host closes its tab, and the other two rejoin on their own,
//             one hosting with the uploaded save and the other joining it.
//
//   python3 server/tests/mock_discord.py 8199 &
//   DISCORD_CLIENT_ID=1 DISCORD_CLIENT_SECRET=mock-secret DISCORD_API_BASE=http://127.0.0.1:8199 \
//       server/build/sm64-relay --port 8124 --www build/us_web --data relay-data --allow-lan-test &
//   NODE_PATH=$(npm root -g) node web/tests/coop-test.cjs http://localhost:8124 baserom.us.z64 lan|discord [relay-data] [screenshot-dir]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { makeSave } = require('../../server/tests/save-fixture.cjs');

const [base, rom, mode = 'lan', dataDir, outDir] = process.argv.slice(2);
if (!base || !rom || !['lan', 'discord'].includes(mode) || (mode === 'discord' && !dataDir)) {
  console.error('usage: node coop-test.cjs <relay url> <rom path> lan|discord [relay data dir, for discord] [screenshot dir]');
  process.exit(2);
}

const GUILD = '111111111111111111';

// Stands in for @discord/embedded-app-sdk: the user and server come from the page's query string.
const MOCK_SDK = `
export class DiscordSDK {
  constructor(clientId) {
    const q = new URLSearchParams(location.search);
    this.clientId = clientId;
    this.platform = q.get('platform');
    this.guildId = q.get('mock_guild');
    const user = q.get('mock_user');
    this.commands = {
      authorize: async (args) => ({ code: 'code-' + user }),
      authenticate: async ({ access_token }) => ({ access_token, user: { username: user } }),
    };
  }
  async ready() {}
}
export function patchUrlMappings() {}
`;

async function newPage(browser, name) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] ${e.message}`));
  if (mode === 'discord') {
    await page.route('**/vendor/discord-sdk.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: MOCK_SDK }));
  }
  return { context, page };
}

const discordUrl = (user, platform = 'desktop') =>
  `${base}/index.html?frame_id=test&instance_id=test&platform=${platform}&mock_user=${user}&mock_guild=${GUILD}&args=--skip-intro`;

async function openTab(browser, name, user) {
  const { context, page } = await newPage(browser, name);
  let url;
  if (mode === 'discord') {
    url = discordUrl(user);
  } else {
    url = `${base}/index.html?room=coop-test&name=${user}&args=--skip-intro`;
  }
  await page.goto(url);
  await page.waitForFunction(
    () => !document.getElementById('rom-picker').hidden || document.getElementById('overlay').hidden,
    null, { timeout: 120000 });
  if (!(await page.locator('#rom-picker').isHidden())) { await page.setInputFiles('#rom-input', rom); }
  await page.waitForFunction(() => window.sessionInfo, null, { timeout: 120000 });
  return { context, page };
}

const savedBytes = (page) => page.evaluate(() => Array.from(Module.FS.readFile('/save/sm64_save_file.bin')));

const players = async (page) => JSON.parse(await page.evaluate(() => UTF8ToString(Module._web_debug_players())));
const guestPos = (state) => state.players.find((p) => p.global === 1)?.pos;
const info = (page) => page.evaluate(() => window.sessionInfo);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`);
  if (!ok) { failures++; }
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] });

  if (mode === 'discord') {
    // Discord's mobile app: a message, and the game isn't downloaded
    const mobile = await newPage(browser, 'mobile');
    const requested = [];
    mobile.page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    await mobile.page.goto(discordUrl('erin', 'mobile'));
    await mobile.page.waitForFunction(() => /desktop/.test(document.getElementById('status').textContent), null,
                                      { timeout: 10000 }).catch(() => {});
    const status = await mobile.page.locator('#status').textContent();
    check('Discord on mobile says the activity is desktop only', status === 'This activity only works on desktop for now.', status);
    check('...without downloading the game', !requested.some((p) => /sm64coopdx\.(js|wasm|data)$/.test(p)), requested);
    await mobile.context.close();
  }

  const host = await openTab(browser, 'host', 'alice');
  await host.page.waitForTimeout(15000);
  const guest = await openTab(browser, 'guest', 'bob');
  await guest.page.waitForTimeout(25000);

  const room = mode === 'discord' ? `g${GUILD}` : 'lan-coop-test';
  const hostInfo = await info(host.page), guestInfo = await info(guest.page);
  check('first player hosts', hostInfo.role === 'host' && hostInfo.room === room, hostInfo);
  check('second player joins as a client', guestInfo.role === 'client' && guestInfo.room === room, guestInfo);

  const before = await players(host.page);
  const names = before.players.map((p) => p.name).sort().join();
  check('players use their own names', names === (mode === 'discord' ? 'Alice,Bob' : 'alice,bob'), names);
  await guest.page.click('#canvas');
  await guest.page.keyboard.down('w');
  await guest.page.waitForTimeout(12000);
  await guest.page.keyboard.up('w');
  await guest.page.waitForTimeout(1500);
  const afterHost = await players(host.page);
  const afterGuest = await players(guest.page);
  console.log('host before:', JSON.stringify(before));
  console.log('host after: ', JSON.stringify(afterHost));
  console.log('guest after:', JSON.stringify(afterGuest));
  const start = guestPos(before), seenByHost = guestPos(afterHost), own = guestPos(afterGuest);
  check('host sees the guest move', before.players.length === 2 && start && seenByHost && own
        && (start[0] !== seenByHost[0] || start[2] !== seenByHost[2])
        && Math.hypot(seenByHost[0] - own[0], seenByHost[2] - own[2]) < 200, { start, seenByHost, own });

  if (outDir) {
    await host.page.screenshot({ path: `${outDir}/${mode}-host.png` });
    await guest.page.screenshot({ path: `${outDir}/${mode}-guest.png` });
  }

  if (mode === 'lan') {
    // The guest loses its connection while the server is unreachable: it must not reload into an
    // error page, but keep retrying, and rejoin once the server answers again.
    const outage = (route) => route.abort('connectionrefused');
    await guest.page.route(`${base}/**`, outage);
    await guest.page.evaluate(() => Module.onRelayClosed(1006, ''));
    await guest.page.waitForFunction(() => /reach the server/.test(document.getElementById('closed-reason').textContent),
                                     null, { timeout: 10000 }).catch(() => {});
    await guest.page.waitForTimeout(1000);
    const retrying = await guest.page.evaluate(() => [location.protocol, document.getElementById('closed-reason')?.textContent,
                                                      document.getElementById('countdown')?.textContent]);
    check('a dropped player keeps retrying while the server is unreachable', retrying[0] === 'http:'
          && /reach the server/.test(retrying[1]) && /Rejoining in/.test(retrying[2]), retrying);
    const reloaded = guest.page.waitForEvent('load', { timeout: 30000 }).then(() => true, () => false);
    await guest.page.unroute(`${base}/**`, outage);
    const didReload = await reloaded;
    await guest.page.waitForFunction(() => window.sessionInfo, null, { timeout: 120000 }).catch(() => {});
    const back = await info(guest.page);
    check('...and rejoins once it answers', didReload && back?.role === 'client' && back.rejoined, back);

    // A full world (the relay's answer is faked; api-test fills a real room) is explained, with a button.
    const late = await newPage(browser, 'late');
    await late.page.route('**/api/session', (route) => route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ full: true, error: 'This world is full (16 players). Try again when someone leaves.' }) }));
    await late.page.goto(`${base}/index.html?room=coop-test&name=late`);
    await late.page.waitForFunction(() => !document.getElementById('closed').hidden || !document.getElementById('rom-picker').hidden,
                                    null, { timeout: 60000 }).catch(() => {});
    if (!(await late.page.locator('#rom-picker').isHidden())) { await late.page.setInputFiles('#rom-input', rom); }
    await late.page.waitForFunction(() => !document.getElementById('closed').hidden, null, { timeout: 60000 }).catch(() => {});
    const full = await late.page.evaluate(() => [document.getElementById('closed-reason').textContent,
                                                 !document.getElementById('reload').hidden && !document.getElementById('closed').hidden]);
    check('a full world is explained, with a Rejoin button', /world is full/.test(full[0]) && full[1], full);
    await late.context.close();
  }

  if (mode === 'discord') {
    // The host's save change reaches the server within a few seconds...
    const marker = Array.from(makeSave(12345));
    await host.page.evaluate((bytes) => Module.FS.writeFile('/save/sm64_save_file.bin', new Uint8Array(bytes)), marker);
    await host.page.waitForTimeout(3000);
    const saveFile = path.join(dataDir, `g${GUILD}.bin`);
    const stored = fs.existsSync(saveFile) ? [...fs.readFileSync(saveFile)] : null;
    check('host uploads the save to the server', stored && stored.join() === marker.join(), stored?.length);

    // ...a third player joins...
    const third = await openTab(browser, 'third', 'dave');
    await third.page.waitForTimeout(20000);
    const thirdInfo = await info(third.page);
    check('a third player joins as a client', thirdInfo.role === 'client', thirdInfo);

    // ...the host closes the tab, and the other two rejoin by themselves: one hosts on the uploaded
    // save, the other waits for it and joins.
    const reloads = [guest, third].map(({ page }) => page.waitForEvent('load', { timeout: 60000 }).then(() => true, () => false));
    const closedAt = Date.now();
    await host.context.close();
    const reloaded = await Promise.all(reloads);
    check('the others reload on their own after the host leaves', reloaded.every(Boolean), reloaded);
    const sessions = [];
    for (const { page } of [guest, third]) {
      await page.waitForFunction(() => window.sessionInfo, null, { timeout: 120000 }).catch(() => {});
      sessions.push(await info(page));
    }
    console.log(`rejoined after ${((Date.now() - closedAt) / 1000).toFixed(1)} s:`, JSON.stringify(sessions));
    const newHostIndex = sessions.findIndex((s) => s?.role === 'host');
    const newHost = [guest, third][newHostIndex];
    check('one of them becomes the host, the other a client', newHost && sessions.every((s) => s?.rejoined)
          && sessions.filter((s) => s?.role === 'client').length === 1, sessions);
    if (newHost) {
      check('the new host loads the uploaded save', (await savedBytes(newHost.page)).join() === marker.join());
      await newHost.page.waitForFunction(() => JSON.parse(UTF8ToString(Module._web_debug_players())).players.length === 2,
                                         null, { timeout: 60000 }).catch(() => {});
      const rejoinedPlayers = await players(newHost.page);
      check('the other player joins the new host', rejoinedPlayers.players.map((p) => p.name).sort().join() === 'Bob,Dave',
            rejoinedPlayers);
    }

    // ...and when everyone has left, the next host (fresh browser storage) starts from it.
    await guest.context.close();
    await third.context.close();
    await new Promise((r) => setTimeout(r, 1000));
    const next = await openTab(browser, 'next host', 'carol');
    const nextInfo = await info(next.page);
    const loaded = await savedBytes(next.page);
    check('the next player hosts after everyone left', nextInfo.role === 'host', nextInfo);
    check('the next host loads the server save', loaded.join() === marker.join(), loaded.length);
  }

  await browser.close();
  console.log(failures ? `FAIL: ${failures} check(s) failed` : `PASS (${mode})`);
  process.exit(failures ? 1 : 0);
})();
