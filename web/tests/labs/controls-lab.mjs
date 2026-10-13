// Controls lab: control presets, mouse+keyboard binds, pointer lock on pause/resume/chat/console, and how
// configs saved by older builds are read. One relay, a fresh browser context (= fresh /save) per scenario.
// Needs a WEB_TEST_HOOKS=1 build. See README.md here; run-labs.sh starts everything.
// Usage: node controls-lab.mjs <relay url> <rom> <out dir>
import { createRequire } from 'module';
import fs from 'fs';
// require() so a global or NODE_PATH install of playwright works, like the other web tests
const { chromium } = createRequire(import.meta.url)('playwright');
const [base, rom, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const BTN = { A: 0x8000, B: 0x4000, Z: 0x2000, START: 0x1000, DU: 0x0800, DD: 0x0400, DL: 0x0200, DR: 0x0100,
  Y: 0x0080, X: 0x0040, L: 0x0020, R: 0x0010, CU: 0x0008, CD: 0x0004, CL: 0x0002, CR: 0x0001 };
const probe = fs.readFileSync(new URL('./mkb-probe.lua', import.meta.url), 'utf8');
const results = [];
const ok = (scn, n, c, d) => { results.push({ scn, n, ok: !!c, d }); console.log((c ? 'ok   ' : 'FAIL ') + `[${scn}] ${n}` + (d !== undefined ? ' — ' + JSON.stringify(d) : '')); };
const browser = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] });

// classic defaults as written by the old build (3 slots per bind)
const OLD_CLASSIC = `key_a 0026 1000 1103 \nkey_b 0033 1001 1101 \nkey_x 0017 1002 ffff \nkey_y 0032 1003 ffff \nkey_start 0039 1006 ffff \nkey_l 002a 1009 1104 \nkey_r 0036 100a 101b \nkey_z 0025 1007 101a \nkey_cup 0148 ffff ffff \nkey_cdown 0150 ffff ffff \nkey_cleft 014b ffff ffff \nkey_cright 014d ffff ffff \nkey_stickup 0011 ffff ffff \nkey_stickdown 001f ffff ffff \nkey_stickleft 001e ffff ffff \nkey_stickright 0020 ffff ffff \nkey_chat 001c ffff ffff \nkey_playerlist 000f 1004 ffff \nkey_dup 0147 100b ffff \nkey_ddown 014f 100c ffff \nkey_dleft 0153 100d ffff \nkey_dright 0151 100e ffff \nkey_console 0029 003b ffff \nkey_prev 0016 ffff ffff \nkey_next 0018 ffff ffff \nkey_disconnect 0058 ffff ffff \nbettercam_enable false\n`;
const OLD_CUSTOM = OLD_CLASSIC.replace('key_a 0026 1000 1103', 'key_a 0024 1000 1103'); // J for jump

async function boot(scn, cfg) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await ctx.addInitScript(({ cfg, probe }) => {
    const t = setInterval(() => { const M = window.Module; if (!M || !M.callMain || M.__w) return; M.__w = 1; clearInterval(t);
      const o = M.callMain; M.callMain = (a) => { M.FS.mkdirTree('/save/mods');
        if (cfg !== null) M.FS.writeFile('/save/sm64config.txt', cfg);
        M.FS.writeFile('/save/mods/mkb-probe.lua', probe); return o([...a, '--enable-mod', 'mkb-probe.lua']); }; }, 5);
    document.addEventListener('pointerlockchange', () => console.log('POINTERLOCK ' + !!document.pointerLockElement));
  }, { cfg, probe });
  const p = await ctx.newPage(); const logs = [];
  p.on('console', m => logs.push(m.text()));
  await p.goto(`${base}/index.html?room=ctl${scn}${Date.now()}&name=Player&args=--skip-intro`);
  await p.waitForFunction(() => !document.getElementById('rom-picker').hidden || document.getElementById('overlay').hidden, null, { timeout: 120000 });
  if (!(await p.locator('#rom-picker').isHidden())) await p.setInputFiles('#rom-input', rom);
  await p.waitForFunction(() => window.sessionInfo, null, { timeout: 120000 });
  await p.waitForTimeout(12000);
  const S = {
    p, logs, ctx,
    ctl: (n = -1) => p.evaluate((n) => JSON.parse(UTF8ToString(Module._web_debug_controls(n))), n),
    file: (f = '/save/sm64config.txt') => p.evaluate((f) => Module.FS.readFile(f, { encoding: 'utf8' }), f),
    locked: () => p.evaluate(() => !!document.pointerLockElement),
    wants: () => p.evaluate(() => Module._web_controls_wants_pointer_lock()),
    last: () => { for (let i = logs.length - 1; i >= 0; i--) { const m = /MKB btn=([0-9a-f]+) sx=(-?\d+) sy=(-?\d+) yaw=(-?\d+)/.exec(logs[i]); if (m) return { btn: parseInt(m[1], 16), sx: +m[2], sy: +m[3], yaw: +m[4] }; } return null; },
    async key(key, want) {
      await p.keyboard.down(key); await p.waitForTimeout(250); const s = S.last(); await p.keyboard.up(key); await p.waitForTimeout(300);
      if (want.startsWith('stick')) { const v = want[5] === 'X' ? s.sx : s.sy; ok(scn, `${key} -> ${want}`, want[6] === '+' ? v > 40 : v < -40, { sx: s.sx, sy: s.sy }); }
      else ok(scn, `${key} -> ${want}`, (s.btn & BTN[want]) !== 0, { btn: s.btn.toString(16) });
    },
    async mouse(button, want) {
      await p.mouse.down({ button }); await p.waitForTimeout(250); const s = S.last(); await p.mouse.up({ button }); await p.waitForTimeout(300);
      ok(scn, `mouse ${button} -> ${want}`, (s.btn & BTN[want]) !== 0, { btn: s.btn.toString(16) });
    },
    async lock() { await p.click('#canvas', { position: { x: 480, y: 270 } }); for (let i = 0; i < 12; i++) { await p.waitForTimeout(250); if (await S.locked()) return true; } return false; },
  };
  return S;
}
const bindLines = (txt) => txt.split('\n').filter(l => l.startsWith('key_')).map(l => l.trim().split(/\s+/).slice(0, 5).join(' '));

