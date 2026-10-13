// Checks web/version-dist.py: every file the page loads gets the same per-release ?v=<id>, and the id
// follows the content. Without arguments it versions a fixture copy of web/ (fake game files); with a
// web-dist directory it checks that real release instead.
//   node web/tests/dist-version-test.cjs [build/us_web/dist]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.join(__dirname, '..', '..');
let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
  if (!ok) { failed++; }
};

function fixture(gameJs = 'var Module;\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-version-'));
  fs.mkdirSync(path.join(dir, 'vendor'));
  for (const f of ['index.html', 'app.js', 'diagnostics.js']) { fs.copyFileSync(path.join(repo, 'web', f), path.join(dir, f)); }
  for (const f of fs.readdirSync(path.join(repo, 'web', 'vendor'))) {
    fs.copyFileSync(path.join(repo, 'web', 'vendor', f), path.join(dir, 'vendor', f));
  }
  fs.writeFileSync(path.join(dir, 'sm64coopdx.js'), gameJs);
  fs.writeFileSync(path.join(dir, 'sm64coopdx.wasm'), Buffer.from([0, 97, 115, 109]));
  fs.writeFileSync(path.join(dir, 'sm64coopdx.data'), Buffer.alloc(16, 1));
  execFileSync('python3', [path.join(repo, 'web', 'version-dist.py'), dir], { stdio: 'pipe' });
  return dir;
}

function verify(dir, label) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const id = (/window\.BUILD_ID = '([0-9a-f]{16})';/.exec(html) || [])[1];
  check(`${label}: index.html carries a build id`, !!id, html.match(/window\.BUILD_ID = .*/)?.[0]);
  const v = `?v=${id}`;
  check(`${label}: sm64coopdx.js is loaded with it`, html.includes(`game.src = 'sm64coopdx.js${v}'`));
  check(`${label}: app.js is loaded with it`, html.includes(`<script type="module" src="app.js${v}"></script>`));
  check(`${label}: .wasm and .data get it through locateFile`,
        html.includes("locateFile: (path, prefix) => prefix + path + (window.BUILD_ID ? '?v=' + window.BUILD_ID : '')"));
  check(`${label}: app.js imports diagnostics.js with it`, app.includes(`from './diagnostics.js${v}';`));
  check(`${label}: app.js imports the Discord SDK with it`, app.includes(`import('./vendor/discord-sdk.js${v}')`));
  const unversioned = [...html.matchAll(/(?:src=["']|game\.src = ')([^"'?]+\.js)["']/g), ...app.matchAll(/(?:from |import\()'([^'?]+\.js)'/g)]
    .map((m) => m[1]);
  check(`${label}: no unversioned script/module URL left`, unversioned.length === 0, unversioned);
  return id;
}

if (process.argv[2]) {
  verify(process.argv[2], 'release');
} else {
  const a = fixture(), b = fixture(), c = fixture('var Module; // another build\n');
  const idA = verify(a, 'fixture');
  check('same content -> same build id (caches survive a no-op deploy)', idA === verify(b, 'fixture copy'));
  check('changed game js -> new build id', idA !== verify(c, 'changed fixture'));
  let refused = false;
  try { execFileSync('python3', [path.join(repo, 'web', 'version-dist.py'), a], { stdio: 'pipe' }); } catch { refused = true; }
  check('running it twice on one dist fails loudly instead of double-versioning', refused);
  for (const d of [a, b, c]) { fs.rmSync(d, { recursive: true, force: true }); }
}
console.log(failed ? `FAILED ${failed}` : 'PASS: dist versioning checks');
process.exit(failed ? 1 : 0);
