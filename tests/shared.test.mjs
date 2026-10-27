// A session shared through the server, the page's side (shared.js): who and where from the URL or the logon this browser
// keeps (Guest in 'guest' by default); the session's state loaded before Windows starts, as the store W95HOST gives;
// this machine's changes posted in order, one post at a time; another machine's changes applied to this page's C: (by
// node id, bytes decoded) and registry (to its machines, not back to the server), their own echoes passed over, and
// waiting until Windows has started; who else is here, and their pointers; this person's pointer sent at most ten times
// a second; logging off to a name's own session, or Guest's shared one
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../shared.js', import.meta.url), 'utf8');
const b64 = s => Buffer.from(s).toString('base64');

function page(search = '', stored = {}, registry = [['hku\\ann\\x', [['v', { type: 1, data: b64('1\0') }]], null]], extra = {}) {
  const posts = [], sources = [], applied = [], regs = [], timers = [];
  const store = m => ({ getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } });
  const local = store({ ...stored }), session = store({});
  const location = { search, href: 'http://h/' + search, reload() { location.reloaded = true; } };
  class XMLHttpRequest {
    open(m, u) { this.u = u; } send() {
      this.status = 200;
      this.responseText = JSON.stringify({ seq: 7, sidBase: 3 << 20, disk: { nodes: [{ sid: 0, parent: -1, name: '', dir: true }, { sid: 5, parent: 0, name: 'a.txt', dir: false, data: b64('hi') }], label: 'W95', serial: 1 },
        registry, url: this.u, ...extra });
    }
  }
  class EventSource { constructor(u) { this.u = u; this.on = {}; sources.push(this); } addEventListener(t, f) { this.on[t] = f; } emit(t, d) { this.on[t]({ data: JSON.stringify(d) }); } }
  let resolve = []; const fetch = (u, o) => { posts.push({ u, body: JSON.parse(o.body) }); return new Promise(ok => resolve.push(() => ok({ ok: true }))); };
  const window = { EventSource, W95Win32: { regApply: (o, how) => regs.push([o, how]) } };
  const setTimeout = (f, ms) => { timers.push(f); return timers.length; };
  class URL0 { constructor(h) { this.h = h; this.searchParams = new URLSearchParams(h.split('?')[1] || ''); } toString() { const s = this.searchParams.toString(); return 'http://h/' + (s ? '?' + s : ''); } }
  new Function('window', 'location', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'fetch', 'setTimeout', 'URL', 'URLSearchParams', 'console', src)(
    window, location, local, session, XMLHttpRequest, fetch, setTimeout, URL0, URLSearchParams, { warn() {} });
  const fs = { applyStore: (l, op) => applied.push([l, op]) };
  return { S: window.W95Shared, posts, sources, applied, regs, timers, location, local, fs, settle: () => { const r = resolve; resolve = []; r.forEach(f => f()); return new Promise(ok => setImmediate(ok)); } };
}

// the default: Guest in the shared session; the URL's ?user= and ?session= first
{ const { S } = page(); assert.deepEqual(S.logon, { user: 'Guest', session: 'guest' }); }
{ const { S } = page('', { 'w95.logon': JSON.stringify({ user: 'Ann', session: 'u-ann-1' }) }); assert.deepEqual(S.logon, { user: 'Ann', session: 'u-ann-1' }); }
{ const { S } = page('?user=Bob&session=room1&debug=1'); assert.deepEqual(S.logon, { user: 'Bob', session: 'room1' }); assert.equal(S.wanted(), true); }
{ const { S } = page('?shared=0'); assert.equal(S.wanted(), false); }

// the start: the state as the store's load gives it; the events subscribed from its seq
const P = page('?user=Ann&session=room1'), { S } = P;
const H = S.start({ shares: 'mine', computerName: 'MAC' });
assert.equal(H.shares, 'mine'); assert.equal(H.userName, 'Ann'); assert.equal(H.disk.sidBase, 3 << 20);
const disk = H.disk.load(); assert.equal(new TextDecoder().decode(disk.nodes[1].data), 'hi'); assert.equal(disk.label, 'W95');
const reg = H.registry.load(); assert.deepEqual([reg[0][0], new TextDecoder().decode(reg[0][1][0][1].data)], ['hkcu\\x', '1\0']);
assert.match(P.sources[0].u, /^__session\/room1\/events\?client=\w+&user=Ann&since=7$/);

