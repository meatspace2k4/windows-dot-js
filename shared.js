// A Windows 95 session shared with other people through the server (tools/sessions.py): the VM's state, C: and the
// registry, which every person's page runs Windows on. Nothing is streamed. C: and the registry are loaded from the
// server; each change this machine makes goes to it (the store's write-through operations, as host-web.js writes them
// to IndexedDB); each change another person's machine makes arrives over the session's events and is applied here
// (fs.js applyStore; the registry's regApply, which tells this page's machines too). Who else is here, and where
// their pointers are, come with the events too (W95Shared.people).
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
  const remember = (user, session) => put(localStorage, LOGON, JSON.stringify({ ...(stored.own ? { own: stored.own } : {}), user: name(user, 20) || 'Guest', session: sessionId(session) || 'guest' }));
  /** the next start on a session this computer keeps (host-web.js's choice), not one on the server */
  const goLocal = () => { quiet = true; put(localStorage, LOGON, JSON.stringify({ ...stored, user: logon.user, local: true })); };
  /** this person's own session, which others join by its id: a name from the user's, kept with the logon */
  const ownSession = user => {
    const mine = stored.own || ('u-' + (name(user, 20) || 'user').toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + client.slice(0, 6));
    if (stored.own !== mine) { stored.own = mine; put(localStorage, LOGON, JSON.stringify({ ...stored, own: mine })); }
    return mine;
  };

  // ---- the wire: bytes as base64 in JSON
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s || ''), c => c.charCodeAt(0));
  // (HKEY_CURRENT_USER is this person's own key under HKEY_USERS, as with Windows 95's user profiles: kept on the server
  // as hku\<user>, the page's HKCU; another person's is theirs, under their name)
  const me = () => 'hku\\' + logon.user.toLowerCase();
  const toServer = p => (p === 'hkcu' || p.startsWith('hkcu\\') ? me() + p.slice(4) : p);
  const fromServer = p => (p === me() || p.startsWith(me() + '\\') ? 'hkcu' + p.slice(me().length) : p);
  const regOut = o => { const r = { ...o, path: toServer(o.path) }; return o.value ? { ...r, value: { type: o.value.type, data: b64(o.value.data) } } : r; };
  const regIn = o => { const r = { ...o, path: fromServer(o.path) }; return o.value ? { ...r, value: { type: o.value.type, data: unb64(o.value.data) } } : r; };
  /** the session's registry as this person's page has it: their profile as HKCU; a person new here starts from the
   *  default user's (hku\.default), or else from a profile someone made before them, as Windows copies the default */
  const regLoad = rows => {
    const prefix = me(), mine = rows.some(([p]) => p === prefix || p.startsWith(prefix + '\\'));
    let from = mine ? prefix : rows.some(([p]) => p === 'hku\\.default' || p.startsWith('hku\\.default\\')) ? 'hku\\.default' : null;
    if (!from) { const any = rows.find(([p]) => /^hku\\[^\\]+/.test(p)); from = any ? any[0].match(/^hku\\[^\\]+/)[0] : null; }
    const out = rows.filter(([p]) => p !== prefix && !p.startsWith(prefix + '\\'));
    if (from) for (const [p, v, n] of rows) {
      if (p !== from && !p.startsWith(from + '\\')) continue;
      const local = 'hkcu' + p.slice(from.length); out.push([local, v, n]);
      // (a profile copied for this person: theirs on the server too, whole, before anything they change goes there)
      if (!mine) { send('reg', regOut(n ? { op: 'key', path: local, name: n } : { op: 'key', path: local })); for (const [k, val] of v) send('reg', regOut({ op: 'set', path: local, name: k, value: val })); }
    }
    return out;
  };
  // (who is logged on is each machine's own: Network\Logon's username stays on it, neither sent nor taken from others)
  const ownValue = o => o.path === 'hklm\\network\\logon' && String(o.name || '').toLowerCase() === 'username';
  const url = s => `__session/${encodeURIComponent(logon.session)}/${s}`;

  // ---- what this machine changes, to the server in order (one post at a time, the ones made meanwhile together).
  // Only the host's changes to C: and the registry are the session's state: every machine applies everyone's input, so
  // each makes the same changes itself (another's HKCU being its own person's, those it sends too). Until the server
  // has said who the host is, they wait (`held`)
  let outbox = [], posting = false, quiet = false, hostId = null, held = [];
  const mineToSend = (kind, op) => kind === 'input' || hostId === client || (kind === 'reg' && op.path && (op.path === me() || op.path.startsWith(me() + '\\')));
  const send = (kind, op) => {
    if (quiet) return;
    if (kind !== 'input' && hostId === null) { held.push({ kind, op }); return; }
    if (!mineToSend(kind, op)) return;
    outbox.push({ kind, op }); flush();
  };
  const hostIs = id => {
    const was = hostId; hostId = id || null;
    if (was === null && hostId !== null) for (const h of held.splice(0)) send(h.kind, h.op);
  };
  const flush = () => {
    if (posting || !outbox.length) return;
    const ops = outbox; outbox = []; posting = true;
    fetch(url('op'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, ops }) })
      .then(r => { if (!r.ok) console.warn('[shared] the server refused a change:', r.status); }, e => console.warn('[shared] a change was not sent:', e && e.message))
      .finally(() => { posting = false; flush(); });
  };

  // ---- the store W95HOST has in a shared session (host-web.js's shape)
  const host = (state, base) => ({
    ...base,
    userName: logon.user,
    shared: { client, session: logon.session, user: logon.user },
    disk: {
      sidBase: state.sidBase,
      load: () => (state.disk ? { ...state.disk, nodes: state.disk.nodes.map(n => (n.dir ? n : { ...n, data: unb64(n.data) })) } : null),
      node: r => send('disk', { op: 'node', ...r }),
      remove: sid => send('disk', { op: 'remove', sid }),
      data: (sid, offset, bytes) => send('disk', { op: 'data', sid, offset, bytes: b64(bytes) }),
      size: (sid, size) => send('disk', { op: 'size', sid, size }),
      label: (label, serial) => send('disk', { op: 'label', label, serial }),
    },
    registry: {
      load: () => (state.registry ? regLoad(state.registry.map(([p, vals, n]) => [p, vals.map(([k, v]) => [k, { type: v.type, data: unb64(v.data) }]), n])) : null),
      op: o => { if (!ownValue(o)) send('reg', regOut(o)); },
    },
  });

  // ---- what others change, applied here; who is here
  let seq = 0, es = null, fs = null, onInput = null, onView = null, lastView = null;
  const people = new Map(), watchers = new Set(), pending = [];
  // another machine's change or input, in the server's order (its own come back too, and are passed over). A change
  // goes to this page's C: or registry: the host's, while this machine is not the host (the host's own machine made the
  // same ones as it applied the input), and another person's HKCU. Input goes to this machine as its own person's
  // would. Before Windows has started here changes wait (`pending`) until `ready` gives the file system; input before
  // then is none of this machine's. One numbered past the next expected means some were missed (the connection
  // dropped): the events are opened again from the last one applied, and the server sends the rest in order
  const apply = m => {
    if (m.seq && seq && m.seq > seq + 1) { catchUp(); return; }
    if (m.seq && m.seq <= seq) return;   // (one already applied, sent again)
    seq = Math.max(seq, m.seq || 0);
    if (m.client !== client) deliver(m);
  };
  const deliver = m => {
    if (m.kind === 'input') { if (fs && onInput) { try { onInput(m.op, m.client); } catch (e) { console.warn('[shared] an input could not be applied:', e && e.message); } } return; }
    if (!fs) { pending.push(m); return; }
    if (m.kind === 'disk') { if (hostId !== client && m.client === hostId) fs.applyStore('C', m.op.op === 'data' ? { ...m.op, bytes: unb64(m.op.bytes) } : m.op); }
    else if (m.kind === 'reg' && window.W95Win32 && !ownValue(m.op) && (m.client === hostId || !m.op.path.startsWith(me()))) window.W95Win32.regApply(regIn(m.op), 'remote');
  };
  const catchUp = () => { if (es) { try { es.close(); } catch (_) { /* gone */ } es = null; } listen(); };
  const roster = (list, host) => {
    people.clear();
    for (const p of list || []) { if (p.host) host = p.client; if (p.client !== client) people.set(p.client, p); }
    hostIs(host);
    for (const f of watchers) f([...people.values()]);
  };
  // the session's events: who is here (and where their pointers are), each change in order; a reconnect asks for the
  // changes since the last one seen, or the server says to load the state again ('reload')
  const listen = () => {
    if (!window.EventSource) return;
    es = new window.EventSource(url(`events?client=${encodeURIComponent(client)}&user=${encodeURIComponent(logon.user)}&since=${seq}`));
    es.addEventListener('people', e => { try { roster(JSON.parse(e.data).people); } catch (_) { /* a bad message */ } });
    es.addEventListener('op', e => { try { apply(JSON.parse(e.data)); } catch (err) { console.warn('[shared] a change could not be applied:', err && err.message); } });
    es.addEventListener('view', e => { try { const v = JSON.parse(e.data); if (v.client !== client) { lastView = v; if (onView) onView(v.view, v.seq); } } catch (_) { /* a bad message */ } });
    es.addEventListener('reload', () => { quiet = true; location.reload(); });
    es.onerror = () => { if (es.readyState === 2) { es = null; setTimeout(listen, 2000); } };   // (closed for good: open again)
  };

  // ---- this person's pointer, to the others (at most ten times a second, the last position sent)
  let ptr = null, ptrTimer = 0;
  const pointer = (x, y) => {
    ptr = { x: Math.round(x), y: Math.round(y) };
    if (ptrTimer) return;
    ptrTimer = setTimeout(() => {
      ptrTimer = 0; const p = ptr; if (!p) return;
      fetch(url('pointer'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, ...p }) }).catch(() => {});
    }, 100);
  };

  // ---- the start: the session's state, synchronously as the page's store loads before Windows starts (null: no server
  // answered, and the page runs on its own store)
  const fetchState = () => {
    try {
      const x = new XMLHttpRequest(); x.open('GET', url('state'), false); x.send();
      return x.status === 200 ? JSON.parse(x.responseText) : null;
    } catch (_) { return null; }
  };
  const start = base => {
    const state = fetchState(); if (!state) return null;
    seq = state.seq || 0; screen = state.screen || null;
    listen();
    return { ...host(state, base), screen };
  };
  // ---- the session's screen: the one every machine in it has, so a point on one is the same point on every other's.
  // The first machine's (its page's size) when the session has none yet
  let screen = null;
  const screenFor = (w, h) => {
    if (screen) return screen;
    screen = { w, h };
    fetch(url('screen'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ w, h }) })
      .then(r => r.json()).then(s => { if (s && s.w) screen = s; }).catch(() => {});
    return screen;
  };
  // ---- this person's input, applied here at once and sent for every other machine to apply as its own (nothing waits
  // for the server); the host's windows after the inputs it has applied, for the others to align with
  const input = ev => send('input', ev);
  let viewTimer = 0, viewWanted = null;
  const view = v => {
    if (hostId !== client) return;
    viewWanted = v; if (viewTimer) return;
    viewTimer = setTimeout(() => {
      viewTimer = 0; const body = JSON.stringify({ client, seq, view: viewWanted });
      fetch(url('view'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
    }, 150);
  };
  /** Windows has started here: the changes that came meanwhile are applied now */
  const ready = files => { fs = files; for (const m of pending.splice(0)) deliver(m); };

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
    wanted, start, ready, logon, client, ownSession, remember, logOff, goLocal, pointer, input, view, screenFor,
    people: () => [...people.values()], watch: f => { watchers.add(f); return () => watchers.delete(f); },
    seq: () => seq, isHost: () => hostId === client, host: () => hostId,
    onInput: f => { onInput = f; }, onView: f => { onView = f; if (f && lastView) f(lastView.view, lastView.seq); },
  };
})();