const MKB_KEYS = [['KeyW', 'stickY+'], ['KeyS', 'stickY-'], ['KeyA', 'stickX-'], ['KeyD', 'stickX+'], ['Space', 'A'], ['KeyE', 'B'],
  ['ControlLeft', 'Z'], ['ShiftLeft', 'Z'], ['KeyQ', 'L'], ['KeyR', 'R'], ['KeyF', 'X'], ['KeyG', 'Y'],
  ['ArrowUp', 'CU'], ['ArrowDown', 'CD'], ['ArrowLeft', 'CL'], ['ArrowRight', 'CR'],
  ['Digit1', 'DU'], ['Digit2', 'DD'], ['Digit3', 'DL'], ['Digit4', 'DR'], ['Home', 'DU'], ['End', 'DD'], ['Delete', 'DL'], ['PageDown', 'DR']];
const CLASSIC_KEYS = [['KeyW', 'stickY+'], ['KeyS', 'stickY-'], ['KeyA', 'stickX-'], ['KeyD', 'stickX+'], ['KeyL', 'A'], ['Comma', 'B'],
  ['KeyK', 'Z'], ['KeyI', 'X'], ['KeyM', 'Y'], ['ShiftLeft', 'L'], ['ShiftRight', 'R'], ['ArrowUp', 'CU'], ['ArrowDown', 'CD'],
  ['ArrowLeft', 'CL'], ['ArrowRight', 'CR'], ['Home', 'DU'], ['End', 'DD'], ['Delete', 'DL'], ['PageDown', 'DR']];

// The game samples keys once per frame (30/s) and a Playwright press() is down+up within ~1 ms, so
// under CPU load a press can fall between two polls and be missed. Hold keys for a few frames, and
// wait for the state change instead of a fixed sleep.
const hold = async (S, key, ms = 200) => { await S.p.keyboard.down(key); await S.p.waitForTimeout(ms); await S.p.keyboard.up(key); };
const until = async (S, fn, ms = 4000) => { for (let t = 0; t < ms; t += 100) { if (await fn()) return true; await S.p.waitForTimeout(100); } return false; };
async function pausedCheck(S, scn, label, act, expectWants = 0) {
  await act(); await until(S, async () => !(await S.locked()) && (await S.wants()) === expectWants); await S.p.waitForTimeout(300);
  const st = { locked: await S.locked(), wants: await S.wants(), paused: (await S.ctl()).paused };
  await S.p.screenshot({ path: `${out}/${scn}-${label.replace(/\W+/g, '_')}.png` });
  ok(scn, `${label}: cursor released`, !st.locked && st.wants === expectWants, st);
}

