// A session shared through the server, the page's side (shared.js): who and where from the URL or the logon this browser
// keeps (Guest in 'guest' by default); the store W95HOST gives is this browser's own C: and registry, in memory (nothing
// written to it, nothing sent); what this machine's person does posted in order, one post at a time: the OS's objects
// and intents (the last for a setting replacing one still waiting); another machine's given to win95.js once Windows
// has started, its own echoes passed over; who else is here, and their pointers; logging off to a name's own session,
// or Guest's shared one
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../shared.js', import.meta.url), 'utf8');

function page(search = '', stored = {}, extra = {}) {
  const posts = [], sources = [], timers = [];
  const store = m => ({ getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } });
  const local = store({ ...stored }), session = store({});
  const location = { search, href: 'http://h/' + search, reload() { location.reloaded = true; } };
  class XMLHttpRequest {
    open(m, u) { this.u = u; } send() { this.status = 200; this.responseText = JSON.stringify({ seq: 7, world: {}, intents: {}, url: this.u, ...extra }); }
  }
  class EventSource { constructor(u) { this.u = u; this.on = {}; sources.push(this); } addEventListener(t, f) { this.on[t] = f; } emit(t, d) { this.on[t]({ data: JSON.stringify(d) }); } }
  let resolve = []; const fetch = (u, o) => { posts.push({ u, body: JSON.parse(o.body) }); return new Promise(ok => resolve.push(() => ok({ ok: true }))); };
  const window = { EventSource };
  const setTimeout = f => { timers.push(f); return timers.length; };
  class URL0 { constructor(h) { this.h = h; this.searchParams = new URLSearchParams(h.split('?')[1] || ''); } toString() { const s = this.searchParams.toString(); return 'http://h/' + (s ? '?' + s : ''); } }
  new Function('window', 'location', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'fetch', 'setTimeout', 'URL', 'URLSearchParams', 'console', src)(
    window, location, local, session, XMLHttpRequest, fetch, setTimeout, URL0, URLSearchParams, { warn() {} });
  return { S: window.W95Shared, posts, sources, timers, location, local, settle: () => { const r = resolve; resolve = []; r.forEach(f => f()); return new Promise(ok => setImmediate(ok)); } };
}

// the default: Guest in the shared session; the URL's ?user= and ?session= first
{ const { S } = page(); assert.deepEqual(S.logon, { user: 'Guest', session: 'guest' }); }
{ const { S } = page('', { 'w95.logon': JSON.stringify({ user: 'Ann', session: 'u-ann-1' }) }); assert.deepEqual(S.logon, { user: 'Ann', session: 'u-ann-1' }); }
{ const { S } = page('?user=Bob&session=room1&debug=1'); assert.deepEqual(S.logon, { user: 'Bob', session: 'room1' }); assert.equal(S.wanted(), true); }
{ const { S } = page('?shared=0'); assert.equal(S.wanted(), false); }

// the start: this browser's own C: and registry, in memory: loaded from its store, nothing written to it or sent
const P = page('?user=Ann&session=room1'), { S } = P;
const wrote = [];
const base = { shares: 'mine', computerName: 'MAC', disk: { load: () => 'my disk', node: () => wrote.push('node'), data: () => wrote.push('data'), size() {}, remove() {}, label() {} },
  registry: { load: () => 'my registry', op: () => wrote.push('reg') } };
const H = S.start(base);
assert.equal(H.shares, 'mine'); assert.equal(H.userName, 'Ann'); assert.equal(H.shared.user, 'Ann');
assert.equal(H.disk.load(), 'my disk'); assert.equal(H.registry.load(), 'my registry');
H.disk.node({ sid: 5 }); H.disk.data(5, 0, new Uint8Array(2)); H.registry.op({ op: 'set', path: 'hkcu\\x', name: 'v' });
assert.deepEqual(wrote, [], 'kept in memory: this computer\'s store untouched'); assert.equal(P.posts.length, 0, 'and nothing sent');
assert.match(P.sources[0].u, /^__session\/room1\/events\?client=\w+&user=Ann&since=7$/);

// intents: in order, one post at a time; a newer one for the same setting replaces one still waiting
{
  S.intent({ key: 'spi:17', kind: 'spi', action: 17, ui: 0, flags: 3 });
  S.intent({ key: 'spi:15', kind: 'spi', action: 15, ui: 60, flags: 3 }); S.intent({ key: 'spi:15', kind: 'spi', action: 15, ui: 120, flags: 3 });
  assert.equal(P.posts.length, 1); assert.deepEqual(P.posts[0].body.ops, [{ kind: 'intent', op: { key: 'spi:17', kind: 'spi', action: 17, ui: 0, flags: 3 } }]);
  await P.settle();
  assert.deepEqual(P.posts[1].body.ops.map(o => [o.kind, o.op.key, o.op.ui]), [['intent', 'spi:15', 120]]);
  await P.settle();
  assert.equal(S.intents().get('spi:15').ui, 120);
}

// another machine's: waiting until Windows has started, then given to win95.js; this one's own echo passed over
const es = P.sources[0], got = [], objs = [];
S.onIntent(i => got.push(i.key)); S.onObj((id, v) => objs.push([id, v]));
es.emit('op', { seq: 8, client: 'other', kind: 'intent', op: { key: 'spi:20', kind: 'spi', action: 20, ui: 0, str: 'C:\\WINDOWS\\CLOUDS.BMP', flags: 3 } });
es.emit('op', { seq: 9, client: S.client, kind: 'intent', op: { key: 'spi:17', kind: 'spi', action: 17, ui: 0, flags: 3 } });
assert.deepEqual(got, [], 'before Windows starts: waiting');
S.ready();
assert.deepEqual(got, ['spi:20']); assert.equal(S.intents().get('spi:20').str, 'C:\\WINDOWS\\CLOUDS.BMP');
es.emit('op', { seq: 10, client: 'other', kind: 'disk', op: { op: 'data' } });   // (an old server's: nothing made of it)
assert.equal(S.seq(), 10);

