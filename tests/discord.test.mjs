// The page as a Discord Activity (discord.js): outside Discord's frame nothing is asked and the logon is as it was; in
// it, the session is the Activity's instance at once and everyone starts as Guest, Windows waiting for nothing of
// Discord's. Once Windows has started an Authorize button is on the screen; nothing is asked of Discord until it is
// pressed. Pressed, the Embedded App SDK's own handshake runs (the vendored SDK itself when it is there, against a
// parent that answers as Discord's client does: HANDSHAKE, READY, AUTHORIZE, AUTHENTICATE), the person takes their
// Discord name in the running session (the events opened again under it) and the button goes; a display name a logon
// name cannot keep whole gives the user name; a failed exchange leaves Guest and the button to press again, with the
// SDK made once. The server's side (tools/discord_api.py) and the stand-in for Discord (tools/discord_stub.py):
// tests/discord_server.py
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const shared = read('shared.js');
const IMPORT = "import('./vendor/embedded-app-sdk.js')";
assert.ok(read('discord.js').includes(IMPORT), 'discord.js imports the SDK from this origin');
const discord = read('discord.js').replace(IMPORT, 'importSdk()');
const page = read('index.html'), order = ['shared.js', 'discord.js', 'host-web.js'].map(f => page.indexOf(`<script src="${f}">`));
assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], 'discord.js loads after shared.js and before host-web.js chooses the store');

const CLIENT = '1234567890123456789';
const sdkFile = new URL('../vendor/embedded-app-sdk.js', import.meta.url);
const real = existsSync(sdkFile);
// (without the vendored file: the part of the SDK discord.js uses, speaking the same messages)
class MiniSDK {
  constructor(id) {
    const q = new URLSearchParams(window.location.search), pending = new Map(); let n = 0, ready;
    this.instanceId = q.get('instance_id'); this.ok = new Promise(r => { ready = r; });
    window.addEventListener('message', e => {
      const [op, m] = e.data; if (op !== 1) return;
      if (m.cmd === 'DISPATCH' && m.evt === 'READY') return ready();
      const p = pending.get(m.nonce); if (!p) return; pending.delete(m.nonce); m.evt === 'ERROR' ? p.no(m.data) : p.ok(m.data);
    });
    const cmd = (c, args) => new Promise((ok, no) => { const nonce = String(++n); pending.set(nonce, { ok, no }); window.parent.postMessage([1, { cmd: c, args, nonce }], '*'); });
    this.commands = { authorize: a => cmd('AUTHORIZE', a), authenticate: a => cmd('AUTHENTICATE', a) };
    window.parent.postMessage([0, { v: 1, encoding: 'json', client_id: id, frame_id: q.get('frame_id') }], '*');
  }
  ready() { return this.ok; }
}
const turns = async n => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

/** a page: shared.js then discord.js, in Discord's frame when `search` has its launch parameters; then Windows starts
 *  (the page's store chosen, the machine up). o.user: who Discord's client says is there; o.silent: a client that
 *  answers nothing; o.token: the server's answer to the exchange (a function: one for each asking) */
