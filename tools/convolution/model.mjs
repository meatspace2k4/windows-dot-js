// A shared session's protocol as a model: machines and the server, with the decisions the page makes (oslogic.js read,
// run as win95.js runs it) and the session's ordering (shared.js: a change set in this machine's copy of the world at
// once, posted in order, a newer one for the same object replacing one waiting, each with its generation; sessions.py:
// the server's order, a change made before its object's last close passed over). tests/sessionmodel.test.mjs explores
// every interleaving of it; tools/convolution/fuzz.mjs walks it at random, with more machines, objects and late joins.
// Once nothing is in flight, every machine must show what the session holds (check).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis;
if (!globalThis.W95OSLogic) new Function(readFileSync(new URL('../../oslogic.js', import.meta.url), 'utf8'))();
const { read, merge, fields, without, same } = globalThis.W95OSLogic;
const CLOSING = 'closing';

/** a model of `machines` (names; those in `late` join later) sharing `ids`, under `rules` (ownWins, gens: a rule off
 *  is to show it is needed) */
export function model({ machines = ['A', 'B'], late = [], ids = ['W'], rules: given = {} } = {}) {
  const rules = { ownWins: true, gens: true, byField: true, ...given };
  // ---- the server: ops in order; a change made before a close of its object (an older generation) is passed over,
  // and the object as the server has it is sent again for the machine that made it
  function serverOp(S, client, op) {
    const cur = S.gens[op.id] || 0;
    if (rules.gens && (op.gen || 0) < cur) { S.log.push({ client: 'server', to: client, id: op.id, v: S.world[op.id] ?? null, gen: cur }); return; }
    const gen = op.v === null ? Math.max(cur, (op.gen || 0) + 1) : cur;
    S.gens[op.id] = gen; S.world[op.id] = merge(S.world[op.id], op.v); S.log.push({ client, id: op.id, v: op.v, gen });   // (a patch, made to the object)
  }
  // ---- a machine, started from the server's state (a late one: as it is when it joins)
  const mk = S => {
    const live = Object.entries(S.world).filter(([, v]) => v !== null && v !== undefined);
    return { local: new Map(), seen: new Map(), starting: new Set(), world: new Map(Object.entries(S.world)), gens: new Map(Object.entries(S.gens)), own: new Map(), outbox: [], at: S.log.length, catch: live.map(([id]) => id) };
  };
  // (shared.js obj: the whole state in this machine's copy at once; what changed, waiting to be posted, a newer change
  // of the same object merged into it, a close replacing it, a reopening after a close waiting the whole state)
  function send(m, id, v, patch) {
    m.world.set(id, v);
    const same = m.outbox.find(o => o.id === id);
    if (!same) m.outbox.push({ id, v: v === null ? null : patch });
    else same.v = v === null ? null : same.v === null ? v : merge(same.v, patch);
  }
  function post(m, name, S) {
    for (const op of m.outbox.splice(0)) {
      const flying = m.own.get(op.id) || [];
      op.gen = (m.gens.get(op.id) || 0) + flying.filter(f => f.close).length;
      m.own.set(op.id, [...flying, { close: op.v === null, fields: fields(op.v) }]);
      serverOp(S, name, op);
    }
  }
  function apply(m, id, v) {   // (win95.js osApply, its windows changed at once)
    const mine = m.local.get(id);
    if (v === null || v === undefined) { if (mine !== undefined) { m.seen.set(id, CLOSING); m.local.delete(id); } return; }
    if (mine === undefined) { if (m.starting.has(id)) return; m.starting.add(id); m.local.set(id, { p: -1, c: 0 }); osRead(m); return; }   // (started: at the program's own place first)
    m.seen.set(id, v); m.local.set(id, v);
  }
  function osRead(m) {
    const r = read({ world: m.world, local: m.local, seen: m.seen, starting: m.starting, closing: CLOSING, area: null, lastArea: null, caught: true });
    for (const [id, v, patch] of r.sends) send(m, id, v, patch);
    for (const [id, v] of r.applies) apply(m, id, v);
    for (const id of r.retries) apply(m, id, m.world.get(id));
  }
  // (shared.js apply: this machine's own back, or one of its own the server passed over (`to` it, the object as the
  // server has it in its place). While any of its own is on its way or waiting, its own wins for the fields it
  // changes: another's change to other fields is set; a close either way waits for the server's)
  function deliver(m, name, e) {
    if (e.client === name || e.to === name) m.own.set(e.id, (m.own.get(e.id) || []).slice(1));
    const pend = [...(m.own.get(e.id) || []), ...m.outbox.filter(o => o.id === e.id).map(o => ({ close: o.v === null, fields: fields(o.v) }))];
    if (rules.ownWins && pend.length) {
      if (e.client === name || e.v === null || pend.some(p => p.close)) return;
      const rest = rules.byField ? without(e.v, new Set(pend.flatMap(p => p.fields))) : null; if (!rest) return;
      m.world.set(e.id, merge(m.world.get(e.id), rest)); apply(m, e.id, m.world.get(e.id)); osRead(m); return;
    }
    m.world.set(e.id, e.to === name ? e.v : merge(m.world.get(e.id), e.v)); m.gens.set(e.id, e.gen);
    if (e.client === name) return;
    apply(m, e.id, m.world.get(e.id)); osRead(m);
  }

  // ---- states and their moves
  function start(budget) {
    // (a place is a number, never 0: the page's states are objects, which are never falsy)
    // (an object's state: its place, p, and one control's contents, c)
    const S = { world: Object.fromEntries(ids.map((id, i) => [id, { p: 5 + i, c: 0 }])), gens: Object.fromEntries(ids.map(id => [id, 0])), log: [] };
    const m = {};
    for (const k of machines) if (!late.includes(k)) { m[k] = mk(S); for (const id of ids) { m[k].local.set(id, S.world[id]); m[k].seen.set(id, S.world[id]); } m[k].catch = []; }
    return { S, budget, n: 0, life: {}, m };
  }
  const clone = s => ({ S: { world: { ...s.S.world }, gens: { ...s.S.gens }, log: [...s.S.log] }, budget: s.budget, n: s.n, life: { ...s.life },
    m: Object.fromEntries(Object.entries(s.m).map(([k, m]) => [k, { local: new Map(m.local), seen: new Map(m.seen), starting: new Set(m.starting), world: new Map(m.world), gens: new Map(m.gens),
      own: new Map([...m.own].map(([i, a]) => [i, [...a]])), outbox: m.outbox.map(o => ({ ...o })), at: m.at, catch: [...m.catch] }])) });
  const key = s => JSON.stringify([s.S, s.budget, s.life, Object.entries(s.m).map(([k, m]) => [k, [...m.local], [...m.seen], [...m.starting], [...m.world], [...m.gens], [...m.own], m.outbox, m.at, m.catch])]);
  function moves(s) {
    const out = [], here = Object.keys(s.m);
    const informed = (t, k) => t.m[k].at === t.S.log.length && Object.values(t.m).every(j => !j.outbox.length);
    for (const k of machines) {
      const m = s.m[k];
      if (!m) { if (s.budget > 0) out.push([`${k} joins`, t => { t.budget--; t.m[k] = mk(t.S); }]); continue; }
      if (m.catch.length) { out.push([`${k} catches up`, t => { const c = t.m[k]; for (const id of c.catch.splice(0)) apply(c, id, c.world.get(id)); }]); continue; }
      if (s.budget > 0) for (const id of ids) {
        if (m.local.has(id)) {
          out.push([`${k} moves ${id}`, t => { t.budget--; t.n++; t.m[k].local.set(id, { ...t.m[k].local.get(id), p: 10 * (here.indexOf(k) + 1) + t.n }); osRead(t.m[k]); }]);
          out.push([`${k} types in ${id}`, t => { t.budget--; t.n++; t.m[k].local.set(id, { ...t.m[k].local.get(id), c: 10 * (here.indexOf(k) + 1) + t.n }); osRead(t.m[k]); }]);
          // (a close or an open, and whether it was made with nothing else in flight: the last such holds)
          out.push([`${k} closes ${id}`, t => { t.budget--; t.life[id] = { kind: 'closed', informed: informed(t, k) }; t.m[k].local.delete(id); osRead(t.m[k]); }]);
        } else if (!m.starting.has(id)) out.push([`${k} opens ${id}`, t => { t.budget--; t.n++; t.life[id] = { kind: 'opened', informed: informed(t, k) }; t.m[k].local.set(id, { p: 100 * (here.indexOf(k) + 1) + t.n, c: 0 }); osRead(t.m[k]); }]);
      }
      if (m.outbox.length) out.push([`${k} posts`, t => post(t.m[k], k, t.S)]);
      if (m.at < s.S.log.length) out.push([`${k} gets ${JSON.stringify(s.S.log[m.at])}`, t => { const e = t.S.log[t.m[k].at++]; deliver(t.m[k], k, e); }]);
    }
    return out;
  }
  /** once nothing is in flight: whether every machine shows what the session holds (throws, with the path, if not);
   *  false if things are still in flight */
  function check(s, path) {
    for (const m of Object.values(s.m)) osRead(m);   // (a last window change: nothing more to send)
    if (Object.values(s.m).some(m => m.outbox.length || m.catch.length)) return false;
    for (const id of ids) {
      const l = s.life[id], last = l && l.informed ? l.kind : null, w = s.S.world[id] ?? null;
      const J = x => JSON.stringify(x ?? null), life = `${path.join(' / ')}\n  server ${id}=${J(w)} after the last ${last}`;
      if (last === 'closed') assert.equal(w, null, life); else if (last === 'opened') assert.notEqual(w, null, life);
      for (const [k, m] of Object.entries(s.m)) {
        const msg = `${k}: ${path.join(' / ')}\n  server ${id}=${J(w)} local ${id}=${J(m.local.get(id))} world ${id}=${J(m.world.get(id))}`;
        const show = x => JSON.stringify(x ?? null);
        assert.equal(show(m.world.get(id)), show(w), msg);
        if (w === null) assert.ok(!m.local.has(id), msg); else assert.equal(show(m.local.get(id)), show(w), msg);
      }
    }
    return true;
  }
  /** every interleaving to `budget` people's actions (and joins): the number of states */
  function explore(budget) {
    const seen = new Set(), stack = [[start(budget), []]]; let states = 0;
    while (stack.length) {
      const [s, path] = stack.pop(); const k = key(s); if (seen.has(k)) continue; seen.add(k); states++;
      const next = moves(s);
      if (!next.length) { check(clone(s), path); continue; }
      for (const [name, f] of next) { const t = clone(s); f(t); stack.push([t, [...path, name]]); }
    }
    return states;
  }
  return { start, moves, check, clone, explore };
}
