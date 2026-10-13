#!/usr/bin/env python3
"""Give every file the page loads a per-release URL (?v=<build id>) in a web-dist directory.

Some proxies in front of the relay (Discord's Activity proxy / Cloudflare) override our
"Cache-Control: no-cache" with a 4-hour browser TTL for .js but not for .wasm, so a browser could run
a cached sm64coopdx.js against a newer .wasm. Versioned URLs make each release a different URL, so
the js, wasm and data always come from one build whatever the caches do. index.html itself carries
the ids and is the only file that needs revalidation (the relay serves everything no-cache + ETag).

The build id is a content hash of the release's files, so an unchanged build keeps its URLs (and caches).
Usage: version-dist.py <dist dir>
"""
import hashlib
import pathlib
import sys

dist = pathlib.Path(sys.argv[1])
ASSETS = ["boot.js", "app.js", "diagnostics.js", "sm64coopdx.js", "sm64coopdx.wasm", "sm64coopdx.data"]
files = [dist / name for name in ASSETS] + sorted((dist / "vendor").glob("*.js")) + [dist / "index.html"]
digest = hashlib.sha256()
for path in files:
    digest.update(path.name.encode() + b"\0" + path.read_bytes())
build_id = digest.hexdigest()[:16]


def rewrite(name, replacements):
    path = dist / name
    text = path.read_text()
    for old, new in replacements:
        if text.count(old) != 1:
            sys.exit(f"version-dist: expected exactly one {old!r} in {name}")
        text = text.replace(old, new)
    path.write_text(text)


v = f"?v={build_id}"
rewrite("index.html", [
    # window.assetUrl() adds it to the engine files (sm64coopdx.js/.wasm/.data, app.js, diagnostics.js)
    ("window.BUILD_ID = '';", f"window.BUILD_ID = '{build_id}';"),
    ('<script type="module" src="boot.js"></script>', f'<script type="module" src="boot.js{v}"></script>'),
])
rewrite("boot.js", [
    ("import('./vendor/discord-sdk.js')", f"import('./vendor/discord-sdk.js{v}')"),
])
rewrite("app.js", [
    ("import('./vendor/discord-sdk.js')", f"import('./vendor/discord-sdk.js{v}')"),
])
print(f"web-dist build id {build_id}")