// 1. new web player -> Mouse+Keyboard, every bind, mouse look while moving, pointer lock release
{
  const scn = 'new-web', S = await boot(scn, null);
  const c = await S.ctl(); ok(scn, 'new web config defaults to Mouse+Keyboard + free cam + mouse look', c.preset === 1 && c.freeCam && c.mouseLook, c);
  const f = await S.file(); ok(scn, 'saved config labels controls_preset 1', /controls_preset 1/.test(f));
  ok(scn, 'Z = LCtrl, pad L3, pad LT, LShift (gamepad slots untouched)', c.z.join() === [0x1d, 0x1007, 0x101a, 0x2a].join(), c.z);
  ok(scn, 'A = Space, pad A, RMB (gamepad/mouse slots untouched)', c.a.join() === [0x39, 0x1000, 0x1103, 0xffff].join(), c.a);
  ok(scn, 'click takes pointer lock', await S.lock());
  // mouse look while running
  await S.p.keyboard.down('KeyW'); await S.p.waitForTimeout(600);
  const y0 = S.last().yaw; const sticks = [];
  for (let i = 0; i < 25; i++) { await S.p.mouse.move(480 + (i + 1) * 12, 270); await S.p.waitForTimeout(40); sticks.push(S.last().sy); }
  await S.p.waitForTimeout(800); const y1 = S.last().yaw; await S.p.keyboard.up('KeyW');
  ok(scn, 'mouse look rotates the camera while moving (W held)', y0 !== y1 && sticks.every(v => v > 40), { y0, y1, minStick: Math.min(...sticks) });
  for (const [k, w] of MKB_KEYS) await S.key(k, w);
  await S.mouse('left', 'B'); await S.mouse('right', 'A');
  await S.p.screenshot({ path: `${out}/${scn}-after-keys.png` });
  await S.lock();
  await pausedCheck(S, scn, 'Esc pauses', () => hold(S, 'Escape'));
  await hold(S, 'Escape'); await S.p.waitForTimeout(1000); // DJUI back = resume
  ok(scn, 'resume then click relocks', (await S.lock()) && (await S.wants()) === 1);
  await pausedCheck(S, scn, 'P pauses', () => hold(S, 'KeyP'));
  await hold(S, 'Escape'); await S.p.waitForTimeout(1000); await S.lock();
  await pausedCheck(S, scn, 'browser drops lock (eaten Esc) -> auto pause', () => S.p.evaluate(() => document.exitPointerLock()));
  await hold(S, 'Escape'); await S.p.waitForTimeout(1000);
  ok(scn, 'after resume click relocks', await S.lock());
  await pausedCheck(S, scn, 'chat (Enter) releases', () => hold(S, 'Enter'));
  await hold(S, 'Escape'); await S.p.waitForTimeout(800);
  ok(scn, 'chat closed, click relocks', await S.lock());
  await pausedCheck(S, scn, 'console (`) releases', () => hold(S, 'Backquote'));
  await hold(S, 'Backquote'); await S.p.waitForTimeout(800);
  ok(scn, 'console closed, click relocks', await S.lock());
  // preset switching at runtime
  const cc = await S.ctl(0); await S.p.waitForTimeout(800);
  ok(scn, 'switch to Classic: Lakitu camera, cursor released', cc.preset === 0 && !cc.freeCam && !cc.mouseLook && !(await S.locked()) && (await S.wants()) === 0, cc);
  ok(scn, 'Classic: click does not lock', !(await S.lock()));
  for (const [k, w] of CLASSIC_KEYS) await S.key(k, w);
  await S.mouse('left', 'B'); await S.mouse('right', 'A');
  await pausedCheck(S, scn, 'Classic Space pauses', () => hold(S, 'Space'));
  await hold(S, 'Space'); await S.p.waitForTimeout(1000);
  const cm = await S.ctl(1); ok(scn, 'switch back to Mouse+Keyboard', cm.preset === 1 && cm.freeCam && cm.mouseLook, cm);
  ok(scn, 'MKB again: click locks', await S.lock());
  await S.key('Space', 'A'); await S.key('ControlLeft', 'Z');
  fs.writeFileSync(`${out}/${scn}-console.log`, S.logs.join('\n') + '\n');
  await S.ctx.close();
}
// 2. existing config identical to old defaults -> Classic, nothing rewritten
for (const [scn, cfg, want] of [['old-classic', OLD_CLASSIC, 0], ['old-custom', OLD_CUSTOM, 2]]) {
  const S = await boot(scn, cfg);
  const c = await S.ctl();
  ok(scn, `existing config labelled ${['Classic', 'MKB', 'Custom'][want]}, free cam left off`, c.preset === want && !c.freeCam, c);
  const before = bindLines(cfg).map(l => l.split(' ').slice(0, 5).join(' '));
  const now = bindLines(await S.file());
  const same = (l, i) => { const t = l.split(' '); return t.slice(0, 4).join(' ') === before[i] && (t[4] === undefined || t[4] === 'ffff'); };
  ok(scn, 'sm64config.txt binds unchanged after load (only an empty 4th slot may be added)', now.length === before.length && now.every(same), { bad: now.filter((l, i) => !same(l, i)) });
  const bk = bindLines(await S.file('/save/sm64config-backup.txt')).map(l => l.split(' ').slice(0, 5).join(' '));
  ok(scn, 'saved copy keeps the same 3 slots (4th = ffff)', bk.every((l, i) => l === before[i] + ' ffff'), { first: bk[0] });
  if (want === 0) { for (const [k, w] of CLASSIC_KEYS.slice(4, 8)) await S.key(k, w); }
  else { await S.key('KeyJ', 'A'); }
  ok(scn, 'no pointer lock on click (mouse look off)', !(await S.lock()));
  await S.ctx.close();
}
await browser.close();
fs.writeFileSync(`${out}/controls-results.json`, JSON.stringify(results, null, 2));
const f = results.filter(r => !r.ok).length; console.log(f ? `FAILED ${f}/${results.length}` : `PASS ${results.length}/${results.length}`);
process.exitCode = f ? 1 : 0;
