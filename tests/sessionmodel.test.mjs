// A shared session's protocol, model-checked: two machines and the server, with the decisions the page makes
// (oslogic.js read, run here as win95.js runs it) and the session's ordering (shared.js: a change sent at once to this
// machine's copy of the world, posted in order, a newer one for the same object replacing one waiting; the server's
// order, sessions.py). Every interleaving of the people's actions (move, close, reopen), the posts and the deliveries
// is explored; once nothing is in flight, every machine must show what the session holds: no machine with a window
// the session closed, none without one it has, every place the same, and no machine's copy of the world unlike the
// server's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis;
new Function(readFileSync(new URL('../oslogic.js', import.meta.url), 'utf8'))();
const { read } = window.W95OSLogic;
const CLOSING = 'closing', M = ['A', 'B'];

// ---- the server (sessions.py): ops in order; a change made before a close of its object (an older generation) is
// passed over, and the object as the server has it is sent again for the machine that made it
function serverOp(S, client, op) {
  const cur = S.gens[op.id] || 0;
  if (RULES.gens && (op.gen || 0) < cur) { S.log.push({ client: 'server', to: client, id: op.id, v: S.world[op.id] ?? null, gen: cur }); return; }
  const gen = op.v === null ? Math.max(cur, (op.gen || 0) + 1) : cur;
  S.gens[op.id] = gen; S.world[op.id] = op.v; S.log.push({ client, id: op.id, v: op.v, gen });
}
// ---- a machine
const mk = (world, gens) => ({ local: new Map(Object.entries(world).filter(([, v]) => v !== null)), seen: new Map(Object.entries(world).filter(([, v]) => v !== null)),
  starting: new Set(), world: new Map(Object.entries(world)), gens: new Map(Object.entries(gens)), own: new Map(), outbox: [], at: 0 });
function send(m, id, v) {   // (shared.js obj: in this machine's copy at once; waiting to be posted, a newer replacing it)
  m.world.set(id, v);
  const same = m.outbox.find(o => o.id === id);
  if (same) same.v = v; else m.outbox.push({ id, v });
}
function post(m, name, S) {   // (shared.js flush: each with the generation it was made in, the server's and this machine's closes on their way)
  for (const op of m.outbox.splice(0)) {
    const flying = m.own.get(op.id) || [];
    op.gen = (m.gens.get(op.id) || 0) + flying.filter(Boolean).length;
    m.own.set(op.id, [...flying, op.v === null]);
    serverOp(S, name, op);
  }
}
function apply(m, id, v) {   // (win95.js osApply, its windows changed at once)
  const mine = m.local.get(id);
  if (v === null) { if (mine !== undefined) { m.seen.set(id, CLOSING); m.local.delete(id); } return; }
  if (mine === undefined) { if (m.starting.has(id)) return; m.starting.add(id); m.local.set(id, -1); osRead(m); return; }   // (started: at the program's own place first)
  m.seen.set(id, v); m.local.set(id, v);
}
function osRead(m) {
  const r = read({ world: m.world, local: m.local, seen: m.seen, starting: m.starting, closing: CLOSING, area: null, lastArea: null, caught: true });
  for (const [id, v] of r.sends) send(m, id, v);
  for (const [id, v] of r.applies) apply(m, id, v);
  for (const id of r.retries) apply(m, id, m.world.get(id));
}
function deliver(m, name, e) {   // (shared.js apply: the world, then another machine's change to the page)
  // (the object's state and generation are taken from the server only when none of this machine's own is on its way;
  // while one is, its own wins, here and in its copy, as the server will have it after)
  const mine = () => (m.own.get(e.id) || []).length > 0 || m.outbox.some(o => o.id === e.id);
  if (e.client === name || e.to === name) m.own.set(e.id, m.own.get(e.id).slice(1));   // (its own back, or passed over by the server)
  if (RULES.ownWins && mine()) return;
  m.world.set(e.id, e.v); m.gens.set(e.id, e.gen);
  if (e.client === name) return;   // (its copy has it already)
  apply(m, e.id, e.v); osRead(m);   // (another's, or the object as the server has it in place of one of this machine's)
}

// ---- the search
const clone = s => ({ S: { world: { ...s.S.world }, gens: { ...s.S.gens }, log: [...s.S.log] }, budget: s.budget, n: s.n, life: s.life,
  m: Object.fromEntries(M.map(k => { const m = s.m[k]; return [k, { local: new Map(m.local), seen: new Map(m.seen), starting: new Set(m.starting), world: new Map(m.world), gens: new Map(m.gens), own: new Map([...m.own].map(([i, a]) => [i, [...a]])), outbox: m.outbox.map(o => ({ ...o })), at: m.at }]; })) });
