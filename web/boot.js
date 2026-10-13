// The only script anyone can fetch (with index.html and vendor/): it signs in, gets an asset session
// for the engine files, then loads them. Everything else (app.js, diagnostics.js, sm64coopdx.*) is only
// served with that session (?s=, see AssetAuth in the relay), so the game isn't handed out to anyone
// who finds the URL.
//
//   Discord:  signs in through the Embedded App SDK; the relay checks the player's membership of the
//             launching server (and DISCORD_GUILD_IDS, when set) before issuing the session.
//   LAN test: a plain browser on the relay's network, with --allow-lan-test.
//   No relay: a plain static file server (single player); nothing is gated there.
//
// The session only has to last while the page loads (at least 30 minutes). A rejoin reloads the page,
// which signs in and gets a new one.

const query = new URLSearchParams(location.search);
const inDiscord = query.has('frame_id');
const onMobile = query.get('platform') === 'mobile';
const base = inDiscord ? '/.proxy' : '';
const DESKTOP_ONLY = 'This activity only works on desktop for now.';
const RETRY_DELAYS_MS = [2000, 4000, 8000];

const statusEl = document.getElementById('status');
const setStatus = (text) => { statusEl.textContent = text; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `retry`: worth trying again in a moment; `reload`: only a fresh page (a new sign-in) can fix it.
class BootError extends Error {
  constructor(message, retry = false, reload = false) { super(message); this.retry = retry; this.reload = reload; }
}

async function postJson(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                              body: JSON.stringify(body), cache: 'no-store' });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function discordSignIn(clientId) {
  setStatus('Signing in with Discord…');
  const { DiscordSDK } = await import('./vendor/discord-sdk.js');
  const sdk = new DiscordSDK(clientId);
  if (sdk.platform === 'mobile') { throw new BootError(DESKTOP_ONLY); }
  await sdk.ready();
  if (!sdk.guildId) {
    throw new BootError('Start this activity from a voice channel in a server. Each server shares one save.');
  }
  const { code } = await sdk.commands.authorize({
    client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify', 'guilds.members.read'],
  });
  const token = await postJson('/api/token', { code });
  if (token.status !== 200) { throw new BootError('Discord sign-in failed.', true); }
  await sdk.commands.authenticate({ access_token: token.data.access_token });
  return { mode: 'discord', access_token: token.data.access_token, guild_id: sdk.guildId };
}

// Returns the relay's /api/config, or null when there's no relay (a static file server).
async function loadConfig() {
  const response = await fetch(base + '/api/config', { cache: 'no-store' });
  if (response.status === 404 && !inDiscord) { return null; }
  if (!response.ok) { throw new BootError(`The server had a problem (${response.status}).`, true); }
  return response.json();
}

async function getAssetSession(request) {
  const { status, data } = await postJson('/api/assets', request);
  if (status === 200 && data.session) { return data.session; }
  if (status === 403) { throw new BootError(data.error === 'could not verify your server membership' || !data.error
    ? 'Could not verify that you are in this server.' : capitalize(data.error) + '.'); }
  throw new BootError(data.error || `The server refused to load the game (${status}).`, status >= 500);
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function boot() {
  if (inDiscord && onMobile) { throw new BootError(DESKTOP_ONLY); }
  const config = await loadConfig();
  if (config) {
    if (inDiscord && !config.discord) { throw new BootError('This server is not set up for Discord yet.'); }
    if (!inDiscord && !config.lanTest) { throw new BootError('Open this activity from Discord.'); }
    const request = inDiscord ? await discordSignIn(config.clientId)
      : { mode: 'lan', room: query.get('room') || 'default', name: query.get('name') || '' };
    setStatus('Loading…');
    window.ASSET_SESSION = await getAssetSession(request);
    // app.js uses this sign-in instead of asking Discord again.
    if (request.mode === 'discord') { window.bootRequest = request; }
  }
  const game = document.createElement('script');
  game.src = window.assetUrl('sm64coopdx.js');
  game.async = false;
  document.body.appendChild(game);
  try {
    ({ createDiagnostics: window.createDiagnostics } = await import(window.assetUrl('./diagnostics.js')));
    await import(window.assetUrl('./app.js'));
  } catch (e) {
    console.error(e);
    // e.g. the session was refused or expired (403): reloading signs in and gets a new one
    throw new BootError('Could not load the game files.', false, true);
  }
}

(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await boot();
      return;
    } catch (e) {
      console.error(e);
      const retry = e instanceof BootError ? e.retry : e instanceof TypeError; // fetch() itself failed
      if (retry && attempt < RETRY_DELAYS_MS.length) {
        setStatus(`${e.message} Retrying…`);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (retry || e.reload) {
        document.getElementById('closed').hidden = false;
        document.getElementById('closed-reason').textContent = e instanceof BootError ? e.message : 'Could not reach the server.';
        document.getElementById('reload').onclick = () => location.reload();
        setStatus('');
      } else {
        setStatus(e instanceof BootError ? e.message : 'Error: ' + e);
      }
      return;
    }
  }
})();