async function run(search, o = {}) {
  const m = { ...(o.stored || {}) };
  const store = x => ({ getItem: k => (k in x ? x[k] : null), setItem: (k, v) => { x[k] = v; }, removeItem: k => { delete x[k]; } });
  const listeners = new Set(), sent = [], asked = [], codes = new Map(), tokens = new Map(), streams = [];
  const user = o.user || { id: '111', username: 'annlee', global_name: 'Ann Lee', discriminator: '0', avatar: null, public_flags: 0 };
  const q = new URLSearchParams(search);
  const deliver = data => setImmediate(() => { for (const f of listeners) f({ origin: 'https://discord.com', data }); });
  // Discord's client, the frame's parent
  const parent = { postMessage(msg) {
    sent.push(msg); if (o.silent) return;
    const [op, x] = msg;
    if (op === 0) {
      assert.deepEqual({ v: x.v, encoding: x.encoding, client_id: x.client_id, frame_id: x.frame_id }, { v: 1, encoding: 'json', client_id: CLIENT, frame_id: q.get('frame_id') });
      return deliver([1, { cmd: 'DISPATCH', evt: 'READY', nonce: null, data: { v: 1, config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' } } }]);
    }
    if (op !== 1) return;
    const answer = data => deliver([1, { cmd: x.cmd, evt: null, data, nonce: x.nonce }]);
    if (x.cmd === 'AUTHORIZE') {
      assert.deepEqual(x.args, { client_id: CLIENT, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
      const code = 'code' + sent.length; codes.set(code, user); return answer({ code });
    }
    if (x.cmd === 'AUTHENTICATE') {
      const u = tokens.get(x.args.access_token);
      if (!u) return deliver([1, { cmd: x.cmd, evt: 'ERROR', data: { code: 4009, message: 'Invalid access token' }, nonce: x.nonce }]);
      return answer({ access_token: x.args.access_token, user: u, scopes: ['identify'], expires: new Date(Date.now() + 6048e5).toISOString(),
        application: { id: CLIENT, name: 'Windows 95', description: '', icon: null, rpc_origins: [] } });
    }
    assert.fail('a command nothing here sends: ' + x.cmd);
  } };
  const location = { search, origin: 'https://' + CLIENT + '.discordsays.com', href: 'https://' + CLIENT + '.discordsays.com/' + search };
  class EventSource { constructor(u) { this.u = u; this.open = true; streams.push(this); } addEventListener() {} close() { this.open = false; } }
  const window = { location, parent, EventSource, addEventListener: (t, f) => { if (t === 'message') listeners.add(f); }, removeEventListener: (t, f) => listeners.delete(f) };
  // the page's document: the button made in it, pressed as a person presses it
  const buttons = [], doc = { referrer: 'https://discord.com/', focused: 0, getElementById: id => (id === 'screen' ? { focus() { doc.focused++; } } : null),
    body: { appendChild(b) { buttons.push(b); } },
    createElement: () => { const on = {}; return { style: {}, on: true, addEventListener: (t, f) => { (on[t] = on[t] || []).push(f); }, remove() { this.on = false; },
      press() { let passed = true; for (const f of on.click || []) f({ stopPropagation() { passed = false; } }); assert.equal(passed, false, 'Windows under the button gets none of its presses'); } }; } };
  globalThis.window = window; globalThis.document = doc;   // (the SDK's own globals)
  // the page's server: the application's id, and the code for a token (tools/discord_api.py)
  let askings = 0;
  const fetch = async (u, init) => {
    asked.push(u);
    if (u === '__discord/config') return { ok: true, json: async () => ({ client_id: o.noApp ? '' : CLIENT }) };
    if (u === '__discord/token') {
      assert.equal(init.method, 'POST'); const { code } = JSON.parse(init.body);
      const fixed = typeof o.token === 'function' ? o.token(askings++) : o.token; if (fixed) return fixed;
      if (!codes.has(code)) return { ok: false, status: 502, json: async () => ({ error: 'invalid_grant' }) };
      const t = 'tok-' + code; tokens.set(t, codes.get(code)); codes.delete(code);
      return { ok: true, json: async () => ({ access_token: t }) };
    }
    throw new Error('asked ' + u);
  };
  const warned = [], console = { warn: (...a) => warned.push(a.join(' ')) };
  const importSdk = async () => (real ? import(sdkFile.href) : { DiscordSDK: MiniSDK });
  class XMLHttpRequest { open(_, u) { this.u = u; } send() { asked.push(this.u); this.status = 200; this.responseText = JSON.stringify({ seq: 0, world: {}, intents: {} }); } }
  new Function('window', 'location', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'fetch', 'setTimeout', 'URL', 'URLSearchParams', 'console', shared)(
    window, location, store(m), store({}), XMLHttpRequest, fetch, () => 0, URL, URLSearchParams, console);
  new Function('window', 'location', 'document', 'fetch', 'URLSearchParams', 'console', 'importSdk', discord)(window, location, doc, fetch, URLSearchParams, console, importSdk);
  const D = window.W95Discord, S = window.W95Shared;
  assert.equal(await D.ready, null, 'Windows waits for nothing of Discord\'s');
  await turns(5); assert.equal(buttons.length, 0, 'no button before Windows has started');
  const host = S.wanted() ? S.start({ disk: { load() {} }, registry: { load() {} } }) : null;
  if (host) { S.ready(); await turns(5); }
  const button = buttons[0] || null;
  /** the button pressed, and the handshake run to its end (the button gone, or to press again) */
  const press = async () => { button.press(); assert.equal(button.disabled, true); for (let i = 0; i < 200 && button.on && button.disabled && !o.silent; i++) await turns(1); if (o.silent) await turns(30); };
  return { D, S, host, button, buttons, press, sent, asked, warned, streams, doc };
}
const INSTANCE = 'i-1276580072400224306-gc-912952092627435520-912954213460484116';
const launch = (instance = INSTANCE) => `?instance_id=${instance}&location_id=x&guild_id=912952092627435520&channel_id=912954213460484116&frame_id=f-1&platform=desktop`;
const ANN = { id: '111', username: 'annlee', name: 'Ann Lee' };

// outside Discord: nothing asked, the logon as this browser has it, no button
{
  const { D, S, sent, asked, buttons } = await run('?user=Bob&session=room1');
  assert.equal(D.inside, false); assert.deepEqual(S.logon, { user: 'Bob', session: 'room1' });
  assert.deepEqual(sent, []); assert.ok(!asked.some(u => u.startsWith('__discord')), asked.join(' ')); assert.equal(buttons.length, 0);
}
{ const { S } = await run('', { stored: { 'w95.logon': JSON.stringify({ user: 'Ann', local: true }) } }); assert.equal(S.wanted(), false, 'a kept session of this computer\'s is still chosen outside Discord'); }

// in Discord's frame: Guest in the instance's session at once, whatever this browser kept; Windows starts with
// nothing asked of Discord; the Authorize button then, and still nothing asked until it is pressed
{
  const { D, S, host, button, buttons, press, sent, asked, streams, doc, warned } = await run(launch(), { stored: { 'w95.logon': JSON.stringify({ user: 'Old', session: 'u-old-1', local: true }) } });
  assert.equal(D.inside, true); assert.deepEqual(S.logon, { user: 'Guest', session: INSTANCE }); assert.equal(S.wanted(), true);
  assert.equal(host.userName, 'Guest'); assert.equal(host.shared.session, INSTANCE);
  assert.ok(asked[0].startsWith(`__session/${INSTANCE}/state?client=`) && asked[0].endsWith('&user=Guest'), asked[0]);
  assert.equal(buttons.length, 1); assert.equal(button.textContent, 'Authorize'); assert.equal(button.id, 'discordAuthorize'); assert.ok(button.on);
  assert.deepEqual(sent, []); assert.equal(asked.length, 1, 'nothing asked of Discord or of the server for it before the press');
  // pressed: the handshake, their name theirs in the running session (the events opened again under it before the
  // first ones close), the button gone, the keys Windows' again
  await press();
  assert.deepEqual(D.user(), ANN); assert.deepEqual(S.logon, { user: 'Ann Lee', session: INSTANCE });
  assert.deepEqual(asked.slice(1), ['__discord/config', '__discord/token']);
  assert.equal(streams.length, 2); assert.ok(streams[0].u.includes('user=Guest') && !streams[0].open && streams[1].u.includes('user=Ann%20Lee') && streams[1].open, streams.map(x => x.u).join(' '));
  assert.equal(button.on, false); assert.equal(doc.focused, 1); assert.deepEqual(warned, []);
  assert.deepEqual(await D.authorize(), ANN); assert.equal(sent.filter(x => x[0] === 0).length, 1, 'asked again: the same person, nothing more of Discord');
}
// two people in one Activity: one session, each their own name once they ask
{
  // (one page at a time: the SDK reads the page it is in from the globals)
  const a = await run(launch()); await a.press();
  const b = await run(launch(), { user: { id: '222', username: 'bob.b', global_name: 'Bob', discriminator: '0', avatar: null, public_flags: 0 } }); await b.press();
  assert.equal(a.S.logon.session, b.S.logon.session); assert.deepEqual([a.S.logon.user, b.S.logon.user], ['Ann Lee', 'Bob']);
  const c = await run(launch('i-2-gc-1-2')); assert.notEqual(c.S.logon.session, a.S.logon.session, 'another instance is another session');
}
// a display name a logon name cannot keep whole, or none: the user name
for (const global_name of ['Bøb 🎮', '日本語', null, '  ']) {
  const { S, D, press } = await run(launch(), { user: { id: '222', username: 'bob.b', global_name, discriminator: '0', avatar: null, public_flags: 0 } });
  await press(); assert.equal(S.logon.user, 'bob.b', String(global_name)); assert.equal(D.user().username, 'bob.b');
}
{ const { S, press } = await run(launch(), { user: { id: '3', username: 'a_very_long_user_name_of_32_chars', global_name: 'A Display Name Longer Than Twenty', discriminator: '0', avatar: null, public_flags: 0 } }); await press(); assert.equal(S.logon.user, 'A Display Name Longe'); }

// the instance's id as a session's id: the server's letters, 64 at most, the same for everyone, another's another
{
  const { D } = await run('');
  assert.equal(D.session(INSTANCE), INSTANCE);
  const long = 'i-' + '9'.repeat(40) + '-gc-' + '8'.repeat(20) + '-', a = D.session(long + '1'), b = D.session(long + '2');
  assert.ok(/^[A-Za-z0-9_.-]{1,64}$/.test(a) && a.length === 64 && a === D.session(long + '1') && a !== b, a);
  assert.equal(D.session('i-1/../x y'), 'i-1..xy'); assert.equal(D.session(null), '');
}

// no identity: the exchange refused, no application, a token Discord's client does not know, no token. Guest still,
// the reason on the button, which is there to press again
for (const o of [{ token: { ok: false, status: 502, json: async () => ({}) } }, { noApp: true }, { token: { ok: true, json: async () => ({ access_token: 'forged' }) } }, { token: { ok: true, json: async () => ({}) } }]) {
  const { S, D, button, press, warned, streams, doc } = await run(launch(), o);
  await press();
  assert.equal(D.user(), null); assert.deepEqual(S.logon, { user: 'Guest', session: INSTANCE }); assert.equal(streams.length, 1, 'Guest throughout: the events opened once');
  assert.ok(button.on && !button.disabled && button.textContent === 'Authorize' && /^Discord did not name you: /.test(button.title), button.title); assert.equal(doc.focused, 1);
  assert.equal(warned.length, 1); assert.match(warned[0], /^\[discord\] no identity from Discord/);
}
// refused once, then pressed again: named, with the SDK made (and answered by Discord's client) once
{
  const { S, button, press, sent } = await run(launch(), { token: n => (n === 0 ? { ok: false, status: 502, json: async () => ({}) } : null) });
  await press(); assert.equal(S.logon.user, 'Guest'); await press(); assert.equal(S.logon.user, 'Ann Lee'); assert.equal(button.on, false);
  assert.equal(sent.filter(x => x[0] === 0).length, 1, 'one handshake for the frame');
}
// a client that never answers: the button waits, Windows goes on as Guest
{
  const { S, button, press, warned } = await run(launch(), { silent: true });
  await press(); assert.ok(button.on && button.disabled && button.textContent === 'Authorizing...'); assert.equal(S.logon.user, 'Guest'); assert.deepEqual(warned, []);
}

// the server's side and the stand-in for Discord, in Python
const r = spawnSync('python3', [new URL('./discord_server.py', import.meta.url).pathname], { encoding: 'utf8', timeout: 60000 });
assert.equal(r.status, 0, r.stderr || r.stdout);
assert.match(r.stdout, /discord_server: ok/);
console.log(`discord: ok (${real ? 'the vendored SDK' : 'no vendored SDK: its messages only'})`);