// who else is here: not this person; their pointers
const seen = []; S.watch(list => seen.push(list.map(p => p.user)));
es.emit('people', { people: [{ client: S.client, user: 'Ann' }, { client: 'other', user: 'Guest', x: 10, y: 20 }] });
assert.deepEqual(seen, [['Guest']]); assert.deepEqual(S.people().map(p => [p.x, p.y]), [[10, 20]]);

// this person's pointer: each move sent as it happens; while one is on its way, the latest goes next
{
  const n = P.posts.length;
  S.pointer(1, 2); S.pointer(3, 4); S.pointer(5.4, 6.6);
  assert.equal(P.posts.length, n + 1); assert.match(P.posts.at(-1).u, /pointer$/); assert.deepEqual([P.posts.at(-1).body.x, P.posts.at(-1).body.y], [1, 2]);
  await P.settle();
  assert.equal(P.posts.length, n + 2); assert.deepEqual([P.posts.at(-1).body.x, P.posts.at(-1).body.y], [5, 7]);
  await P.settle();
}

// the OS's objects: this machine's sent (a newer state of one still waiting replaces it); another's kept in the
// session's world and given to win95.js; a closed one kept as closed; one sent again, or this machine's own, passed over
{
  const n = P.posts.length;
  S.obj('A', { x: 1 }); S.obj('B', { x: 1 }); S.obj('B', { x: 2 });
  await P.settle();
  assert.deepEqual(P.posts.slice(n).flatMap(p => p.body.ops.map(o => [o.kind, o.op.id, o.op.v && o.op.v.x])), [['obj', 'A', 1], ['obj', 'B', 2]]);
  await P.settle();
}
es.emit('op', { seq: 14, client: 'other', kind: 'obj', op: { id: 'N', v: { x: 5 } } });
assert.equal(objs.length, 0, 'one numbered past the next expected: not applied');
const es1 = P.sources.at(-1); assert.match(es1.u, /since=10$/);
es1.emit('op', { seq: 11, client: 'other', kind: 'obj', op: { id: 'N', v: { x: 5 } } });
es1.emit('op', { seq: 11, client: 'other', kind: 'obj', op: { id: 'N', v: { x: 5 } } });
es1.emit('op', { seq: 12, client: S.client, kind: 'obj', op: { id: 'A', v: { x: 1 } } });
assert.deepEqual(objs, [['N', { x: 5 }]]); assert.deepEqual(S.world().get('N'), { x: 5 });
es1.emit('op', { seq: 13, client: 'other', kind: 'obj', op: { id: 'N', v: null } });
assert.deepEqual(objs.at(-1), ['N', null]); assert.equal(S.world().get('N'), null); assert.ok(S.world().has('N'));

// a reload the server asks for (it no longer has the changes since this page's last)
es1.on.reload({ data: '{}' }); assert.ok(P.location.reloaded);

// logging off: a name to its own session (kept with the logon), Guest to the shared one; the URL's user and session dropped
{
  const Q = page('?user=Ann&session=room1&debug=1');
  Q.S.logOff('Carol');
  const kept = JSON.parse(Q.local.getItem('w95.logon')); assert.equal(kept.user, 'Carol'); assert.match(kept.session, /^u-carol-\w{6}$/); assert.equal(kept.own, kept.session, 'the own session kept for the next log off');
  assert.equal(Q.location.href, 'http://h/?debug=1');
  const R = page(); R.S.logOff('Guest'); assert.deepEqual(JSON.parse(R.local.getItem('w95.logon')), { user: 'Guest', session: 'guest' });
  const own = page('', { 'w95.logon': JSON.stringify({ user: 'Guest', session: 'guest', own: 'u-dan-abc123' }) }); own.S.logOff('Dan');
  assert.equal(JSON.parse(own.local.getItem('w95.logon')).session, 'u-dan-abc123', 'the same own session again');
  // another name logging on in the same browser: its own session, not the last name's; the first name's kept for it
  const other = page('', { 'w95.logon': JSON.stringify({ user: 'Carol', session: 'u-carol-abc123', own: 'u-carol-abc123' }) }); other.S.logOff('Mia');
  const mia = JSON.parse(other.local.getItem('w95.logon'));
  assert.match(mia.session, /^u-mia-\w{6}$/); assert.equal(mia.owns.carol, 'u-carol-abc123');
  const back = page('', { 'w95.logon': JSON.stringify(mia) }); back.S.logOff('Carol');
  assert.equal(JSON.parse(back.local.getItem('w95.logon')).session, 'u-carol-abc123', 'the first name\'s own session again');
}
// joining a running session: this machine as its own person, given the session's objects and intents as they are
{
  const J = page('?user=Ann&session=s', {}, { running: true, world: { 'NOTEPAD.EXE#0/Notepad#0': { x: 3 }, 'WELCOME.EXE#0/W#0': null }, intents: { 'spi:17': { key: 'spi:17', kind: 'spi', action: 17, ui: 1, flags: 3 } } });
  const HJ = J.S.start({ disk: {}, registry: {} });
  assert.equal(HJ.userName, 'Ann'); assert.equal(HJ.shared.joining, true);
  assert.deepEqual([...J.S.world()], [['NOTEPAD.EXE#0/Notepad#0', { x: 3 }], ['WELCOME.EXE#0/W#0', null]]);
  assert.deepEqual([...J.S.intents().keys()], ['spi:17']);
}
console.log('shared: ok');
