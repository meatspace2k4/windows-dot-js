// The dev server's event bus (tools/serve.py /__events): a page's posted events kept in order with sequence numbers,
// long-polled after a since and by a type's regexp, a wait answered by an event posted during it; local JSON requests
// only; and the client (tools/events.mjs wait) exits with the first match, or 1 at its timeout
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = await new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const base = `http://127.0.0.1:${port}`;
const srv = spawn('python3', ['tools/serve.py', String(port)], { cwd: root, stdio: 'ignore' });
const J = { 'Content-Type': 'application/json' };
const post = (events, origin = 'a.localhost:1') => fetch(`${base}/__events`, { method: 'POST', headers: J, body: JSON.stringify({ origin, events }) });
const get = async q => { const r = await fetch(`${base}/__events?${new URLSearchParams(q)}`, { headers: J }); assert.equal(r.status, 200); return r.json(); };
const client = (...args) => new Promise(ok => {
  const p = spawn(process.execPath, ['tools/events.mjs', ...args], { cwd: root }); let out = '';
  p.stdout.on('data', d => out += d); p.on('exit', code => ok({ code, out }));
});
try {
  for (let i = 0; ; i++) { try { await get({ since: 0 }); break; } catch (e) { if (i > 100) throw e; await new Promise(r => setTimeout(r, 50)); } }

  // nothing yet: next 0; a wait with nothing posted answers empty after it
  assert.deepEqual(await get({ since: 0 }), { next: 0, events: [] });
  let t = Date.now(); assert.deepEqual((await get({ since: 0, wait: 300 })).events, []); assert.ok(Date.now() - t >= 250);

  assert.equal((await post([{ type: 'window.open', title: 'A' }, { type: 'fs.write', path: 'C:\\X' }, { type: 'window.close', title: 'A' }])).status, 204);
  await post([{ type: 'window.open', title: 'B' }], 'b.localhost:2');
  let r = await get({ since: 0 });
  assert.deepEqual(r.events.map(e => [e.n, e.type, e.origin]), [[1, 'window.open', 'a.localhost:1'], [2, 'fs.write', 'a.localhost:1'], [3, 'window.close', 'a.localhost:1'], [4, 'window.open', 'b.localhost:2']]);
  assert.equal(r.next, 4);
  assert.deepEqual((await get({ since: 1, match: '^window\\.' })).events.map(e => e.n), [3, 4]);
  assert.deepEqual((await get({ since: 0, match: 'open', origin: 'a.localhost' })).events.map(e => e.title), ['A']);
  assert.deepEqual((await get({ since: 0, origin: 'b.localhost:2' })).events.map(e => e.n), [4]);
  assert.deepEqual(await get({ match: 'window' }), { next: 4, events: [] });   // (no since: only what comes after now)

  // a wait answers when a matching event is posted during it, not on one that does not match
  t = Date.now();
  const w = get({ since: 4, wait: 10000, match: 'braid\\.' });
  setTimeout(() => post([{ type: 'window.open', title: 'C' }]), 150);
  setTimeout(() => post([{ type: 'braid.fault', at: 7 }]), 400);
  r = await w;
  assert.deepEqual(r.events.map(e => [e.n, e.type, e.at]), [[6, 'braid.fault', 7]]);
  assert.equal(r.next, 6);
  assert.ok(Date.now() - t >= 350 && Date.now() - t < 5000);

  // the ring keeps the last 2000 of an origin
  await post(Array.from({ length: 2100 }, (_, i) => ({ type: 'x', i })), 'c.localhost:3');
  r = await get({ since: 0, origin: 'c.localhost:3' });
  assert.equal(r.events.length, 2000); assert.equal(r.events[0].i, 100); assert.equal(r.events.at(-1).n, 2106);

  // local JSON requests only: a page of another origin, or a request not sent as JSON
  assert.equal((await fetch(`${base}/__events?since=0`)).status, 403);
  assert.equal((await fetch(`${base}/__events`, { method: 'POST', headers: { ...J, Origin: 'http://evil.example' }, body: '{"events":[]}' })).status, 403);
  assert.equal((await fetch(`${base}/__events`, { method: 'POST', headers: J, body: '{"events":1}' })).status, 400);
  assert.equal((await fetch(`${base}/__events?match=(`, { headers: J })).status, 400);

  // the client: the first match after it starts, or exit 1 at the timeout
  const c = client('wait', base, 'window\\.open', '5000');
  setTimeout(() => post([{ type: 'window.close', title: 'D' }, { type: 'window.open', title: 'E' }]), 300);
  const cr = await c;
  assert.equal(cr.code, 0); assert.equal(JSON.parse(cr.out).title, 'E');
  t = Date.now(); assert.equal((await client('wait', base, 'nothing', '400')).code, 1); assert.ok(Date.now() - t < 4000);
  console.log('events: ok');
} finally { srv.kill(); }
