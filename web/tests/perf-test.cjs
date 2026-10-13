// Single-player speed and sound check. Serves the build itself on two origins and runs the game inside
// a cross-origin iframe (like Discord does, without allow="autoplay"), then checks that:
//   - the game runs at 30 ticks/s (SM64 logic is tick based: more is too fast, less is too slow)
//   - audio stays suspended until the player clicks, then plays: the game makes non-silent samples,
//     they reach the AudioContext, and the queue never runs dry
//   - a suspended AudioContext is resumed by the next key press, every time
//
//   NODE_PATH=$(npm root -g) node web/tests/perf-test.cjs build/us_web baserom.us.z64 [port] [--gpu]
//
// Headless Chromium renders with SwiftShader by default; --gpu asks for the real GPU (Vulkan).
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const gpu = args.includes('--gpu');
const [www, rom, portArg] = args.filter((a) => a !== '--gpu');
if (!www || !rom) {
  console.error('usage: node perf-test.cjs <build dir> <rom path> [port] [--gpu]');
  process.exit(2);
}
const root = path.resolve(www);
const port = +(portArg || 8432);
const gameUrl = `http://127.0.0.1:${port}/index.html?args=--skip-intro`;
const parentUrl = `http://localhost:${port + 1}/`; // another origin

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const gameServer = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();  // also tells the page there is no relay: single player
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const parentServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(
    `<!doctype html><body style="margin:0"><iframe src="${gameUrl}" style="width:960px;height:540px;border:0"></iframe>`);
});

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`);
  if (!ok) { failures++; }
}

async function gameFrame(page) {
  for (;;) {
    const frame = page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${port}/`));
    if (frame) { return frame; }
    await page.waitForTimeout(100);
  }
}

(async () => {
  for (const [server, p] of [[gameServer, port], [parentServer, port + 1]]) {
    server.on('error', (e) => { console.error(e.message); process.exit(1); });
    server.listen(p, '127.0.0.1');
  }

  const launchArgs = ['--disable-dev-shm-usage'];
  if (gpu) { launchArgs.push('--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan'); }
  const browser = await chromium.launch({ args: launchArgs });
  const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });

  // First visit stores the ROM in the browser.
  let page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  await page.goto(parentUrl);
  let frame = await gameFrame(page);
  await frame.waitForFunction(
    () => !document.getElementById('rom-picker').hidden || document.getElementById('overlay').hidden,
    null, { timeout: 120000 });
  if (!(await frame.locator('#rom-picker').isHidden())) { await frame.setInputFiles('#rom-input', rom); }
  await frame.waitForFunction(() => window.sessionInfo, null, { timeout: 120000 });
  await page.close();

  // Second visit, like a returning player. Until the click, only watch the console: Playwright's
  // evaluate() counts as a user gesture and would unlock audio by itself.
  await context.addInitScript((gamePort) => {
    if (location.port !== gamePort) { return; }
    setInterval(() => console.log('AUDIO ' + JSON.stringify({
      state: window.Module?.SDL2?.audioContext?.state ?? null, started: !!window.sessionInfo })), 500);
  }, String(port));
  page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  let audio = null;
  page.on('console', (m) => { if (m.text().startsWith('AUDIO ')) { audio = JSON.parse(m.text().slice(6)); } });
  await page.goto(parentUrl);
  frame = await gameFrame(page);
  for (let i = 0; i < 240 && !audio?.started; i++) { await page.waitForTimeout(500); }
  await page.waitForTimeout(8000);
  check('audio waits for the player to interact', audio?.state === 'suspended', audio);

  const canvas = await (await frame.$('#canvas')).boundingBox();
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.waitForTimeout(1000);
  check('a click starts audio', audio?.state === 'running', audio);

  // Listen to what reaches the speakers.
  await frame.evaluate(() => {
    const { audioContext, audio: sdl } = Module.SDL2;
    const analyser = audioContext.createAnalyser();
    sdl.scriptProcessorNode.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    window.outputPeak = 0;
    setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) { window.outputPeak = Math.max(window.outputPeak, Math.abs(v)); }
    }, 20);
  });
  const stats = () => frame.evaluate(() => ({ ...JSON.parse(UTF8ToString(Module._web_debug_stats())), outputPeak }));
  const a = await stats();
  await page.keyboard.down('w');  // walk around while measuring
  await page.waitForTimeout(10000);
  await page.keyboard.up('w');
  const b = await stats();
  const secs = b.time - a.time, ticks = b.ticks - a.ticks;
  const perTick = (key) => +((b[key] - a[key]) / ticks).toFixed(2);
  console.log(JSON.stringify({
    ticksPerSec: +(ticks / secs).toFixed(1), framesPerSec: +((b.frames - a.frames) / secs).toFixed(1),
    msPerTick: { logic: perTick('logicMs'), audio: perTick('audioMs'), render: perTick('renderMs'), wait: perTick('waitMs') },
    worstTickMs: b.worstTickMs, audioEmptyTicks: b.audioEmpty - a.audioEmpty,
    audioDroppedPerSec: Math.round((b.audioDropped - a.audioDropped) / secs), gamePeak: b.audioPeak, outputPeak: b.outputPeak,
  }));
  check('the game runs at 30 ticks/s', Math.abs(ticks / secs - 30) < 1, ticks / secs);
  check('the game draws at least one frame per second', b.frames - a.frames >= secs, b.frames - a.frames);
  check('the game makes sound', b.audioApi === 'sdl' && b.audioPeak > 1000, { api: b.audioApi, peak: b.audioPeak });
  check('the sound reaches the browser', b.outputPeak > 0.01, b.outputPeak);
  check('the audio queue never runs dry', b.audioEmpty - a.audioEmpty <= 1, b.audioEmpty - a.audioEmpty);

  // Twice, so this can't pass on a listener that only fires once.
  for (const round of [1, 2]) {
    await frame.evaluate(() => Module.SDL2.audioContext.suspend());
    await page.waitForTimeout(1000);
    const suspended = audio?.state === 'suspended';
    await page.keyboard.press('x');
    await page.waitForTimeout(1000);
    check(`a key press resumes suspended audio (${round})`, suspended && audio?.state === 'running', { suspended, audio });
  }

  await browser.close();
  gameServer.close();
  parentServer.close();
  console.log(failures ? `FAIL: ${failures} check(s) failed` : 'PASS (perf)');
  process.exit(failures ? 1 : 0);
})();
