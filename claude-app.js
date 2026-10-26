// CLAUDE.DLL, the Claude program's own library (CLAUDE.EXE imports it; tools/build_claude.py), implemented here as the
// system's other stand-ins are (shell32.js). Start makes the program's window with the system's USER32: the menu bar
// (File, Model, Effort, Help), the sessions at the left, the conversation, and the prompt with Send under it, the
// session's model and state at the foot. Its window procedure is WndProc: Send (or Enter, which IsDialogMessage turns
// into IDOK) puts the prompt in the session and asks the Claude API for the reply through the page's server
// (tools/serve.py /__claude), and the reply comes into the conversation as it arrives, shown on the window's timer. The
// sessions are the records the scripting API keeps (ccd.js: HKCU\Software\Claude\Code).
(() => {
  if (typeof importScripts !== 'function' || !self.W95Win32) return;   // (the system's machine's worker only)
  const { def, regGet, regSet } = self.W95Win32, FS = self.W95FS;
  const KEY = 'hkcu\\software\\claude\\code';
  const WM = { DESTROY: 2, SIZE: 5, SETFONT: 0x30, COMMAND: 0x111, TIMER: 0x113, CLOSE: 0x10 };
  const ID = { SESSIONS: 101, CONVO: 102, PROMPT: 103, SEND: 104, STATUS: 105, NEW: 201, EXIT: 202, ABOUT: 401 };
  const MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1']];
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const app = { hwnd: 0, kid: {}, menu: 0, shown: null, dirty: false, bufs: new Map() };

  // ---------------------------------------------------------------- the sessions (the scripting API's records)
  const load = () => { const v = regGet(KEY, 'sessions'); if (!v) return []; try { return JSON.parse(typeof v === 'string' ? v : FS.decode(v.data).replace(/\0.*$/, '')); } catch (_) { return []; } };
  const save = list => regSet(KEY, 'sessions', { type: 1, data: FS.encode(JSON.stringify(list) + '\0') });
  const sessions = () => load().filter(s => !s.archived);
  const id = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const fresh = () => ({ id: id('local'), title: 'New session', name: 'new-session', state: 'idle', archived: false, pinned: false, unread: false, group: null, startedBy: null,
    created: Date.now(), active: Date.now(), model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'default', outputStyle: 'default', fastMode: 'off',
    remoteControlState: 'off', cwd: 'C:\\', transcript: [], plan: [], chapters: [], next: null, view: 'normal', connectorsOff: [] });
  const update = (sid, f) => { const list = load(), s = list.find(x => x.id === sid); if (s) { f(s); s.active = Date.now(); save(list); } return s; };
  const current = () => { const l = sessions(); return l.find(s => s.id === app.shown) || l[0] || null; };

  // ---------------------------------------------------------------- the system's functions, called as the program calls them
  const fn = (p, dll, nm) => { const m = p.byName.get(dll); return m && m.exports.get(nm); };
  const U = (p, nm, args) => p.call(fn(p, 'USER32', nm), args);
  const ansi = s => String(s).replace(/\r?\n/g, '\r\n').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/[^\x00-\xff]/g, '?');
  // a string in the program's memory, one buffer per use, grown as the text grows
  const sz = (p, use, s) => {
    s = ansi(s); let b = app.bufs.get(use);
    if (!b || b.cap < s.length + 1) { if (b) p.free(b.at); b = { cap: Math.max(256, s.length + 1 + (s.length >> 1)), at: 0 }; b.at = p.alloc(b.cap); app.bufs.set(use, b); }
    p.writeA(b.at, s); return b.at;
  };
  const text = (p, h, use, s) => U(p, 'SetWindowTextA', [h, sz(p, use, s)]);

  // ---------------------------------------------------------------- what the window shows
  const modelName = m => (MODELS.find(x => x[0] === m) || [m, m])[1];
  const convo = s => {
    if (!s) return 'Choose File > New Session to start.';
    const lines = [];
    for (const m of s.transcript) {
      if (m.role === 'user') lines.push(`You:\n${m.text}`);
      else if (m.role === 'assistant' && m.text) lines.push(`Claude:\n${m.text}`);
      else if (m.role === 'tool') lines.push(`  > ${m.text}`);
      else if (m.role === 'chapter') lines.push(`--- ${m.text} ---`);
      else if (m.role === 'system') lines.push(`[${m.text}]`);
    }
    if (s.state === 'working') lines.push('Claude is thinking...');
    return lines.join('\n\n') || 'Type a message below and press Send.';
  };
  const status = s => (s ? `${modelName(s.model)}  \u00b7  ${s.effort[0].toUpperCase()}${s.effort.slice(1)} effort  \u00b7  ${s.state === 'working' ? 'Working' : s.state === 'failed' ? 'Not connected' : 'Ready'}` : '');
  function showSessions(p) {
    const lb = app.kid[ID.SESSIONS], l = sessions(); U(p, 'SendMessageA', [lb, 0x184, 0, 0]);   // LB_RESETCONTENT
    l.forEach(s => U(p, 'SendMessageA', [lb, 0x180, 0, sz(p, 'item', s.title)]));                 // LB_ADDSTRING
    const k = l.findIndex(s => s.id === (current() || {}).id); if (k >= 0) U(p, 'SendMessageA', [lb, 0x186, k, 0]);   // LB_SETCURSEL
  }
  function showConvo(p) {
    const s = current(), e = app.kid[ID.CONVO], t = ansi(convo(s));
    text(p, e, 'convo', t); U(p, 'SendMessageA', [e, 0xB1, t.length, t.length]); U(p, 'SendMessageA', [e, 0xB7, 0, 0]);   // EM_SETSEL, EM_SCROLLCARET: the end in view
    text(p, app.kid[ID.STATUS], 'status', status(s));
    const title = s ? `${s.title} - Claude` : 'Claude'; text(p, app.hwnd, 'title', title);
    for (const [m] of MODELS) U(p, 'CheckMenuItem', [app.menu, 300 + MODELS.findIndex(x => x[0] === m), s && s.model === m ? 8 : 0]);
    EFFORTS.forEach((ef, i) => U(p, 'CheckMenuItem', [app.menu, 310 + i, s && s.effort === ef ? 8 : 0]));
  }
  function layout(p, w, h) {
    if (!app.kid[ID.SEND]) return;
    const L = 160, pad = 6, foot = 20, row = 24, mv = (k, x, y, cw, ch) => U(p, 'MoveWindow', [app.kid[k], x, y, Math.max(0, cw), Math.max(0, ch), 1]);
    mv(ID.SESSIONS, pad, pad, L - pad, h - 2 * pad - foot);
    mv(ID.CONVO, L + pad, pad, w - L - 2 * pad, h - 3 * pad - row - foot);
    mv(ID.PROMPT, L + pad, h - pad - row - foot, w - L - 3 * pad - 75, row);
    mv(ID.SEND, w - pad - 75, h - pad - row - foot, 75, row);
    mv(ID.STATUS, pad, h - foot + 2, w - 2 * pad, foot - 4);
  }

  // ---------------------------------------------------------------- the app's tools, which run on the page (ccd.js)
  const pending = new Map(); let nextCall = 1, toolDefs = null;
  self.W95ClaudeReply = m => { const f = pending.get(m.id); if (f) { pending.delete(m.id); f(m); } };
  const page = (name, args, session) => new Promise(ok => { const k = nextCall++; pending.set(k, ok); post({ t: 'ccd', id: k, name, args, session }); });

  // ---------------------------------------------------------------- the reply: the Claude API through the page's server
  // The conversation as the API takes it: each turn's blocks as they came (thinking and tool use, unchanged), the user's
  // text, and the tools' results as the user's turn after them
  const blocksOf = m => m.blocks || (m.text ? [{ type: 'text', text: m.text }] : []);
  function history(s) {
    const out = [];
    for (const m of s.transcript) {
      const role = m.role === 'user' || m.role === 'results' ? 'user' : m.role === 'assistant' && !m.box ? 'assistant' : null;
      const b = role ? blocksOf(m) : []; if (!b.length) continue;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...b); else out.push({ role, content: b.slice() });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }
  // one request: Claude's text into the conversation as it arrives; its whole message kept with it for the next request
  async function ask(sid, s) {
    let got = '', msgId = null, result = null;
    const put = (blocks) => update(sid, x => {
      if (!msgId) { msgId = id('msg'); x.transcript.push({ uuid: msgId, t: Date.now(), role: 'assistant', text: got }); }
      const m = x.transcript.find(y => y.uuid === msgId); if (m) { m.text = got; if (blocks) m.blocks = blocks; }
    });
    try {
      const r = await fetch('__claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: s.model, effort: s.effort, messages: history(s), tools: toolDefs || [] }) });
      if (!r.ok) return { error: `Not connected: this page's server has no Claude API (HTTP ${r.status}).` };
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
          const ev = JSON.parse(buf.slice(0, i));
          if (ev.t === 'text') { got += ev.d; put(); app.dirty = true; }
          else if (ev.t === 'error') return { error: ev.e };
          else if (ev.t === 'done') { put(ev.content); result = { stop: ev.stop, content: ev.content || [] }; }
        }
      }
    } catch (e) { return { error: `Not connected: ${e.message}` }; }
    return result || { error: 'The reply ended early.' };
  }
  // the turn: requests until Claude stops asking for tools; each tool it asks for run on the page as this session's call
  async function reply(sid) {
    let failed = null;
    if (!toolDefs) { const r = await page('@defs'); toolDefs = r.result || []; }
    for (let k = 0; k < 24; k++) {
      const s = load().find(x => x.id === sid); if (!s) return;
      const r = await ask(sid, s);
      if (r.error) { failed = r.error; break; }
      if (r.stop !== 'tool_use') break;
      const results = [];
      for (const b of r.content.filter(x => x.type === 'tool_use')) {
        const out = await page(b.name, b.input, sid);
        results.push({ type: 'tool_result', tool_use_id: b.id, content: out.error ? `Error: ${out.error}` : typeof out.result === 'string' ? out.result : JSON.stringify(out.result === undefined ? null : out.result), ...(out.error ? { is_error: true } : {}) });
        app.dirty = true;
      }
      update(sid, x => x.transcript.push({ uuid: id('msg'), t: Date.now(), role: 'results', text: '', blocks: results }));
    }
    update(sid, x => { if (failed) x.transcript.push({ uuid: id('msg'), t: Date.now(), role: 'system', text: failed }); x.state = failed ? 'failed' : x.next && x.next.blocked ? 'waiting' : 'idle'; });
    app.dirty = true;
  }
  function send(p) {
    const e = app.kid[ID.PROMPT], b = sz(p, 'prompt-in', ' '.repeat(4096));
    U(p, 'GetWindowTextA', [e, b, 4096]); const t = p.readA(b).trim(); if (!t) return;
    text(p, e, 'prompt-clear', '');
    let s = current(); if (!s) { const l = load(); s = fresh(); l.push(s); save(l); app.shown = s.id; }
    update(s.id, x => { x.transcript.push({ uuid: id('msg'), t: Date.now(), role: 'user', text: t }); x.state = 'working'; if (x.title === 'New session') x.title = t.slice(0, 48); });
    showSessions(p); showConvo(p); reply(s.id);
  }
  function newSession(p) { const l = load(), s = fresh(); l.push(s); save(l); app.shown = s.id; showSessions(p); showConvo(p); }

  // ---------------------------------------------------------------- the program's entry and its window procedure
  // Start(wndproc): the window, of a class whose procedure is the program's own (CLAUDE.EXE's WndProc, which asks Handle)
  def('CLAUDE', 'Start', 1, function (wndproc) {
    const p = this, inst = p.call(p.thunkFor('KERNEL32', 'GetModuleHandleA'), [0]);   // (the program's instance, as it asks for it)
    const cls = sz(p, 'class', 'ClaudeWindow'), wc = p.alloc(40);
    for (const [o, v] of [[0, 3], [4, wndproc], [8, 0], [12, 0], [16, inst], [20, U(p, 'LoadIconA', [0, 32512])], [24, U(p, 'LoadCursorA', [0, 32512])], [28, 16], [32, 0], [36, cls]]) p.w32(wc + o, v);
    U(p, 'RegisterClassA', [wc]);
    // the menu bar
    const bar = U(p, 'CreateMenu', []), pop = items => { const m = U(p, 'CreatePopupMenu', []); for (const [i, l] of items) U(p, 'AppendMenuA', [m, l ? 0 : 0x800, i, l ? sz(p, `menu${i}`, l) : 0]); return m; };
    const sub = (m, l) => U(p, 'AppendMenuA', [bar, 0x10, m, sz(p, `bar-${l}`, l)]);
    sub(pop([[ID.NEW, '&New Session\tCtrl+N'], [0, null], [ID.EXIT, 'E&xit']]), '&File');
    sub(pop(MODELS.map(([, n], i) => [300 + i, n])), '&Model');
    sub(pop(EFFORTS.map((e, i) => [310 + i, `${e[0].toUpperCase()}${e.slice(1)}`])), '&Effort');
    sub(pop([[ID.ABOUT, '&About Claude']]), '&Help');
    app.menu = bar;
    const h = U(p, 'CreateWindowExA', [0, cls, sz(p, 'title', 'Claude'), 0x10CF0000, 0x80000000, 0x80000000, 560, 400, 0, bar, inst, 0]);
    if (!h) return 0;
    app.hwnd = h;
    const font = fn(p, 'GDI32', 'GetStockObject') ? p.call(fn(p, 'GDI32', 'GetStockObject'), [17]) : 0;   // DEFAULT_GUI_FONT
    const kid = (k, c, ex, style, t) => {
      const w = U(p, 'CreateWindowExA', [ex, sz(p, `cls-${c}`, c), sz(p, `text-${k}`, t || ''), 0x50000000 | style, 0, 0, 10, 10, h, k, inst, 0]);
      if (font) U(p, 'SendMessageA', [w, WM.SETFONT, font, 0]); app.kid[k] = w; return w;
    };
    kid(ID.SESSIONS, 'LISTBOX', 0x200, 0x00200000 | 0x100 | 1 | 0x10000);           // WS_VSCROLL, LBS_NOINTEGRALHEIGHT, LBS_NOTIFY, WS_TABSTOP
    kid(ID.CONVO, 'EDIT', 0x200, 0x00200000 | 4 | 0x800 | 0x40);                     // WS_VSCROLL, ES_MULTILINE, ES_READONLY, ES_AUTOVSCROLL
    kid(ID.PROMPT, 'EDIT', 0x200, 0x80 | 0x10000);                                   // ES_AUTOHSCROLL, WS_TABSTOP
    kid(ID.SEND, 'BUTTON', 0, 1 | 0x10000, '&Send');                                 // BS_DEFPUSHBUTTON, WS_TABSTOP
    kid(ID.STATUS, 'STATIC', 0, 0);
    const rc = p.alloc(16); U(p, 'GetClientRect', [h, rc]); layout(p, p.r32(rc + 8), p.r32(rc + 12)); p.free(rc);
    app.shown = (current() || {}).id || null; showSessions(p); showConvo(p);
    U(p, 'SetTimer', [h, 1, 150, 0]);   // (the reply arrives between the program's messages: shown on the timer)
    U(p, 'SetFocus', [app.kid[ID.PROMPT]]);
    return h;
  });
  // Handle(hwnd, msg, wp, lp, &result): 1 with the result written for a message that is Claude's, else 0 (the program's
  // WndProc passes those to DefWindowProcA itself). Nothing here waits on messages of its own (no DefWindowProcA, no
  // MessageBoxA: a call from here runs to its end without giving the processor back)
  def('CLAUDE', 'Handle', 5, function (h, msg, wp, lp, res) {
    const p = this, done = (v = 0) => { p.w32(res, v); return 1; };
    if (h !== app.hwnd) return 0;
    if (msg === WM.SIZE) { layout(p, lp & 0xffff, lp >>> 16); return done(); }
    if (msg === WM.TIMER) { if (app.dirty) { app.dirty = false; showConvo(p); showSessions(p); } return done(); }
    if (msg === WM.DESTROY) { U(p, 'KillTimer', [h, 1]); app.hwnd = 0; app.kid = {}; U(p, 'PostQuitMessage', [0]); return done(); }
    if (msg !== WM.COMMAND) return 0;
    const c = wp & 0xffff, note = wp >>> 16;
    if (c === ID.SEND || c === 1) { send(p); return done(); }                         // (IDOK: Enter in the prompt)
    if (c === ID.NEW) { newSession(p); return done(); }
    if (c === ID.EXIT) { U(p, 'PostMessageA', [h, WM.CLOSE, 0, 0]); return done(); }
    if (c === ID.ABOUT) { text(p, app.kid[ID.STATUS], 'status', 'Claude for Windows 95: the Claude desktop app, as a program of the system.'); return done(); }
    if (c >= 300 && c < 300 + MODELS.length) { const s = current(); if (s) update(s.id, x => { x.model = MODELS[c - 300][0]; }); showConvo(p); return done(); }
    if (c >= 310 && c < 310 + EFFORTS.length) { const s = current(); if (s) update(s.id, x => { x.effort = EFFORTS[c - 310]; }); showConvo(p); return done(); }
    if (c === ID.SESSIONS && note === 1) {                                           // LBN_SELCHANGE
      const k = U(p, 'SendMessageA', [app.kid[ID.SESSIONS], 0x188, 0, 0]), s = sessions()[k]; if (s) { app.shown = s.id; showConvo(p); } return done();
    }
    return 0;
  });
})();
