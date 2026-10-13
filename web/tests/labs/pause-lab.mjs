// Pause lab: the Activity's pause menu (no Server Settings / Stop Hosting / Disconnect, disconnect key off)
// and stock server settings whatever the saved config says (player limit included). Needs a
// WEB_TEST_HOOKS=1 build. See README.md here; run-labs.sh starts both relays.
// Usage: node pause-lab.mjs <hosted-ROM relay url> <LAN relay url> <rom> <out dir>
import { createRequire } from 'module';
import fs from 'fs';
// require() so a global or NODE_PATH install of playwright works, like the other web tests
const { chromium } = createRequire(import.meta.url)('playwright');
const [hosted, lan, rom, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const results = [];
const ok = (scn, n, c, d) => { results.push({ scn, n, ok: !!c, d }); console.log((c ? 'ok   ' : 'FAIL ') + `[${scn}] ${n}` + (d !== undefined ? ' — ' + JSON.stringify(d) : '')); };
const browser = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] });
const STOCK = { playerInteractions: 1, playerKnockbackStrength: 25, stayInLevelAfterStar: 0, bubbleDeath: 1, nametags: 1, pauseAnywhere: 0, pvpType: 0, bouncyLevelBounds: 0, skipIntro: 1, enablePlayerList: 1, enablePlayersInLevelDisplay: 1 };
const NONSTOCK = 'coop_player_interaction 2\nbubble_death false\ncoop_player_knockback_strength 60\ncoop_stay_in_level_after_star 1\ncoop_nametags false\ncoop_bouncy_bounds 1\npause_anywhere true\nplayer_pvp_mode 1\nskip_intro true\namount_of_players 2\n';
const isStock = (s) => Object.entries(STOCK).every(([k, v]) => s[k] === v);
const diff = (s) => Object.fromEntries(Object.entries(STOCK).filter(([k, v]) => s[k] !== v).map(([k, v]) => [k, { want: v, got: s[k] }]));

async function launch(ctx, base, room, name, { cfg = null, hostedNeeded = true, args = '--skip-intro' } = {}) {
  const p = await ctx.newPage(); const logs = []; p.on('console', m => logs.push(m.text()));
  if (cfg !== null) await p.addInitScript((cfg) => {
    const t = setInterval(() => { const M = window.Module; if (!M || !M.callMain || M.__w) return; M.__w = 1; clearInterval(t);
      const o = M.callMain; M.callMain = (a) => { M.FS.writeFile('/save/sm64config.txt', cfg); return o(a); }; }, 5);
  }, cfg);
  await p.goto(`${base}/index.html?room=${room}&name=${name}${args ? '&args=' + args : ''}`);
  await p.waitForFunction(() => !document.getElementById('rom-picker').hidden || document.getElementById('overlay').hidden, null, { timeout: 120000 });
  if (!(await p.locator('#rom-picker').isHidden())) { if (hostedNeeded) throw new Error('hosted relay showed the ROM picker'); await p.setInputFiles('#rom-input', rom); }
  await p.waitForFunction(() => window.sessionInfo, null, { timeout: 120000 });
  await p.waitForTimeout(12000);
  const ss = () => p.evaluate(() => JSON.parse(UTF8ToString(Module._web_debug_server_settings())));
  const pause = () => p.evaluate(() => JSON.parse(UTF8ToString(Module._web_debug_pause_buttons())));
  return { p, logs, ss, pause };
}
// hold keys for a few game ticks (30/s) so a quick down/up isn't missed between polls
const tap = async (S, key) => { await S.p.keyboard.down(key); await S.p.waitForTimeout(200); await S.p.keyboard.up(key); };
async function openPause(S) {
  await S.p.click('#canvas', { position: { x: 480, y: 270 } }).catch(() => {});
  for (let i = 0; i < 4; i++) {
    await S.p.waitForTimeout(1000);
    const b = await S.pause(); if (b) return b;
    // Start opens the vanilla pause screen; R there opens the DJUI pause menu
    // a config without controls_preset (like the seeded ones) counts as Classic: Start = Space, R = right Shift
    const c0 = await S.p.evaluate(() => JSON.parse(UTF8ToString(Module._web_debug_controls(-1))));
    const [startKey, rKey] = c0.preset === 1 ? ['KeyP', 'KeyR'] : ['Space', 'ShiftRight'];
    if (!c0.paused) { await tap(S, startKey); await S.p.waitForTimeout(1500); }
    await tap(S, rKey); await S.p.waitForTimeout(1500);
    const c = await S.pause(); if (c) return c;
    await S.p.screenshot({ path: `${out}/debug-open-${i}.png` });
  }
  return S.pause();
}
const FORBIDDEN = /Server Settings|Stop Hosting|Disconnect/i;
async function checkPause(S, scn, role) {
  const b = await openPause(S);
  await S.p.screenshot({ path: `${out}/${scn}-${role}-pause.png` });
  ok(scn, `${role} pause menu opens`, Array.isArray(b), b);
  if (!Array.isArray(b)) return;
  ok(scn, `${role} pause menu has no Server Settings / Stop Hosting / Disconnect`, !b.some(t => FORBIDDEN.test(t)), b);
  ok(scn, `${role} pause menu keeps Player, DynOS, Options, Resume`, ['Player', 'DynOS', 'Options', 'Resume'].every(w => b.some(t => t.includes(w))), b);
  ok(scn, `${role} default focus is Options`, b.some(t => t.startsWith('*') && t.includes('Options')), b);
  // the disconnect key (F12 by default) must not leave the session either
  const before = (await S.ss()).networkType;
  await tap(S, 'F12'); await S.p.waitForTimeout(1500);
  const after = (await S.ss()).networkType;
  ok(scn, `${role} disconnect key (F12) does nothing`, before !== 0 && after === before, { before, after });
  // Resume closes it; reopen once to make sure the menu still works after resume
  await S.p.keyboard.press('Escape'); await S.p.waitForTimeout(1200);
  const closed = await S.pause();
  await S.p.screenshot({ path: `${out}/${scn}-${role}-after-resume.png` });
  const again = await openPause(S);
  ok(scn, `${role} resume closes the menu and it reopens`, closed === null && Array.isArray(again), { closed, again });
  await S.p.keyboard.press('Escape'); await S.p.waitForTimeout(800);
}