const key = s => JSON.stringify([s.S, s.budget, s.life || null, M.map(k => { const m = s.m[k]; return [[...m.local], [...m.seen], [...m.starting], [...m.world], [...m.gens], [...m.own], m.outbox, m.at]; })]);
function moves(s) {
  const out = [];
  for (const k of M) {
    const m = s.m[k];
    if (s.budget > 0) {
      if (m.local.has('W')) {
        out.push([`${k} moves W`, t => { t.budget--; t.n++; t.m[k].local.set('W', (k === 'A' ? 10 : 20) + t.n); osRead(t.m[k]); }]);
        // (a close or an open, and whether it was made with nothing else in flight: no change of another's unsent, and
        // the person's machine has everything the server sent. The last such holds over changes made after it)
        const informed = t => t.m[k].at === t.S.log.length && M.every(j => !t.m[j].outbox.length);
        out.push([`${k} closes W`, t => { t.budget--; t.life = { kind: 'closed', informed: informed(t) }; t.m[k].local.delete('W'); osRead(t.m[k]); }]);
      } else if (!m.starting.has('W')) out.push([`${k} opens W`, t => { t.budget--; t.n++; t.life = { kind: 'opened', informed: M.every(j => !t.m[j].outbox.length) && t.m[k].at === t.S.log.length }; t.m[k].local.set('W', (k === 'A' ? 30 : 40) + t.n); osRead(t.m[k]); }]);
    }
    if (m.outbox.length) out.push([`${k} posts`, t => post(t.m[k], k, t.S)]);
    if (m.at < s.S.log.length) out.push([`${k} gets ${JSON.stringify(s.S.log[m.at])}`, t => { const e = t.S.log[t.m[k].at++]; deliver(t.m[k], k, e); }]);
  }
  return out;
}
function check(s, path) {
  for (const k of M) osRead(s.m[k]);   // (a last window change: nothing more to send)
  if (M.some(k => s.m[k].outbox.length)) return;   // (not quiet yet: explored on)
  // (a close wins over the changes made with it; an object opened again after it stays: the last of the two holds)
  const last = s.life && s.life.informed ? s.life.kind : null;
  const w0 = s.S.world.W ?? null, life = `${path.join(' / ')}\n  server W=${w0} after the last ${last}`;
  if (last === 'closed') assert.equal(w0, null, life); else if (last === 'opened') assert.notEqual(w0, null, life);
  for (const k of M) {
    const m = s.m[k], w = s.S.world.W ?? null;
    const msg = `${k}: ${path.join(' / ')}\n  server W=${w} local W=${m.local.get('W')} world W=${m.world.get('W')}`;
    assert.equal(m.world.get('W') ?? null, w, msg);
    if (w === null) assert.ok(!m.local.has('W'), msg); else assert.equal(m.local.get('W'), w, msg);
  }
}
function explore(budget) {
  // (a place is a number here, never 0: the page's states are objects, which are never falsy)
  const S = { world: { W: 5 }, gens: { W: 0 }, log: [] };
  const start = { S, budget, n: 0, m: { A: mk({ W: 5 }, { W: 0 }), B: mk({ W: 5 }, { W: 0 }) } };
  const seen = new Set(), stack = [[start, []]]; let states = 0;
  while (stack.length) {
    const [s, path] = stack.pop(); const k = key(s); if (seen.has(k)) continue; seen.add(k); states++;
    const next = moves(s);
    if (!next.length) { check(clone(s), path); continue; }
    for (const [name, f] of next) { const t = clone(s); f(t); stack.push([t, [...path, name]]); }
  }
  return states;
}
// the rules the session keeps: a machine's own change on its way wins over another's the server put before it
// (shared.js); a change made before its object was closed is passed over (sessions.py: close wins, and an object
// opened again after its close is a new one). Without either, the machines are found to disagree
const RULES = { ownWins: true, gens: true };
const n = explore(4);
for (const off of ['ownWins', 'gens']) {
  RULES[off] = false;
  assert.throws(() => explore(3), /server W=/, `without ${off}: a disagreement found`);
  RULES[off] = true;
}
console.log(`sessionmodel: ok (${n} states)`);