// this machine's changes: in order, one post at a time, the ones made meanwhile in the next
H.disk.data(5, 0, new TextEncoder().encode('yo')); H.disk.size(5, 2); H.registry.op({ op: 'set', path: 'hkcu\\x', name: 'v', value: { type: 1, data: new Uint8Array([50, 0]) } });
assert.equal(P.posts.length, 1); assert.deepEqual(P.posts[0].body.ops, [{ kind: 'disk', op: { op: 'data', sid: 5, offset: 0, bytes: b64('yo') } }]);
await P.settle();
assert.equal(P.posts.length, 2); assert.deepEqual(P.posts[1].body.ops.map(o => o.op.op), ['size', 'set']);
assert.equal(P.posts[1].body.ops[1].op.value.data, b64('2\0'), 'a value\'s bytes as base64');
assert.equal(P.posts[1].body.ops[1].op.path, 'hku\\ann\\x', 'HKCU as this person\'s key under HKEY_USERS');
await P.settle();

// another machine's changes: waiting until Windows has started, then applied; this one's own echo passed over
const es = P.sources[0];
es.emit('op', { seq: 8, client: 'other', kind: 'disk', op: { op: 'data', sid: 5, offset: 0, bytes: b64('ok') } });
es.emit('op', { seq: 9, client: S.client, kind: 'disk', op: { op: 'size', sid: 5, size: 0 } });
assert.equal(P.applied.length, 0, 'before Windows starts: waiting');
S.ready(P.fs);
assert.equal(P.applied.length, 1); assert.equal(P.applied[0][0], 'C'); assert.equal(new TextDecoder().decode(P.applied[0][1].bytes), 'ok');
es.emit('op', { seq: 10, client: 'other', kind: 'reg', op: { op: 'set', path: 'hku\\ann\\y', name: 'n', value: { type: 4, data: b64('\x01\0\0\0') } } });
assert.equal(P.regs[0][1], 'remote', 'to this page\'s machines, not back to the server'); assert.deepEqual([...P.regs[0][0].value.data], [1, 0, 0, 0]);
assert.equal(P.regs[0][0].path, 'hkcu\\y', 'this person\'s own key as HKCU');
es.emit('op', { seq: 11, client: 'other', kind: 'reg', op: { op: 'set', path: 'hkcu\\z', name: 'n', value: { type: 4, data: b64('\0\0\0\0') } } });
es.emit('op', { seq: 12, client: 'other', kind: 'reg', op: { op: 'del', path: 'hku\\bob\\z', name: 'n' } });
assert.deepEqual(P.regs.slice(1).map(r => r[0].path), ['hkcu\\z', 'hku\\bob\\z'], 'another person\'s key as it is');
assert.equal(S.seq(), 12);

// who is logged on: each machine's own, neither taken from another nor sent
es.emit('op', { seq: 13, client: 'other', kind: 'reg', op: { op: 'set', path: 'hklm\\network\\logon', name: 'username', value: { type: 1, data: b64('Bob\0') } } });
assert.equal(P.regs.length, 3);
{ const n = P.posts.length; H.registry.op({ op: 'set', path: 'hklm\\network\\logon', name: 'UserName', value: { type: 1, data: new Uint8Array([65, 0]) } }); assert.equal(P.posts.length, n); }
// the display's mode: each machine's own (its page's size)
es.emit('op', { seq: 13.5, client: 'other', kind: 'reg', op: { op: 'set', path: 'hklm\\config\\0001\\display\\settings', name: 'Resolution', value: { type: 1, data: b64('800,600\0') } } });
assert.equal(P.regs.length, 3);
{ const n = P.posts.length; H.registry.op({ op: 'set', path: 'hkcc\\display\\settings', name: 'Resolution', value: { type: 1, data: new Uint8Array([49, 0]) } }); assert.equal(P.posts.length, n); }

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
const objs = []; S.onObj((id, v) => objs.push([id, v]));
{
  const n = P.posts.length;
  S.obj('A', { x: 1 }); S.obj('B', { x: 1 }); S.obj('B', { x: 2 });
  await P.settle();
  assert.deepEqual(P.posts.slice(n).flatMap(p => p.body.ops.map(o => [o.kind, o.op.id, o.op.v && o.op.v.x])), [['obj', 'A', 1], ['obj', 'B', 2]]);
  await P.settle();
}
es.emit('op', { seq: 14, client: 'other', kind: 'obj', op: { id: 'N', v: { x: 5 } } });
es.emit('op', { seq: 14, client: 'other', kind: 'obj', op: { id: 'N', v: { x: 5 } } });
es.emit('op', { seq: 15, client: S.client, kind: 'obj', op: { id: 'A', v: { x: 1 } } });
assert.deepEqual(objs, [['N', { x: 5 }]]); assert.deepEqual(S.world().get('N'), { x: 5 });
es.emit('op', { seq: 16, client: 'other', kind: 'obj', op: { id: 'N', v: null } });
assert.deepEqual(objs.at(-1), ['N', null]); assert.equal(S.world().get('N'), null); assert.ok(S.world().has('N'));