// skipIntro is expected 1 in 1-2 only because the lab passes ?args=--skip-intro; scenario 3 checks 0 without it.
// 1. hosted mode: host with non-default stored settings, plus a guest
{
  const scn = 'hosted', room = `ph${Date.now()}`;
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await ctx.addInitScript((cfg) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1');
    localStorage.setItem('sm64.hostedSettings.v1', cfg); } }, NONSTOCK);
  const H = await launch(ctx, hosted, room, 'Host');
  let s = await H.ss(); fs.writeFileSync(`${out}/hosted-host-settings.json`, JSON.stringify(s, null, 2));
  ok(scn, 'host is the server', s.networkType === 1, s.networkType);
  ok(scn, 'host config really holds the non-default values', s.configPlayerInteraction === 2 && s.configBubbleDeath === 0, { configPlayerInteraction: s.configPlayerInteraction, configBubbleDeath: s.configBubbleDeath });
  ok(scn, 'host runs with stock server settings', isStock(s), diff(s));
  ok(scn, 'saved player limit of 2 is ignored: maxPlayers is 16', s.configAmountOfPlayers === 2 && s.maxPlayers === 16, { config: s.configAmountOfPlayers, maxPlayers: s.maxPlayers });
  const ctxG = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const G = await launch(ctxG, hosted, room, 'Guest');
  const g = await G.ss(); fs.writeFileSync(`${out}/hosted-guest-settings.json`, JSON.stringify(g, null, 2));
  ok(scn, 'guest is a client', g.networkType === 2, g.networkType);
  ok(scn, 'guest sees stock server settings', isStock(g), diff(g));
  ok(scn, 'guest sees maxPlayers 16', g.maxPlayers === 16, g.maxPlayers);
  await checkPause(H, scn, 'host');
  await checkPause(G, scn, 'guest');
  ok(scn, 'both still connected at the end', (await H.ss()).networkType === 1 && (await G.ss()).networkType === 2);
  await H.p.waitForTimeout(5500);
  const stored = await H.p.evaluate(() => localStorage.getItem('sm64.hostedSettings.v1') || '');
  fs.writeFileSync(`${out}/hosted-stored-config.txt`, stored);
  ok(scn, 'saved config keeps the user values (not overwritten)', /coop_player_interaction 2/.test(stored) && /bubble_death false/.test(stored), { len: stored.length });
  await ctxG.close(); await ctx.close();
}
// 2. LAN test mode: host whose config file has non-default values
{
  const scn = 'lan', room = `pl${Date.now()}`;
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const H = await launch(ctx, lan, room, 'Host', { cfg: NONSTOCK, hostedNeeded: false });
  const s = await H.ss(); fs.writeFileSync(`${out}/lan-host-settings.json`, JSON.stringify(s, null, 2));
  ok(scn, 'config file values loaded', s.configPlayerInteraction === 2 && s.configBubbleDeath === 0, s);
  ok(scn, 'host runs with stock server settings', s.networkType === 1 && isStock(s), diff(s));
  ok(scn, 'saved player limit of 2 is ignored: maxPlayers is 16', s.configAmountOfPlayers === 2 && s.maxPlayers === 16, { config: s.configAmountOfPlayers, maxPlayers: s.maxPlayers });
  await checkPause(H, scn, 'host');
  await ctx.close();
}
// 3. no --skip-intro: the config's skip_intro true must not apply either
{
  const scn = 'intro', room = `pi${Date.now()}`;
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const H = await launch(ctx, lan, room, 'Host', { cfg: NONSTOCK, hostedNeeded: false, args: '' });
  const s = await H.ss(); fs.writeFileSync(`${out}/intro-host-settings.json`, JSON.stringify(s, null, 2));
  ok(scn, 'without the test flag skipIntro is stock (0) despite skip_intro true in config', s.networkType === 1 && s.skipIntro === 0 && s.playerInteractions === 1 && s.bubbleDeath === 1, s);
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`${out}/pause-results.json`, JSON.stringify(results, null, 2));
const f = results.filter(r => !r.ok).length; console.log(f ? `FAILED ${f}/${results.length}` : `PASS ${results.length}/${results.length}`);
process.exitCode = f ? 1 : 0;
