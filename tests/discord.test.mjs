// The page as a Discord Activity (discord.js): outside Discord's frame nothing is asked and the logon is as it was; in
// it, the session is the Activity's instance and the name the person's Discord name, by the Embedded App SDK's own
// handshake (the vendored SDK itself when it is there, against a parent that answers as Discord's client does:
// HANDSHAKE, READY, AUTHORIZE, AUTHENTICATE); a display name a logon name cannot keep whole gives the user name; a
// failed exchange, or a client that never answers, leaves Guest in the instance's session. Windows never waits for a
// person to answer Discord: one this browser has not seen authorize starts as Guest, is asked once Windows has started
// and is renamed in the running session; one it has seen is named before the start. The server's side
// (tools/discord_api.py) and the stand-in for Discord (tools/discord_stub.py): tests/discord_server.py
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
assert.match(read('host-web.js'), /await window\.W95Discord\.ready;[\s\S]*S\.wanted\(\) && S\.start\(own\)/, 'the store is chosen once Discord has said who');

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

/** a page: shared.js then discord.js, in Discord's frame when `search` has its launch parameters. o.user: who Discord's
 *  client says is there; o.silent: a client that answers nothing; o.token: the server's answer to the exchange */
async function run(search, o = {}) {
  const store = m => ({ getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: k => { delete m[k]; } });
  const listeners = new Set(), sent = [], asked = [], timers = [], codes = new Map(), tokens = new Map();
  const m = { ...(o.stored || {}), ...(o.seen ? { 'w95.discord.authorized': '1' } : {}) }, local = store(m);
  const user = o.user || { id: '111', username: 'annlee', global_name: 'Ann Lee', discriminator: '0', avatar: null, public_flags: 0 };
  const q = new URLSearchParams(search);
  const deliver = data => setImmediate(() => { for (const f of listeners) f({ origin: 'https://discord.com', data }); });
  // Discord's client, the frame's parent
  const parent = { postMessage(msg) {
    sent.push(msg); if (o.silent) return;
    const [op, m] = msg;
    if (op === 0) {
      assert.deepEqual({ v: m.v, encoding: m.encoding, client_id: m.client_id, frame_id: m.frame_id }, { v: 1, encoding: 'json', client_id: CLIENT, frame_id: q.get('frame_id') });
      return deliver([1, { cmd: 'DISPATCH', evt: 'READY', nonce: null, data: { v: 1, config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' } } }]);
    }
    if (op !== 1) return;
    const answer = data => deliver([1, { cmd: m.cmd, evt: null, data, nonce: m.nonce }]);
    if (m.cmd === 'AUTHORIZE') {
      assert.deepEqual(m.args, { client_id: CLIENT, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
      const code = 'code' + codes.size; codes.set(code, user); return answer({ code });
    }
    if (m.cmd === 'AUTHENTICATE') {
      const u = tokens.get(m.args.access_token);
      if (!u) return deliver([1, { cmd: m.cmd, evt: 'ERROR', data: { code: 4009, message: 'Invalid access token' }, nonce: m.nonce }]);
      return answer({ access_token: m.args.access_token, user: u, scopes: ['identify'], expires: new Date(Date.now() + 6048e5).toISOString(),
        application: { id: CLIENT, name: 'Windows 95', description: '', icon: null, rpc_origins: [] } });
    }
    assert.fail('a command nothing here sends: ' + m.cmd);
  } };
  const location = { search, origin: 'https://' + CLIENT + '.discordsays.com', href: 'https://' + CLIENT + '.discordsays.com/' + search };
  const streams = [];
  class EventSource { constructor(u) { this.u = u; this.open = true; streams.push(this); } addEventListener() {} close() { this.open = false; } }
  const window = { location, parent, EventSource, addEventListener: (t, f) => { if (t === 'message') listeners.add(f); }, removeEventListener: (t, f) => listeners.delete(f) };
  globalThis.window = window; globalThis.document = { referrer: 'https://discord.com/' };   // (the SDK's own globals)
  // the page's server: the application's id, and the code for a token (tools/discord_api.py)
  const fetch = async (u, init) => {
    asked.push(u);
    if (u === '__discord/config') return { ok: true, json: async () => ({ client_id: o.noApp ? '' : CLIENT }) };
    if (u === '__discord/token') {
      assert.equal(init.method, 'POST'); const { code } = JSON.parse(init.body);
      if (o.token) return o.token;
      if (!codes.has(code)) return { ok: false, status: 502, json: async () => ({ error: 'invalid_grant' }) };
      const t = 'tok-' + code; tokens.set(t, codes.get(code)); codes.delete(code);
      return { ok: true, json: async () => ({ access_token: t }) };
    }
    throw new Error('asked ' + u);
  };
  const setTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; };
  const warned = [], console = { warn: (...a) => warned.push(a.join(' ')) };
  const importSdk = async () => (real ? import(sdkFile.href) : { DiscordSDK: MiniSDK });
  class XMLHttpRequest { open(m, u) { this.u = u; } send() { asked.push(this.u); this.status = 200; this.responseText = JSON.stringify({ seq: 0, world: {}, intents: {} }); } }
  new Function('window', 'location', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'fetch', 'setTimeout', 'URL', 'URLSearchParams', 'console', shared)(
    window, location, local, store({}), XMLHttpRequest, fetch, setTimeout, URL, URLSearchParams, console);
  new Function('window', 'location', 'localStorage', 'fetch', 'setTimeout', 'URLSearchParams', 'console', 'importSdk', discord)(window, location, local, fetch, setTimeout, URLSearchParams, console, importSdk);
  const D = window.W95Discord, S = window.W95Shared;
  const turns = async n => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  // (a client that answers nothing: the start's wait for a person asked nothing runs out)
  if (o.silent && o.seen) { for (let i = 0; i < 50 && !timers.some(t => t.ms === 4000); i++) await turns(1); timers.find(t => t.ms === 4000).f(); }
  const who = await D.ready, atStart = { ...S.logon }, sentAtStart = sent.length;
  // Windows starts: the page's store chosen (host-web.js), then the machine up (win95.js)
  let host = null;
  if (D.inside && !o.noStart) { host = S.start({ disk: { load() {} }, registry: { load() {} } }); await turns(3); S.ready(); }
  const identity = o.silent ? (await turns(20), null) : await D.identity;
  return { D, S, who, identity, atStart, sentAtStart, host, sent, asked, warned, streams, local: m, timers };
}
const INSTANCE = 'i-1276580072400224306-gc-912952092627435520-912954213460484116';
const launch = (instance = INSTANCE) => `?instance_id=${instance}&location_id=x&guild_id=912952092627435520&channel_id=912954213460484116&frame_id=f-1&platform=desktop`;

// outside Discord: nothing asked, the logon as this browser has it
{
  const { D, S, who, sent, asked } = await run('?user=Bob&session=room1');
  assert.equal(D.inside, false); assert.equal(who, null); assert.deepEqual(S.logon, { user: 'Bob', session: 'room1' });
  assert.deepEqual(sent, []); assert.deepEqual(asked, []);
}
{ const { S } = await run('', { stored: { 'w95.logon': JSON.stringify({ user: 'Ann', local: true }) } }); assert.equal(S.wanted(), false, 'a kept session of this computer\'s is still chosen outside Discord'); }

// in Discord's frame: the instance's session, as the person Discord named, whatever this browser kept
{
  // a person this browser has seen authorize: named before Windows starts, which starts under their name
  const { D, S, who, identity, atStart, host, asked, streams } = await run(launch(), { seen: true, stored: { 'w95.logon': JSON.stringify({ user: 'Old', session: 'u-old-1', local: true }) } });
  assert.equal(D.inside, true); assert.deepEqual(who, { id: '111', username: 'annlee', name: 'Ann Lee' }); assert.deepEqual(identity, who);
  assert.deepEqual(atStart, { user: 'Ann Lee', session: INSTANCE }); assert.equal(S.wanted(), true);
  assert.deepEqual(asked.slice(0, 2), ['__discord/config', '__discord/token']);
  // (the session's own logistics from there: shared.js asks the server for that session as that person)
  assert.equal(host.userName, 'Ann Lee'); assert.equal(host.shared.session, INSTANCE);
  assert.ok(asked[2].startsWith(`__session/${INSTANCE}/state?client=`) && asked[2].endsWith('&user=Ann%20Lee'), asked[2]);
  assert.equal(streams.length, 1, 'named at the start: the events opened once');
}
{
  // a person this browser has not seen authorize: Windows starts at once as Guest in the instance's session with
  // nothing asked of Discord; asked once Windows has started; their name then theirs in the running session, the
  // events opened again under it before the first ones close
  const { S, who, identity, atStart, sentAtStart, host, asked, streams, local } = await run(launch());
  assert.equal(who, null); assert.deepEqual(atStart, { user: 'Guest', session: INSTANCE }); assert.equal(sentAtStart, 0, 'nothing asked of Discord before Windows started');
  assert.equal(host.userName, 'Guest'); assert.ok(asked[0].startsWith(`__session/${INSTANCE}/state?client=`) && asked[0].endsWith('&user=Guest'), asked[0]);
  assert.deepEqual(identity, { id: '111', username: 'annlee', name: 'Ann Lee' }); assert.deepEqual(S.logon, { user: 'Ann Lee', session: INSTANCE });
  assert.equal(streams.length, 2); assert.ok(streams[0].u.includes('user=Guest') && !streams[0].open && streams[1].u.includes('user=Ann%20Lee') && streams[1].open, streams.map(x => x.u).join(' '));
  assert.equal(local['w95.discord.authorized'], '1', 'seen authorizing: named before the start from now on');
}
{
  // (Windows not started: nobody is asked)
  const { S, sent } = await run(launch(), { noStart: true, silent: true });
  assert.deepEqual(S.logon, { user: 'Guest', session: INSTANCE }); assert.deepEqual(sent, []);
}
// two people in one Activity: one session, each their own name
{
  const a = await run(launch()), b = await run(launch(), { user: { id: '222', username: 'bob.b', global_name: 'Bob', discriminator: '0', avatar: null, public_flags: 0 } });
  assert.equal(a.S.logon.session, b.S.logon.session); assert.deepEqual([a.S.logon.user, b.S.logon.user], ['Ann Lee', 'Bob']);
  const c = await run(launch('i-2-gc-1-2')); assert.notEqual(c.S.logon.session, a.S.logon.session, 'another instance is another session');
}
// a display name a logon name cannot keep whole, or none: the user name
for (const global_name of ['Bøb 🎮', '日本語', null, '  ']) {
  for (const seen of [true, false]) {
    const { S, identity } = await run(launch(), { seen, user: { id: '222', username: 'bob.b', global_name, discriminator: '0', avatar: null, public_flags: 0 } });
    assert.equal(S.logon.user, 'bob.b', String(global_name)); assert.equal(identity.username, 'bob.b');
  }
}
{ const { S } = await run(launch(), { user: { id: '3', username: 'a_very_long_user_name_of_32_chars', global_name: 'A Display Name Longer Than Twenty', discriminator: '0', avatar: null, public_flags: 0 } }); assert.equal(S.logon.user, 'A Display Name Longe'); }

// the instance's id as a session's id: the server's letters, 64 at most, the same for everyone, another's another
{
  const { D } = await run('');
  assert.equal(D.session(INSTANCE), INSTANCE);
  const long = 'i-' + '9'.repeat(40) + '-gc-' + '8'.repeat(20) + '-', a = D.session(long + '1'), b = D.session(long + '2');
  assert.ok(/^[A-Za-z0-9_.-]{1,64}$/.test(a) && a.length === 64 && a === D.session(long + '1') && a !== b, a);
  assert.equal(D.session('i-1/../x y'), 'i-1..xy'); assert.equal(D.session(null), '');
}

// no identity: the exchange refused, no application, a token Discord's client does not know, a client that never
// answers. Guest in the instance's session each time, and Windows starts (ready does not reject)
for (const o of [{ token: { ok: false, status: 502, json: async () => ({}) } }, { noApp: true }, { token: { ok: true, json: async () => ({ access_token: 'forged' }) } }, { token: { ok: true, json: async () => ({}) } }, { silent: true }]) {
  for (const seen of [true, false]) {
    const { S, who, identity, warned, local, streams } = await run(launch(), { ...o, seen });
    assert.equal(who, null); assert.equal(identity, null); assert.deepEqual(S.logon, { user: 'Guest', session: INSTANCE }); assert.equal(S.wanted(), true);
    assert.equal(streams.length, 1, 'Guest throughout: the events opened once');
    if (o.silent) { assert.equal(warned.length, 0); continue; }   // (still waiting on Discord: nothing failed)
    assert.equal(warned.length, 1); assert.match(warned[0], /^\[discord\] no identity from Discord/);
    assert.equal(local['w95.discord.authorized'], undefined, 'not seen authorizing: asked after the start next time');
  }
}

// the server's side and the stand-in for Discord, in Python
const r = spawnSync('python3', [new URL('./discord_server.py', import.meta.url).pathname], { encoding: 'utf8', timeout: 60000 });
assert.equal(r.status, 0, r.stderr || r.stdout);
assert.match(r.stdout, /discord_server: ok/);
console.log(`discord: ok (${real ? 'the vendored SDK' : 'no vendored SDK: its messages only'})`);
