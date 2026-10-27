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

function page(search = '', stored = {}) {
  const posts = [], sources = [], applied = [], regs = [], timers = [];
  const store = m => ({ getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } });
  const local = store({ ...stored }), session = store({});
  const location = { search, href: 'http://h/' + search, reload() { location.reloaded = true; } };
  class XMLHttpRequest {
    open(m, u) { this.u = u; } send() {
      this.status = 200;
      this.responseText = JSON.stringify({ seq: 7, sidBase: 3 << 20, disk: { nodes: [{ sid: 0, parent: -1, name: '', dir: true }, { sid: 5, parent: 0, name: 'a.txt', dir: false, data: b64('hi') }], label: 'W95', serial: 1 },
        registry: [['hkcu\\x', [['v', { type: 1, data: b64('1\0') }]], null]], url: this.u });
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
await P.settle();

// another machine's changes: waiting until Windows has started, then applied; this one's own echo passed over
const es = P.sources[0];
es.emit('op', { seq: 8, client: 'other', kind: 'disk', op: { op: 'data', sid: 5, offset: 0, bytes: b64('ok') } });
es.emit('op', { seq: 9, client: S.client, kind: 'disk', op: { op: 'size', sid: 5, size: 0 } });
assert.equal(P.applied.length, 0, 'before Windows starts: waiting');
S.ready(P.fs);
assert.equal(P.applied.length, 1); assert.equal(P.applied[0][0], 'C'); assert.equal(new TextDecoder().decode(P.applied[0][1].bytes), 'ok');
es.emit('op', { seq: 10, client: 'other', kind: 'reg', op: { op: 'set', path: 'hkcu\\y', name: 'n', value: { type: 4, data: b64('\x01\0\0\0') } } });
assert.equal(P.regs[0][1], 'remote', 'to this page\'s machines, not back to the server'); assert.deepEqual([...P.regs[0][0].value.data], [1, 0, 0, 0]);
assert.equal(S.seq(), 10);

// who else is here: not this person; their pointers
const seen = []; S.watch(list => seen.push(list.map(p => p.user)));
es.emit('people', { people: [{ client: S.client, user: 'Ann' }, { client: 'other', user: 'Guest', x: 10, y: 20 }] });
assert.deepEqual(seen, [['Guest']]); assert.deepEqual(S.people().map(p => [p.x, p.y]), [[10, 20]]);

// this person's pointer: one post for many moves, the last position
S.pointer(1, 2); S.pointer(3, 4); S.pointer(5.4, 6.6);
assert.equal(P.timers.length, 1); P.timers[0]();
const last = P.posts.at(-1); assert.match(last.u, /pointer$/); assert.deepEqual([last.body.x, last.body.y], [5, 7]);

// a reload the server asks for (it no longer has the changes since this page's last)
es.on.reload({ data: '{}' }); assert.ok(P.location.reloaded);

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
console.log('shared: ok');
