// A Windows 95 session shared with other people through the server (tools/sessions.py). Nothing is streamed and no
// disk is copied: every person's page runs its own Windows on its own C: and registry (this browser's, in memory while
// in the session), and what a person does goes to the others as what they did: the OS's objects (a program's window,
// its place, its controls) and intents (a setting made, as the call that made it), which each machine's Windows makes
// itself. Who else is here, and where their pointers are, come with the session's events too (W95Shared.people).
//
// Which session, and as whom: ?session= and ?user= on the URL (for testing, and a link to join someone), else the
// logon this browser keeps (localStorage w95.logon: { user, session }), else Guest in the shared session 'guest'.
// Each tab is a person of its own (its client id in sessionStorage). ?shared=0 runs on this browser's own store.
(() => {
  const q = new URLSearchParams(location.search);
  const LOGON = 'w95.logon', CLIENT = 'w95.client';
  const get = (s, k) => { try { return s.getItem(k); } catch (_) { return null; } };
  const put = (s, k, v) => { try { s.setItem(k, v); } catch (_) { /* no storage */ } };
  const name = (v, max) => String(v || '').replace(/[^\w.\- ]/g, '').trim().slice(0, max);
  const sessionId = v => String(v || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);

  // ---- who and where
  const stored = (() => { try { return JSON.parse(get(localStorage, LOGON) || 'null'); } catch (_) { return null; } })() || {};
  const logon = {
    user: name(q.get('user') || stored.user, 20) || 'Guest',
    session: sessionId(q.get('session') || stored.session) || 'guest',
  };
  const client = get(sessionStorage, CLIENT) || (() => { const c = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8); put(sessionStorage, CLIENT, c); return c; })();
  // (a page on a session this computer keeps, chosen by Open Session: its own store, until a session is joined)
  const wanted = () => q.get('shared') !== '0' && !window.W95HOST && !(stored.local && !q.get('session'));
  /** the logon this browser keeps for its next visit (joining a session leaves this computer's own) */
  const remember = (user, session) => put(localStorage, LOGON, JSON.stringify({ ...(stored.own ? { own: stored.own } : {}), ...(stored.owns ? { owns: stored.owns } : {}), user: name(user, 20) || 'Guest', session: sessionId(session) || 'guest' }));
  /** the next start on a session this computer keeps (host-web.js's choice), not one on the server */
  const goLocal = () => { quiet = true; put(localStorage, LOGON, JSON.stringify({ ...stored, user: logon.user, local: true })); };
  /** this person's own session, which others join by its id: a name from the user's, kept with the logon, one for each
   *  name this browser has logged on as (another name logging on here gets its own, not the last one's) */
  const ownSession = user => {
    const k = (name(user, 20) || 'user').toLowerCase().replace(/[^a-z0-9]/g, ''), owns = { ...(stored.owns || {}) };
    const was = /^u-([a-z0-9]+)-/.exec(stored.own || '');
    if (was && !owns[was[1]]) owns[was[1]] = stored.own;
    const mine = owns[k] || `u-${k}-${client.slice(0, 6)}`;
    if (stored.own !== mine || (stored.owns || {})[k] !== mine) {
      owns[k] = mine; stored.own = mine; stored.owns = owns; put(localStorage, LOGON, JSON.stringify({ ...stored }));
    }
    return mine;
  };

  const url = s => `__session/${encodeURIComponent(logon.session)}/${s}`;

  // ---- what this machine's person does, to the server in order (one post at a time, the ones made meanwhile together):
  // its OS objects ('obj': a program's window, its place, its controls' contents, win95.js) and its intents ('intent':
  // a setting made, as the call that made it, ne16.js hookIntents). Each machine's disk and registry are its own: what
  // an intent changes there, each machine's Windows writes itself. While one is waiting to go, a newer state of the same
  // object, or a newer intent for the same setting, replaces it
  let outbox = [], posting = false, quiet = false;
  const send = (kind, op) => {
    if (quiet) return;
    const same = (kind === 'obj' && outbox.find(o => o.kind === 'obj' && o.op.id === op.id)) || (kind === 'intent' && outbox.find(o => o.kind === 'intent' && o.op.key === op.key));
    if (same) same.op = op; else outbox.push({ kind, op });
    flush();
  };
  const flush = () => {
    if (posting || !outbox.length) return;
    const ops = outbox; outbox = []; posting = true;
    fetch(url('op'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, ops }) })
      .then(r => { if (!r.ok) console.warn('[shared] the server refused a change:', r.status); }, e => console.warn('[shared] a change was not sent:', e && e.message))
      .finally(() => { posting = false; flush(); });
  };

  // ---- the store W95HOST has in a shared session (host-web.js's shape): this browser's own C: and registry, kept in
  // memory while the machine is in the session (Save Session keeps them), the session's people and objects the server's
  const host = (state, base) => ({
    ...base,
    userName: logon.user,
    // (joining: others' machines already run the session, so its programs are theirs to say, not this one's start's)
    shared: { client, session: logon.session, user: logon.user, joining: !!state.running },
    disk: { ...base.disk, node() {}, remove() {}, data() {}, size() {}, label() {} },
    registry: { load: base.registry.load, op() {} },
  });

  // ---- what others do, applied here; who is here
  let seq = 0, es = null, ready16 = false, onObj = null, onIntent = null;
  const people = new Map(), watchers = new Set(), pending = [], world = new Map(), intents = new Map();
  // another machine's, in the server's order (its own come back too, and are passed over): an OS object, which win95.js
  // sets this machine's OS to (`onObj`), or an intent, which this machine's Windows makes too (`onIntent`). Before
  // Windows has started here they wait (`pending`) until `ready`. One numbered past the next expected means some were
  // missed (the connection dropped): the events are opened again from the last one applied, and the server sends the
  // rest in order
  const apply = m => {
    if (m.seq && seq && m.seq > seq + 1) { catchUp(); return; }
    if (m.seq && m.seq <= seq) return;   // (one already applied, sent again)
    seq = Math.max(seq, m.seq || 0);
    if (m.kind === 'obj') world.set(m.op.id, m.op.v == null ? null : m.op.v);
    if (m.kind === 'intent') intents.set(m.op.key, m.op);
    if (m.client !== client) deliver(m);
  };
  const deliver = m => {
    if (!ready16) { pending.push(m); return; }
    // (with the machine that made it: who did it, for its window's outline in their colour)
    const to = m.kind === 'obj' ? onObj && (() => onObj(m.op.id, m.op.v, m.client)) : m.kind === 'intent' ? onIntent && (() => onIntent(m.op, m.client)) : null;
    if (to) { try { to(); } catch (e) { console.warn('[shared] another machine\'s change could not be made here:', e && e.message); } }
  };
  const catchUp = () => { if (es) { try { es.close(); } catch (_) { /* gone */ } es = null; } listen(); };
  const roster = list => {
    people.clear();
    for (const p of list || []) if (p.client !== client) people.set(p.client, p);
    for (const f of watchers) f([...people.values()]);
  };
  // the session's events: who is here (and where their pointers are), each change in order; a reconnect asks for the
  // changes since the last one seen, or the server says to load the state again ('reload')
  const listen = () => {
    if (!window.EventSource) return;
    es = new window.EventSource(url(`events?client=${encodeURIComponent(client)}&user=${encodeURIComponent(logon.user)}&since=${seq}`));
    es.addEventListener('people', e => { try { roster(JSON.parse(e.data).people); } catch (_) { /* a bad message */ } });
    es.addEventListener('op', e => { try { apply(JSON.parse(e.data)); } catch (err) { console.warn('[shared] a change could not be applied:', err && err.message); } });
    es.addEventListener('reload', () => { quiet = true; location.reload(); });
    es.onerror = () => { if (es.readyState === 2) { es = null; setTimeout(listen, 2000); } };   // (closed for good: open again)
  };

  // ---- this person's pointer, to the others: each move as it happens; while one is on its way, where it is when that
  // one has gone is sent next
  let ptr = null, ptrPosting = false;
  const pointer = (x, y) => {
    ptr = { x: Math.round(x), y: Math.round(y) };
    if (ptrPosting) return;
    const p = ptr; ptr = null; ptrPosting = true;
    fetch(url('pointer'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, ...p }) })
      .catch(() => {}).finally(() => { ptrPosting = false; if (ptr) pointer(ptr.x, ptr.y); });
  };

  // ---- the start: the session's state, synchronously as the page's store loads before Windows starts (null: no server
  // answered, and the page runs on its own store)
  const fetchState = () => {
    try {
      const x = new XMLHttpRequest(); x.open('GET', url(`state?client=${encodeURIComponent(client)}&user=${encodeURIComponent(logon.user)}`), false); x.send();
      return x.status === 200 ? JSON.parse(x.responseText) : null;
    } catch (_) { return null; }
  };
  const start = base => {
    const state = fetchState(); if (!state) return null;
    seq = state.seq || 0;
    for (const [id, v] of Object.entries(state.world || {})) world.set(id, v);
    for (const [k, i] of Object.entries(state.intents || {})) intents.set(k, i);
    listen();
    return host(state, base);
  };
  /** an OS object's new state on this machine (null: it is gone), for every other machine */
  const obj = (id, v) => { world.set(id, v == null ? null : v); send('obj', { id, v: v == null ? null : v }); };
  /** a setting this machine's person made, as the call that made it (ne16.js hookIntents), for every other machine */
  const intent = i => { intents.set(i.key, i); send('intent', i); };
  /** Windows has started here: what came meanwhile is made now */
  const ready = () => { ready16 = true; for (const m of pending.splice(0)) deliver(m); };

  // ---- logging off (Shut Down's "Close all programs and log on as a different user"): a name goes to that person's own
  // session (others join it by its id), Guest (or none) to the shared one; the page starts again there
  const logOff = (user, session) => {
    const u = name(user, 20) || 'Guest';
    const s = sessionId(session) || (/^guest$/i.test(u) ? 'guest' : ownSession(u));
    remember(u, s); quiet = true;
    const next = new URL(location.href); next.searchParams.delete('user'); next.searchParams.delete('session');
    location.href = next.toString();
  };

  window.W95Shared = {
    wanted, start, ready, logon, client, ownSession, remember, logOff, goLocal, pointer, obj, intent,
    people: () => [...people.values()], watch: f => { watchers.add(f); return () => watchers.delete(f); },
    seq: () => seq, world: () => new Map(world), onObj: f => { onObj = f; },
    intents: () => new Map(intents), onIntent: f => { onIntent = f; },
  };
})();