// one missed (the connection dropped): the events opened again from the last applied, which the server sends from
es.emit('op', { seq: 19, client: 'other', kind: 'obj', op: { id: 'M', v: {} } });
assert.equal(objs.length, 2, 'not applied out of order');
assert.match(P.sources.at(-1).u, /since=16$/); assert.notEqual(P.sources.at(-1), es);
const es2 = P.sources.at(-1);

// a reload the server asks for (it no longer has the changes since this page's last)
es2.on.reload({ data: '{}' }); assert.ok(P.location.reloaded);

// logging off: a name to its own session (kept with the logon), Guest to the shared one; the URL's user and session dropped
{
  const Q = page('?user=Ann&session=room1&debug=1');
  Q.S.logOff('Carol');
  const kept = JSON.parse(Q.local.getItem('w95.logon')); assert.equal(kept.user, 'Carol'); assert.match(kept.session, /^u-carol-\w{6}$/); assert.equal(kept.own, kept.session, 'the own session kept for the next log off');
  assert.equal(Q.location.href, 'http://h/?debug=1');
  const R = page(); R.S.logOff('Guest'); assert.deepEqual(JSON.parse(R.local.getItem('w95.logon')), { user: 'Guest', session: 'guest' });
  const own = page('', { 'w95.logon': JSON.stringify({ user: 'Guest', session: 'guest', own: 'u-dan-abc123' }) }); own.S.logOff('Dan');
  assert.equal(JSON.parse(own.local.getItem('w95.logon')).session, 'u-dan-abc123', 'the same own session again');
}
// HKCU is this person's key under HKEY_USERS: sent as hku\<user>, theirs from the server as HKCU, another's left as it is;
// a person with no profile yet gets the default user's, written back as theirs
{
  const sz = (t, s) => ({ type: t, data: b64(s) });
  const rows = [['hklm\\x', [], null], ['hku\\.default\\control panel', [['a', sz(1, 'd\0')]], null], ['hku\\eve\\control panel', [['a', sz(1, 'e\0')]], null]];
  const text = v => new TextDecoder().decode(v.data);
  const Q = page('?user=Dee&session=s', {}, rows), H2 = Q.S.start({});
  const got = H2.registry.load(), find = p => got.find(r => r[0] === p);
  assert.equal(text(find('hkcu\\control panel')[1][0][1]), 'd\0', 'a new person: the default user\'s profile');
  assert.ok(find('hku\\eve\\control panel'), 'another person\'s profile kept'); assert.ok(find('hku\\.default\\control panel'));
  assert.deepEqual(Q.posts[0].body.ops.map(o => [o.op.op, o.op.path]), [['key', 'hku\\dee\\control panel']], 'the copy written as theirs');
  await Q.settle();
  assert.deepEqual(Q.posts[1].body.ops.map(o => [o.op.op, o.op.path, o.op.name, o.op.value.data]), [['set', 'hku\\dee\\control panel', 'a', b64('d\0')]]);

  // their own profile, once they have one: theirs, not the default's, and nothing written
  const R = page('?user=Eve&session=s', {}, rows), got2 = R.S.start({}).registry.load();
  assert.equal(text(got2.find(r => r[0] === 'hkcu\\control panel')[1][0][1]), 'e\0'); assert.equal(got2.some(r => r[0].startsWith('hku\\eve')), false);
  assert.equal(R.posts.length, 0);

  // no default user: someone else's profile, copied
  const T = page('?user=Fay&session=s', {}, [rows[2]]), got3 = T.S.start({}).registry.load();
  assert.equal(text(got3.find(r => r[0] === 'hkcu\\control panel')[1][0][1]), 'e\0'); assert.ok(got3.find(r => r[0] === 'hku\\eve\\control panel'));
}
// joining a running session: this machine runs as the session's owner (Bob's HKCU), and is given its objects as they are
{
  const J = page('?user=Ann&session=s', {}, [['hku\\bob\\x', [['v', { type: 1, data: b64('b\0') }]], null], ['hku\\ann\\x', [['v', { type: 1, data: b64('a\0') }]], null]],
    { owner: 'Bob', world: { 'NOTEPAD.EXE#0/Notepad#0': { x: 3 }, 'WELCOME.EXE#0/W#0': null } });
  const HJ = J.S.start({});
  assert.equal(HJ.userName, 'Bob', 'the owner\'s name on this machine'); assert.equal(HJ.shared.user, 'Ann', 'the person here, on the pointer');
  const reg = HJ.registry.load(); assert.equal(new TextDecoder().decode(reg.find(r => r[0] === 'hkcu\\x')[1][0][1].data), 'b\0');
  assert.deepEqual([...J.S.world()], [['NOTEPAD.EXE#0/Notepad#0', { x: 3 }], ['WELCOME.EXE#0/W#0', null]]);
}
console.log('shared: ok');
