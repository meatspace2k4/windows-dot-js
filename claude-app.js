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
  const ID = { SESSIONS: 101, CONVO: 102, PROMPT: 103, SEND: 104, STATUS: 105, NEXT: 106, ANSWER0: 107, ANSWER1: 108, TASKS: 109,
    PANE0: 110, PANE0_TEXT: 111, PANE1: 112, PANE1_TEXT: 113, CARD: 114, CARD0: 115, CARD1: 116, NEW: 201, EXIT: 202, ABOUT: 401 };
  const MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1']];
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const PANE_TITLE = { terminal: 'Terminal', diff: 'Changes', preview: 'Preview', files: 'Files', side_chat: 'Side Chat', plan: 'Plan', tasks: 'Tasks' };
  const MODES = [['default', 'Ask permissions'], ['acceptEdits', 'Edit automatically'], ['plan', 'Plan mode'], ['auto', 'Auto'], ['bypassPermissions', 'Bypass permissions']];
  const VIEWS = ['normal', 'thinking', 'verbose'], PANES = ['plan', 'diff', 'tasks', 'files'];
  // menu commands past the bar's first ones: models 300+, efforts 310+, modes 320+, views 330+, panes 340+, the rest below
  const CMD = { EXPORT: 203, ATTACH: 204, COPY_REPLY: 210, FORK: 211, REWIND: 212, CHAPTER: 213, FIND: 214, RENAME: 215, USAGE: 402, TERMINAL: 352, STOP: 372, SETTINGS: 205, SUGGEST: 216, SIDEBAR: 350, HIDE_NESTED: 391, CLOSE_PANE: 351, BACK: 360, FORWARD: 361, PREV: 362, NEXT_SESSION: 363, PIN: 370, ARCHIVE: 371,
    CTX_PIN: 501, CTX_UNREAD: 502, CTX_ARCHIVE: 503, CTX_DELETE: 504, CTX_EXPORT: 505, CTX_UNGROUP: 599, CTX_GROUP: 600 };
  const app = { hwnd: 0, kid: {}, menu: 0, shown: null, dirty: false, bufs: new Map(), rows: [], raw: null, rawView: null, size: [560, 400], attach: [], ofn: null, aborts: {}, stopping: {}, queue: {}, nextSay: null };

  // ---------------------------------------------------------------- the sessions (the scripting API's records)
  const load = () => { const v = regGet(KEY, 'sessions'); if (!v) return []; try { return JSON.parse(typeof v === 'string' ? v : FS.decode(v.data).replace(/\0.*$/, '')); } catch (_) { return []; } };
  const save = list => regSet(KEY, 'sessions', { type: 1, data: FS.encode(JSON.stringify(list) + '\0') });
  const sessions = () => load().filter(s => !s.archived);
  const id = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const fresh = () => ({ id: id('local'), title: 'New session', name: 'new-session', state: 'idle', archived: false, pinned: false, unread: false, group: null, startedBy: null,
    created: Date.now(), active: Date.now(), model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'default', outputStyle: 'default', fastMode: 'off',
    remoteControlState: 'off', cwd: 'C:\\', transcript: [], plan: [], chapters: [], next: null, view: 'normal', connectorsOff: [] });
  const update = (sid, f) => { const list = load(), s = list.find(x => x.id === sid); if (s) { f(s); s.active = Date.now(); save(list); } return s; };
  const current = () => { const l = load(); return l.find(s => s.id === app.shown) || l.find(s => !s.archived) || null; };   // (the shown one may be archived: Show Archived)
  // the sidebar's groups and the Claude window's view (its panes, its sidebar), as the app's tools leave them (ccd.js)
  const record = (name, dflt) => { const v = regGet(KEY, name); if (!v) return dflt; try { return JSON.parse(typeof v === 'string' ? v : FS.decode(v.data).replace(/\0.*$/, '')); } catch (_) { return dflt; } };
  const ui = () => (record('view', {}).ui || {});
  const card = s => (s ? record('cards', []).find(c => c.session === s.id && c.buttons && c.buttons.length === 2) : null);   // (its oldest card)
  const setUi = f => { const v = record('view', {}); v.ui = { sidebarCollapsed: false, panes: [], ...(v.ui || {}) }; f(v.ui); regSet(KEY, 'view', { type: 1, data: FS.encode(JSON.stringify(v) + '\0') }); };
  const setView = (k, x) => { const v = record('view', {}); v[k] = x; regSet(KEY, 'view', { type: 1, data: FS.encode(JSON.stringify(v) + '\0') }); };
  const GROUP_BY = [['none', 'None'], ['date', 'Date'], ['state', 'State'], ['project', 'Folder']], SORT_BY = [['recency', 'Recent Activity'], ['alpha', 'Name'], ['created', 'Date Created']],
    STATUS = [['active', '&Active'], ['archived', 'A&rchived'], ['all', 'A&ll']];
  const togglePane = x => setUi(u => { u.panes = u.panes.includes(x) ? u.panes.filter(y => y !== x) : [...u.panes.filter(y => y !== x), x].slice(-2); });
  // the sessions shown, in order, for Back and Forward (as the app's Go menu)
  const nav = { back: [], fwd: [] };
  const go = (sid, how) => { const cur = (current() || {}).id; if (!sid || sid === cur) return; if (how !== 'nav') { nav.back.push(cur); nav.fwd = []; } app.shown = sid; };
  const exportOf = s => { const f = `C:\\My Documents\\${s.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'Session'}.TXT`; return f; };

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
  // the conversation, as the session's transcript view shows it: normal (messages, tool calls, chapters), thinking (its
  // summaries too), verbose (each tool call's input and answer too)
  const convo = s => {
    if (!s) return 'Choose File > New Session to start.';
    const lines = [], view = s.view || 'normal', spans = [];
    let at = 0;   // (where each message is in the text the conversation shows: msgAt)
    const put = (t, k) => { if (lines.length) at += 4; const n = ansi(t).length; if (k !== undefined) spans.push({ k, from: at, to: at + n, head: k === undefined ? 0 : t.indexOf('\n') + 2 }); at += n; lines.push(t); };
    s.transcript.forEach((m, k) => {
      if (m.role === 'user') put(`You:\n${m.text}`, k);
      else if (m.role === 'assistant' && m.text) put(`Claude:\n${m.text}`, k);
      else if (m.role === 'tool') put(`  > ${m.text}${view === 'verbose' && m.detail ? `\n    ${m.detail.replace(/\n/g, '\n    ')}` : ''}`);
      else if (m.role === 'thinking' && view !== 'normal' && m.text) put(`  (thinking) ${m.text}`);
      else if (m.role === 'chapter') put(`---------- ${m.text} ----------`);
      else if (m.role === 'system') put(`[${m.text}]`);
    });
    if (s.state === 'working') put('Claude is thinking...');
    convo.spans = { sid: s.id, spans };
    return lines.join('\n\n') || 'Type a message below and press Send.';
  };
  const modeName = m => (MODES.find(x => x[0] === m) || [m, m])[1];
  const status = s => (s ? `${modeName(s.permissionMode)}  \u00b7  ${modelName(s.model)}  \u00b7  ${s.effort[0].toUpperCase()}${s.effort.slice(1)} effort  \u00b7  ${s.state === 'working' ? 'Working' : s.state === 'waiting' ? 'Waiting for you' : s.state === 'failed' ? 'Not connected' : 'Ready'}  \u00b7  ${s.cwd}` : '');
  // the sessions list as the sidebar lists them: pinned first, each group under its heading, then the rest; a dot for one
  // that is working or unread
  // the sidebar's view (the app's Group and sort: set_view), as the scripting API keeps it
  const sideView = () => ({ group_by: 'none', status: 'active', sort_by: 'recency', last_activity: 0, ...record('view', {}) });
  const DAY = 864e5;
  const dateGroup = t => { const d0 = new Date(); d0.setHours(0, 0, 0, 0); const a = d0.getTime() - t; return t >= d0.getTime() ? 'Today' : a < DAY ? 'Yesterday' : a < 7 * DAY ? 'Previous 7 Days' : a < 30 * DAY ? 'Previous 30 Days' : 'Older'; };
  const stateGroup = s => (s.state === 'working' ? 'Working' : s.state === 'waiting' ? 'Needs input' : s.state === 'failed' ? 'Failed' : 'Idle');
  function rows() {
    const v = sideView(), hide = !!ui().hideNested, all = load(), groups = record('groups', []), out = [];
    const l = all.filter(s => (v.status === 'all' ? true : v.status === 'archived' ? s.archived : !s.archived) && (!v.last_activity || s.pinned || Date.now() - s.active <= v.last_activity * DAY));
    const by = { recency: (a, b) => b.active - a.active, alpha: (a, b) => a.title.localeCompare(b.title), created: (a, b) => b.created - a.created }[v.sort_by] || ((a, b) => b.active - a.active);
    l.sort(by);
    // a session started from another that is listed is nested under it (Hide Nested Sessions leaves it out)
    const listed = new Set(l.map(s => s.id)), kids = s => l.filter(k => k.startedBy === s.id), top = l.filter(s => !s.startedBy || !listed.has(s.startedBy));
    const add = (s, d = '   ') => {
      out.push({ label: `${d}${s.state === 'working' ? '* ' : s.unread ? 'o ' : s.state === 'waiting' ? '? ' : ''}${s.title}`, sid: s.id });
      if (!hide) kids(s).forEach(k => add(k, `${d}   `));
    };
    const pinned = top.filter(s => s.pinned), rest = top.filter(s => !s.pinned);
    if (pinned.length) { out.push({ label: 'Pinned' }); pinned.forEach(s => add(s)); }
    for (const g of groups) { const in_ = rest.filter(s => s.group === g.id); if (in_.length) { out.push({ label: g.name }); in_.forEach(s => add(s)); } }
    const loose = rest.filter(s => !s.group || !groups.some(g => g.id === s.group));
    const head = { date: s => dateGroup(s.active), state: stateGroup, project: s => s.cwd || 'C:\\' }[v.group_by];
    if (!head) { if (loose.length) { out.push({ label: v.status === 'archived' ? 'Archived' : 'Recents' }); loose.forEach(s => add(s)); } return out; }
    const heads = []; for (const s of loose) { const h = head(s); if (!heads.includes(h)) heads.push(h); }
    if (v.group_by === 'date') heads.sort((a, b) => ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'].indexOf(a) - ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'].indexOf(b));
    for (const h of heads) { out.push({ label: h }); loose.filter(s => head(s) === h).forEach(s => add(s)); }
    return out;
  }
  function showSessions(p) {
    const lb = app.kid[ID.SESSIONS]; app.rows = rows(); U(p, 'SendMessageA', [lb, 0x184, 0, 0]);   // LB_RESETCONTENT
    app.rows.forEach((r, i) => U(p, 'SendMessageA', [lb, 0x180, 0, sz(p, `item${i % 8}`, r.label)]));   // LB_ADDSTRING
    const k = app.rows.findIndex(r => r.sid === (current() || {}).id); U(p, 'SendMessageA', [lb, 0x186, k, 0]);   // LB_SETCURSEL
  }
  // a pane's text, as the Claude window's panes show them
  function paneText(p, s) {
    if (!s) return '';
    if (p === 'plan') return s.plan.length ? s.plan.map(t => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.content}`).join('\n') : 'No plan for this session.';
    if (p === 'diff') return (s.changes || []).length ? s.changes.map(c => `${c.op}  ${c.path}`).join('\n') : 'No changes.';
    if (p === 'tasks') { const kids = sessions().filter(x => x.startedBy === s.id); return kids.length ? kids.map(x => `${x.title}  (${x.state})`).join('\n') : 'No sessions started from this one.'; }
    if (p === 'files') return `${s.cwd}`;
    if (p === 'terminal') return 'MS-DOS Prompt runs in its own window.';
    if (p === 'side_chat') return s.transcript.filter(m => m.side).map(m => `${m.role}: ${m.text}`).join('\n') || 'No side chat.';
    return '';
  }
  const shown = (p, k, on) => U(p, 'ShowWindow', [app.kid[k], on ? 5 : 0]);   // SW_SHOW, SW_HIDE
  function showAll(p) {
    const s = current(), v = ui(), e = app.kid[ID.CONVO], t = ansi(convo(s));
    app.raw = regGet(KEY, 'sessions'); app.rawView = regGet(KEY, 'view'); app.rawCards = regGet(KEY, 'cards');
    showSessions(p);
    text(p, e, 'convo', t); U(p, 'SendMessageA', [e, 0xB1, t.length, t.length]); U(p, 'SendMessageA', [e, 0xB7, 0, 0]);   // EM_SETSEL, EM_SCROLLCARET: the end in view
    const sg = s && app.suggestion && app.suggestion.sid === s.id && s.state !== 'working' ? app.suggestion.text : null;
    text(p, app.kid[ID.STATUS], 'status', app.note || (sg ? `Suggested: "${sg}"  (Edit > Use Suggestion)` : status(s))); app.note = null;   // (a note of the program's: once, then the status again)
    text(p, app.hwnd, 'title', s ? `${s.title} - Claude` : 'Claude');
    // the task list, under the conversation
    const tl = app.kid[ID.TASKS]; U(p, 'SendMessageA', [tl, 0x184, 0, 0]);
    ((s && s.plan) || []).forEach((t, i) => U(p, 'SendMessageA', [tl, 0x180, 0, sz(p, `task${i % 8}`, `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.content}`)]));
    // the next-step box: its recap and question, its buttons
    const n = s && s.next;
    text(p, app.kid[ID.NEXT], 'next', n ? `${n.ask ? `${n.ask}\n` : ''}${n.recap}` : '');   // (the question first: the recap may run past the box)
    [ID.ANSWER0, ID.ANSWER1].forEach((k, i) => { const a = n && n.actions && n.actions[i]; if (a) text(p, app.kid[k], `answer${i}`, String(a.label || a.action || 'OK').replace(/&/g, '&&')); });
    // the session's card (a start_session proposal or offer): its title and its two buttons
    const cd = card(s);
    if (cd) { text(p, app.kid[ID.CARD], 'card', `${cd.kind === 'offer' ? 'New task' : 'Suggested task'}: ${cd.title}`); cd.buttons.forEach((b, i) => text(p, app.kid[i ? ID.CARD1 : ID.CARD0], `card${i}`, b)); }
    // the panes, at the right
    const panes = (v.panes || []).filter(x => PANE_TITLE[x]).slice(0, 2);
    panes.forEach((x, i) => { text(p, app.kid[i ? ID.PANE1 : ID.PANE0], `pane${i}`, PANE_TITLE[x]); text(p, app.kid[i ? ID.PANE1_TEXT : ID.PANE0_TEXT], `pane${i}t`, paneText(x, s)); });
    // the menus' checks: the model, the effort, the mode, the view, the sidebar, the panes, the pin; Back and Forward
    const check = (k, on) => U(p, 'CheckMenuItem', [app.menu, k, on ? 8 : 0]), enable = (k, on) => U(p, 'EnableMenuItem', [app.menu, k, on ? 0 : 1]);
    MODELS.forEach(([m], i) => check(300 + i, s && s.model === m));
    EFFORTS.forEach((ef, i) => check(310 + i, s && s.effort === ef));
    MODES.forEach(([m], i) => check(320 + i, s && s.permissionMode === m));
    VIEWS.forEach((x, i) => check(330 + i, s && (s.view || 'normal') === x));
    PANES.forEach((x, i) => check(340 + i, (v.panes || []).includes(x)));
    check(CMD.SIDEBAR, !v.sidebarCollapsed); check(CMD.PIN, s && s.pinned); check(CMD.HIDE_NESTED, v.hideNested);
    const sv = sideView(); GROUP_BY.forEach(([k], i) => check(380 + i, (sv.group_by === 'custom' ? 'none' : sv.group_by) === k));
    SORT_BY.forEach(([k], i) => check(385 + i, sv.sort_by === k)); STATUS.forEach(([k], i) => check(388 + i, sv.status === k));
    enable(CMD.SUGGEST, !!sg); enable(CMD.STOP, s && s.state === 'working'); text(p, app.kid[ID.SEND], 'send', s && s.state === 'working' ? 'S&top' : '&Send');   // (Send is Stop while Claude works; typing queues a message instead)
    enable(CMD.BACK, nav.back.length); enable(CMD.FORWARD, nav.fwd.length); enable(CMD.CLOSE_PANE, (v.panes || []).length);
    U(p, 'DrawMenuBar', [app.hwnd]);
    layout(p, ...app.size);
  }
  // the layout: the sessions (unless the sidebar is collapsed), the conversation, under it the task list and the next-step
  // box when the session has them, the prompt and Send, the status line; the panes at the right
  function layout(p, w, h) {
    app.size = [w, h];
    if (!app.kid[ID.SEND]) return;
    const s = current(), v = ui(), n = s && s.next, plan = (s && s.plan) || [], panes = (v.panes || []).filter(x => PANE_TITLE[x]).slice(0, 2);
    const pad = 6, foot = 20, row = 24, L = v.sidebarCollapsed ? 0 : 160, P = panes.length ? Math.min(220, Math.floor(w / 3)) : 0;
    const x0 = L + pad, cw = w - x0 - pad - (P ? P + pad : 0);
    const mv = (k, x, y, ww, hh) => U(p, 'MoveWindow', [app.kid[k], x, y, Math.max(0, ww), Math.max(0, hh), 1]);
    shown(p, ID.SESSIONS, !v.sidebarCollapsed); if (!v.sidebarCollapsed) mv(ID.SESSIONS, pad, pad, L - pad, h - 2 * pad - foot);
    let y = h - foot - pad - row;
    mv(ID.PROMPT, x0, y, cw - 75 - pad, row); mv(ID.SEND, x0 + cw - 75, y, 75, row);
    const bh = n ? 56 : 0, nh = n ? bh + (n.actions ? 27 : 0) : 0;   // (the box: four lines of recap and question; its buttons under it)
    shown(p, ID.NEXT, !!n); [ID.ANSWER0, ID.ANSWER1].forEach((k, i) => shown(p, k, !!(n && n.actions && n.actions[i])));
    if (n) {
      y -= nh + pad; mv(ID.NEXT, x0, y, cw, bh);
      const k = (n.actions || []).length, bw = Math.min(106, Math.floor((cw - 6 * (k - 1)) / Math.max(1, k)));   // (narrower in a narrow column)
      (n.actions || []).forEach((a, i) => mv(i ? ID.ANSWER1 : ID.ANSWER0, x0 + cw - (k - i) * (bw + 6) + 6, y + bh + 4, bw, 23));
    }
    const cd = card(s); [ID.CARD, ID.CARD0, ID.CARD1].forEach(k => shown(p, k, !!cd));
    if (cd) {   // (the card's title across the column, its buttons under it at the right)
      y -= 18 + 4 + 23 + pad; const bw = Math.min(90, Math.floor((cw - 6) / 2));
      mv(ID.CARD, x0, y, cw, 18); mv(ID.CARD0, x0 + cw - 2 * bw - 6, y + 22, bw, 23); mv(ID.CARD1, x0 + cw - bw, y + 22, bw, 23);
    }
    const th = plan.length ? Math.min(98, plan.length * 13 + 6) : 0;
    shown(p, ID.TASKS, !!plan.length); if (plan.length) { y -= th + pad; mv(ID.TASKS, x0, y, cw, th); }
    mv(ID.CONVO, x0, pad, cw, y - 2 * pad);
    [[ID.PANE0, ID.PANE0_TEXT], [ID.PANE1, ID.PANE1_TEXT]].forEach(([tk, ek], i) => {
      const on = i < panes.length; shown(p, tk, on); shown(p, ek, on); if (!on) return;
      const ph = Math.floor((h - foot - pad) / panes.length), py = pad + i * ph, px = w - P - pad;
      mv(tk, px, py, P, 16); mv(ek, px, py + 18, P, ph - 18 - pad);
    });
    mv(ID.STATUS, pad, h - foot + 2, w - 2 * pad, foot - 4);
  }

  // ---------------------------------------------------------------- the app's tools, which run on the page (ccd.js)
  const pending = new Map(); let nextCall = 1, toolDefs = null;
  self.W95ClaudeReply = m => { const f = pending.get(m.id); if (f) { pending.delete(m.id); f(m); } };
  const page = (name, args, session) => new Promise(ok => { const k = nextCall++; pending.set(k, ok); post({ t: 'ccd', id: k, name, args, session }); });
  // a tool's question (an approval): asked one at a time in the program's message box (CLAUDE.EXE's WndProc on WM_APP+1),
  // posted from the window's timer; with no window to ask in, the answer is No
  const asks = []; let asking = null;
  self.W95ClaudeAsk = m => { if (!app.hwnd) post({ t: 'ccdAnswer', id: m.id, yes: false }); else asks.push(m); };
  // Opened(chosen): the Open dialog's answer (CLAUDE.EXE's WndProc on WM_APP+3): the file chosen is read (C: only, as the
  // files tools read) and attached to the next prompt
  def('CLAUDE', 'Opened', 1, function (r) {
    const o = app.ofn; app.ofn = null; if (!o) return 0;
    const path = this.readA(o.file); this.free(o.at); this.free(o.file); if (!r || !path) return 0;
    page('@readC', { path }).then(out => {
      if (out.error) app.note = `Not attached: ${out.error}`;
      else { app.attach.push({ path, text: String(out.result) }); app.note = `Attached ${path} to the next message (${app.attach.length} file${app.attach.length === 1 ? '' : 's'}).`; }
      app.dirty = true;
    });
    return 0;
  });
  // a dialog template (DLGTEMPLATE, its items DLGITEMTEMPLATE: [style, class atom, x, y, cx, cy, id, text]) in the
  // program's memory, in dialog units, with the system's 8-point MS Sans Serif
  function dialogTemplate(p, title, cx, cy, items) {
    const b = [], w16 = v => b.push(v & 0xff, (v >> 8) & 0xff), w32 = v => { w16(v & 0xffff); w16((v >>> 16) & 0xffff); }, str = s => { for (const ch of s) w16(ch.charCodeAt(0)); w16(0); }, align = () => { while (b.length & 3) b.push(0); };
    w32(0x80C800C0); w32(0); w16(items.length); w16(0); w16(0); w16(cx); w16(cy);   // WS_POPUP|WS_CAPTION|WS_SYSMENU|DS_MODALFRAME|DS_SETFONT
    w16(0); w16(0); str(title); w16(8); str('MS Sans Serif');
    for (const [style, cls, x, y, ix, iy, id_, t] of items) { align(); w32(style); w32(0); w16(x); w16(y); w16(ix); w16(iy); w16(id_ & 0xffff); w16(0xffff); w16(cls); str(t); w16(0); }
    const at = p.alloc(b.length + 4); p.u8.set(b, at); return at;
  }
  def('CLAUDE', 'RenameProc', 4, function (h, msg, wp) {
    const p = this, s = load().find(x => x.id === app.renaming);
    if (msg === 0x110) {   // WM_INITDIALOG: the session's name, selected
      U(p, 'SetDlgItemTextA', [h, 100, sz(p, 'rename', s ? s.title : '')]);
      return 1;   // (the focus to the first control that takes it, the name, its text selected)
    }
    if (msg !== 0x111) return 0;
    const id_ = wp & 0xffff;
    if (id_ === 1) {
      const b = sz(p, 'rename-in', ' '.repeat(256)); U(p, 'GetDlgItemTextA', [h, 100, b, 256]); const t = p.readA(b).trim();
      if (t && s) { update(s.id, x => { x.title = t.slice(0, 80); }); app.dirty = true; }
    }
    if (id_ === 1 || id_ === 2) { app.renaming = null; U(p, 'EndDialog', [h, id_ === 1 ? 1 : 0]); return 1; }
    return 0;
  });
  // Settings: the app's settings a Windows 95 session acts on, each a check box (all or none for a notification); the
  // days after which an inactive session is archived. OK sets the ones changed through set_setting, which asks as the
  // app asks
  const SETTING_BOXES = [['task_complete_notifications', 'Notify me when a session &finishes'], ['question_notifications', 'Notify me when a session asks a &question'],
    ['permission_request_notifications', 'Notify me when a session asks for &permission'], ['notification_sound', '&Beep with a notification'],
    ['draw_attention_on_notifications', 'F&lash the taskbar button with a notification'], ['keep_awake_while_working', 'Hold off the screen &saver while a session works'],
    ['prompt_suggestions', 'Suggest a &next prompt when a turn ends']];
  const on = v => v === true || v === 'all';
  function settingsTemplate(p) {
    const items = SETTING_BOXES.map(([, l], i) => [0x50010003, 0x0080, 10, 8 + 12 * i, 210, 10, 200 + i, l]);   // BS_AUTOCHECKBOX, WS_TABSTOP
    const y = 8 + 12 * SETTING_BOXES.length + 6;
    items.push([0x50000000, 0x0082, 10, y + 2, 140, 8, -1, '&Archive sessions inactive (days, 0: never):'], [0x50812080, 0x0081, 160, y, 30, 12, 300, ''],   // ES_NUMBER
      [0x50010001, 0x0080, 116, y + 22, 50, 14, 1, 'OK'], [0x50010000, 0x0080, 170, y + 22, 50, 14, 2, 'Cancel']);
    return dialogTemplate(p, 'Claude Settings', 230, y + 42, items);
  }
  def('CLAUDE', 'SettingsProc', 4, function (h, msg, wp) {
    const p = this, cur = app.settingsNow || {};
    if (msg === 0x110) {
      SETTING_BOXES.forEach(([k], i) => U(p, 'CheckDlgButton', [h, 200 + i, on((cur[k] || {}).value) ? 1 : 0]));
      U(p, 'SetDlgItemInt', [h, 300, (cur.auto_archive_inactive_days || {}).value || 0, 0]);
      return 1;
    }
    if (msg !== 0x111) return 0;
    const id_ = wp & 0xffff;
    if (id_ === 1) {
      const changes = [];
      SETTING_BOXES.forEach(([k], i) => {
        const was = (cur[k] || {}).value, now = U(p, 'IsDlgButtonChecked', [h, 200 + i]) === 1;
        if (on(was) !== now) changes.push([k, typeof was === 'string' ? (now ? 'all' : 'none') : now]);
      });
      const days = U(p, 'GetDlgItemInt', [h, 300, 0, 0]); if (days !== ((cur.auto_archive_inactive_days || {}).value || 0)) changes.push(['auto_archive_inactive_days', days]);
      (async () => { for (const [key, value] of changes) { const r = await page('ccd_settings__set_setting', { key, value }, (current() || {}).id); if (r.error) app.note = `Not changed: ${r.error}`; } app.dirty = true; })();
    }
    if (id_ === 1 || id_ === 2) { app.settingsOpen = false; U(p, 'EndDialog', [h, id_ === 1 ? 1 : 0]); return 1; }
    return 0;
  });
  def('CLAUDE', 'Answer', 1, function (r) { if (asking) post({ t: 'ccdAnswer', id: asking.id, yes: r === 6 }); asking = null; return 0; });   // (IDYES)

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
    let got = '', msgId = null, result = null, thought = '', thId = null;
    // (the thinking's summary, in the conversation before the reply: shown in the Thinking and Verbose views)
    const think = () => update(sid, x => {
      if (!thId) { thId = id('msg'); x.transcript.push({ uuid: thId, t: Date.now(), role: 'thinking', text: thought }); }
      const m = x.transcript.find(y => y.uuid === thId); if (m) m.text = thought;
    });
    const put = (blocks) => update(sid, x => {
      if (!msgId) { msgId = id('msg'); x.transcript.push({ uuid: msgId, t: Date.now(), role: 'assistant', text: got }); }
      const m = x.transcript.find(y => y.uuid === msgId); if (m) { m.text = got; if (blocks) m.blocks = blocks; }
    });
    try {
      const r = await fetch('__claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: s.model, effort: s.effort, messages: history(s), tools: toolDefs || [] }), signal: (app.aborts[sid] = new AbortController()).signal });
      if (!r.ok) return { error: `Not connected: this page's server has no Claude API (HTTP ${r.status}).` };
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
          const ev = JSON.parse(buf.slice(0, i));
          if (ev.t === 'text') { got += ev.d; put(); app.dirty = true; }
          else if (ev.t === 'thinking') { thought += ev.d; think(); app.dirty = true; }
          else if (ev.t === 'error') return { error: ev.e };
          else if (ev.t === 'done') {
            // (a message whose content came back empty while text streamed, or one stopped short: kept as text, and said)
            const content = ev.content && ev.content.length ? ev.content : null;
            put(content); update(sid, x => {
              const m = x.transcript.find(y => y.uuid === msgId); if (m) { m.stop = ev.stop; m.model = ev.model; }
              const u = x.usage = x.usage || {}; u.in = (u.in || 0) + (ev.in || 0); u.out = (u.out || 0) + (ev.out || 0); u.context = (ev.in || 0) + (ev.out || 0); u.requests = (u.requests || 0) + 1;   // (Help > Usage, get_usage)
            });
            if (!content || !['end_turn', 'tool_use', 'pause_turn'].includes(ev.stop)) update(sid, x => x.transcript.push({ uuid: id('msg'), t: Date.now(), role: 'system', text: `The reply stopped short (${ev.stop || 'no content'}${ev.model ? `, ${ev.model}` : ''}).` }));
            result = { stop: ev.stop, content: content || [] };
          }
        }
      }
    } catch (e) { return e.name === 'AbortError' ? { stopped: true } : { error: `Not connected: ${e.message}` }; }
    return result || { error: 'The reply ended early.' };
  }
  // the turn: requests until Claude stops asking for tools; each tool it asks for run on the page as this session's call
  async function reply(sid) {
    let failed = null;
    if (!toolDefs) { const r = await page('@defs'); toolDefs = r.result || []; }
    for (let k = 0; k < 24; k++) {
      const s = load().find(x => x.id === sid); if (!s) return;
      const r = await ask(sid, s);
      if (r.stopped) break;
      if (r.error) { failed = r.error; break; }
      if (r.stop !== 'tool_use') break;
      const results = [];
      for (const b of r.content.filter(x => x.type === 'tool_use')) {
        // (stopped between tools: the rest are answered as not run, so the conversation stays one the API takes)
        const out = app.stopping[sid] ? { error: 'Not run: the user stopped the turn.' } : await page(b.name, b.input, sid);
        results.push({ type: 'tool_result', tool_use_id: b.id, content: out.error ? `Error: ${out.error}` : typeof out.result === 'string' ? out.result : JSON.stringify(out.result === undefined ? null : out.result), ...(out.error ? { is_error: true } : {}) });
        app.dirty = true;
      }
      update(sid, x => x.transcript.push({ uuid: id('msg'), t: Date.now(), role: 'results', text: '', blocks: results }));
      if (app.stopping[sid]) break;
    }
    const stopped = !!app.stopping[sid]; delete app.stopping[sid]; delete app.aborts[sid];
    const fin = update(sid, x => {
      if (failed) x.transcript.push({ uuid: id('msg'), t: Date.now(), role: 'system', text: failed });
      if (stopped) x.transcript.push({ uuid: id('msg'), t: Date.now(), role: 'system', text: 'Stopped.' });
      x.state = failed ? 'failed' : x.next && x.next.blocked ? 'waiting' : 'idle';
    });
    if (!stopped) app.notify = fin && fin.next && fin.next.ask ? 'question' : 'task_complete';   // (told on the window's timer)
    if (!stopped && !failed && fin && !(app.queue[sid] || []).length && record('settings', {}).prompt_suggestions !== false) suggest(fin);
    // (a message sent while Claude worked: its turn now, from the window's timer)
    if ((app.queue[sid] || []).length) app.nextSay = { sid, text: app.queue[sid].shift() };
    app.dirty = true;
  }
  // the prompt suggestion the app offers when a turn ends: the next thing the user is likely to send, asked of a small
  // model with the end of the conversation; shown in the status line, and Edit > Use Suggestion puts it in the prompt
  async function suggest(s) {
    const tail = s.transcript.filter(m => (m.role === 'user' || m.role === 'assistant') && m.text).slice(-4).map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text.slice(0, 1500)}`).join('\n\n');
    if (!tail) return;
    const ask_ = `Here is the end of a conversation between a user and Claude:\n\n${tail}\n\nWrite the message the user is most likely to send next, in their voice, under 12 words. Reply with only that message.`;
    try {
      const r = await fetch('__claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-5-5', effort: 'low', messages: [{ role: 'user', content: ask_ }] }) });
      if (!r.ok) return;
      let out = ''; for (const l of (await r.text()).split('\n')) { if (!l) continue; const ev = JSON.parse(l); if (ev.t === 'text') out += ev.d; }
      out = out.trim().replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 120);
      if (out && (current() || {}).id === s.id) { app.suggestion = { sid: s.id, text: out }; app.dirty = true; }
    } catch (_) {}
  }
  // a message of the user's into the session, and the turn that answers it
  function say(p, t, sid) {
    let s = sid ? load().find(x => x.id === sid) : current(); if (!s) { const l = load(); s = fresh(); l.push(s); save(l); app.shown = s.id; }
    // (sent while Claude works: queued, as the app queues it, and sent when the turn ends)
    if (s.state === 'working') { (app.queue[s.id] = app.queue[s.id] || []).push(t); app.note = `Queued: sent when Claude finishes (${app.queue[s.id].length} waiting).`; showAll(p); return; }
    if (app.suggestion && app.suggestion.sid === s.id) app.suggestion = null;
    // (the files attached go with it: named in the conversation, their text in the message Claude gets)
    const att = app.attach.splice(0), shown_ = att.length ? `${t}\n${att.map(a => `[Attached: ${a.path}]`).join('\n')}` : t;
    const blocks = att.length ? [{ type: 'text', text: t }, ...att.map(a => ({ type: 'text', text: `<attachment path="${a.path}">\n${a.text}\n</attachment>` }))] : undefined;
    update(s.id, x => { x.transcript.push({ uuid: id('msg'), t: Date.now(), role: 'user', text: shown_, ...(blocks ? { blocks } : {}) }); x.state = 'working'; x.next = null; if (x.title === 'New session') x.title = t.slice(0, 48); });
    showAll(p); reply(s.id);
  }
  function send(p) {
    const e = app.kid[ID.PROMPT], b = sz(p, 'prompt-in', ' '.repeat(4096));
    U(p, 'GetWindowTextA', [e, b, 4096]); const t = p.readA(b).trim();
    if (!t) { const s = current(); if (s && s.state === 'working') stop(p, s.id); return; }   // (Send, with nothing typed while Claude works: Stop)
    text(p, e, 'prompt-clear', ''); say(p, t);
  }
  // Stop: the request in progress ended, the tools not yet run answered as not run; the queue dropped
  function stop(p, sid) {
    app.stopping[sid] = true; app.queue[sid] = [];
    const a = app.aborts[sid]; if (a) a.abort();
    app.note = 'Stopping...'; showAll(p);
  }
  // a next-step button: its message is the user's answer (the app's: ccd.js answer)
  function answer(p, i) {
    const s = current(), a = s && s.next && s.next.actions && s.next.actions[i]; if (!a) return;
    say(p, a.message || a.label || a.action);
  }
  function newSession(p) { const l = load(), s = fresh(); l.push(s); save(l); app.shown = s.id; showAll(p); }

  // ---------------------------------------------------------------- the program's entry and its window procedure
  // Start(wndproc): the window, of a class whose procedure is the program's own (CLAUDE.EXE's WndProc, which asks Handle)
  def('CLAUDE', 'Start', 1, function (wndproc) {
    const p = this, inst = p.call(p.thunkFor('KERNEL32', 'GetModuleHandleA'), [0]);   // (the program's instance, as it asks for it)
    const cls = sz(p, 'class', 'ClaudeWindow'), wc = p.alloc(40);
    for (const [o, v] of [[0, 3], [4, wndproc], [8, 0], [12, 0], [16, inst], [20, U(p, 'LoadIconA', [0, 32512])], [24, U(p, 'LoadCursorA', [0, 32512])], [28, 16], [32, 0], [36, cls]]) p.w32(wc + o, v);
    U(p, 'RegisterClassA', [wc]);
    // the menu bar
    // the menu bar, as the app's (File, View, Go) with the session's own (Session, Model, Effort)
    const bar = U(p, 'CreateMenu', []);
    const pop = items => {   // [id, label] (0, null: a separator; a menu handle as id with a label array: a submenu)
      const m = U(p, 'CreatePopupMenu', []);
      for (const [i, l] of items) {
        if (Array.isArray(i)) { U(p, 'AppendMenuA', [m, 0x10, pop(i), sz(p, `menu-${l}`, l)]); continue; }
        U(p, 'AppendMenuA', [m, l ? 0 : 0x800, i, l ? sz(p, `menu${i}`, l) : 0]);
      }
      return m;
    };
    const sub = (m, l) => U(p, 'AppendMenuA', [bar, 0x10, m, sz(p, `bar-${l}`, l)]);
    sub(pop([[ID.NEW, '&New Session'], [CMD.ATTACH, '&Attach File...'], [0, null], [CMD.SETTINGS, 'Se&ttings...'], [0, null], [CMD.EXPORT, '&Export Transcript'], [0, null], [ID.EXIT, 'E&xit']]), '&File');
    sub(pop([[CMD.COPY_REPLY, '&Copy Message'], [CMD.FIND, '&Find Next (the prompt\'s text)'], [0, null],
      [CMD.FORK, 'F&ork from Here'], [CMD.REWIND, '&Rewind to Here'], [CMD.CHAPTER, '&Pin as Chapter'], [0, null], [CMD.SUGGEST, 'Use &Suggestion'], [CMD.RENAME, 'Re&name Session...']]), '&Edit');
    sub(pop([[CMD.SIDEBAR, 'Side&bar'], [GROUP_BY.map(([, l], i) => [380 + i, l]), '&Group Sessions By'], [SORT_BY.map(([, l], i) => [385 + i, l]), '&Sort Sessions By'],
      [STATUS.map(([, l], i) => [388 + i, l]), 'Sho&w Sessions'], [CMD.HIDE_NESTED, '&Hide Nested Sessions'], [0, null],
      [VIEWS.map((x, i) => [330 + i, `${x[0].toUpperCase()}${x.slice(1)}`]), '&Transcript View'], [0, null],
      ...PANES.map((x, i) => [340 + i, PANE_TITLE[x]]), [CMD.TERMINAL, 'Ter&minal (MS-DOS Prompt)'], [CMD.CLOSE_PANE, 'C&lose Pane']]), '&View');
    sub(pop([[CMD.BACK, '&Back'], [CMD.FORWARD, '&Forward'], [0, null], [CMD.PREV, '&Previous Session'], [CMD.NEXT_SESSION, '&Next Session']]), '&Go');
    sub(pop([[MODES.map(([, n], i) => [320 + i, n]), 'Permission &Mode'], [0, null], [CMD.STOP, 'S&top'], [0, null], [CMD.PIN, '&Pinned'], [CMD.ARCHIVE, '&Archive']]), '&Session');
    sub(pop(MODELS.map(([, n], i) => [300 + i, n])), 'M&odel');
    sub(pop(EFFORTS.map((e, i) => [310 + i, `${e[0].toUpperCase()}${e.slice(1)}`])), 'Effor&t');
    sub(pop([[CMD.USAGE, '&Usage'], [0, null], [ID.ABOUT, '&About Claude']]), '&Help');
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
    kid(ID.TASKS, 'LISTBOX', 0x200, 0x00200000 | 0x100 | 0x4000);                  // WS_VSCROLL, LBS_NOINTEGRALHEIGHT, LBS_NOSEL
    kid(ID.NEXT, 'STATIC', 0x200, 0);                                                 // (sunken: the next-step box)
    kid(ID.ANSWER0, 'BUTTON', 0, 0x10000); kid(ID.ANSWER1, 'BUTTON', 0, 0x10000);
    kid(ID.CARD, 'STATIC', 0, 0x200 | 0x80 | 0x4000); kid(ID.CARD0, 'BUTTON', 0, 0x10000); kid(ID.CARD1, 'BUTTON', 0, 0x10000);   // (the card: SS_CENTERIMAGE, SS_NOPREFIX)
    kid(ID.PANE0, 'STATIC', 0, 0); kid(ID.PANE0_TEXT, 'EDIT', 0x200, 0x00200000 | 4 | 0x800);
    kid(ID.PANE1, 'STATIC', 0, 0); kid(ID.PANE1_TEXT, 'EDIT', 0x200, 0x00200000 | 4 | 0x800);
    const rc = p.alloc(16); U(p, 'GetClientRect', [h, rc]); app.size = [p.r32(rc + 8), p.r32(rc + 12)]; p.free(rc);
    app.shown = (current() || {}).id || null; showAll(p);
    U(p, 'SetTimer', [h, 1, 150, 0]);   // (the reply arrives between the program's messages: shown on the timer)
    U(p, 'SetFocus', [app.kid[ID.PROMPT]]);
    return h;
  });
  // Handle(hwnd, msg, wp, lp, &result): 1 with the result written for a message that is Claude's, else 0 (the program's
  // WndProc passes those to DefWindowProcA itself). Nothing here waits on messages of its own (no DefWindowProcA, no
  // MessageBoxA: a call from here runs to its end without giving the processor back)
  // (a fault of this library's is said in the window's status line, not the system's: the window procedure runs in the
  // system's own machine, whose MSGSRV32 a thrown error would end)
  def('CLAUDE', 'Handle', 5, function (h, msg, wp, lp, res) {
    try { return handle.call(this, h, msg, wp, lp, res); }
    catch (e) { console.error(e); try { if (app.kid[ID.STATUS]) text(this, app.kid[ID.STATUS], 'status', `Claude: ${e.message}`); } catch (_) {} return 0; }
  });
  function handle(h, msg, wp, lp, res) {
    const p = this, done = (v = 0) => { p.w32(res, v); return 1; };
    if (h !== app.hwnd) return 0;
    if (msg === WM.SIZE) { layout(p, lp & 0xffff, lp >>> 16); return done(); }
    // (the timer: what the reply and the app's tools have written since, shown)
    if (msg === WM.TIMER && app.notify) {   // a turn ended: beep and flash the taskbar button when the window is behind, as the settings say
      const kind = app.notify, st = record('settings', {}); app.notify = null;
      if (st[`${kind}_notifications`] !== 'none' && fn(p, 'USER32', 'FlashWindow') && U(p, 'GetForegroundWindow', []) !== h) {
        if (st.notification_sound !== false) U(p, 'MessageBeep', [kind === 'question' ? 0x20 : 0]);   // MB_ICONQUESTION, the default sound
        if (st.draw_attention_on_notifications !== false) U(p, 'FlashWindow', [h, 1]);
      }
    }
    if (msg === WM.TIMER && app.wantDialog) { const [t, proc] = app.wantDialog; app.wantDialog = null; U(p, 'PostMessageA', [h, 0x8004, t, p.thunkFor('CLAUDE', proc)]); }   // (a dialog whose contents came from the page)
    if (msg === WM.TIMER && app.nextSay) { const q = app.nextSay; app.nextSay = null; say(p, q.text, q.sid); }
    if (msg === WM.TIMER) {
      if (app.dirty || regGet(KEY, 'sessions') !== app.raw || regGet(KEY, 'view') !== app.rawView || regGet(KEY, 'cards') !== app.rawCards) { app.dirty = false; showAll(p); }
      if (!asking && asks.length) { asking = asks.shift(); U(p, 'PostMessageA', [h, 0x8001, sz(p, 'ask-text', asking.text), sz(p, 'ask-title', asking.title || 'Claude')]); }
      return done();
    }
    if (msg === WM.DESTROY) { U(p, 'KillTimer', [h, 1]); app.hwnd = 0; app.kid = {}; U(p, 'PostQuitMessage', [0]); return done(); }
    // the right button on a session: its shortcut menu (tracked by the program's WndProc, WM_APP+2)
    if (msg === 0x7B && wp === app.kid[ID.SESSIONS]) {   // WM_CONTEXTMENU
      const pt = app.pt || (app.pt = p.alloc(8)), x = lp & 0xffff, y = lp >>> 16;
      p.w32(pt, x); p.w32(pt + 4, y); U(p, 'ScreenToClient', [wp, pt]);
      const k = U(p, 'SendMessageA', [wp, 0x1A9, 0, (p.r32(pt + 4) << 16) | (p.r32(pt) & 0xffff)]) & 0xffff, r = app.rows[k];   // LB_ITEMFROMPOINT
      if (!r || !r.sid) return done();
      const s = sessions().find(z => z.id === r.sid); if (!s) return done();
      app.ctx = s.id; U(p, 'SendMessageA', [wp, 0x186, k, 0]);
      const m = U(p, 'CreatePopupMenu', []), add = (id_, l, flags = 0) => U(p, 'AppendMenuA', [m, flags, id_, l ? sz(p, `ctx${id_}`, l) : 0]);
      add(CMD.CTX_PIN, s.pinned ? 'Unpin' : 'Pin'); add(CMD.CTX_UNREAD, s.unread ? 'Mark as Read' : 'Mark as Unread');
      const groups = record('groups', []);
      if (groups.length) {
        const g = U(p, 'CreatePopupMenu', []);
        groups.forEach((x, i) => U(p, 'AppendMenuA', [g, s.group === x.id ? 8 : 0, CMD.CTX_GROUP + i, sz(p, `ctxg${i}`, x.name)]));
        U(p, 'AppendMenuA', [g, s.group ? 0 : 8, CMD.CTX_UNGROUP, sz(p, 'ctxg-none', 'Ungrouped')]);
        U(p, 'AppendMenuA', [m, 0x10, g, sz(p, 'ctx-move', 'Move to Group')]);
      }
      add(0, null, 0x800); add(CMD.CTX_EXPORT, 'Export Transcript'); add(CMD.CTX_ARCHIVE, 'Archive'); add(CMD.CTX_DELETE, 'Delete');
      p.w32(pt, x); p.w32(pt + 4, y); U(p, 'PostMessageA', [h, 0x8002, m, pt]);
      return done();
    }
    if (msg !== WM.COMMAND) return 0;
    const c = wp & 0xffff, note = wp >>> 16;
    if (c === ID.SEND || c === 1) { send(p); return done(); }                         // (IDOK: Enter in the prompt)
    if (c === ID.NEW) { newSession(p); return done(); }
    if (c === ID.EXIT) { U(p, 'PostMessageA', [h, WM.CLOSE, 0, 0]); return done(); }
    if (c === CMD.SETTINGS && !app.settingsOpen) {   // the settings as get_settings has them, then the dialog (WM_APP+4)
      app.settingsOpen = true; app.tplSettings = app.tplSettings || settingsTemplate(p);
      page('ccd_settings__get_settings', {}, (current() || {}).id).then(r => {
        try { app.settingsNow = JSON.parse(r.result).settings; } catch (_) { app.settingsNow = {}; }
        app.wantDialog = [app.tplSettings, 'SettingsProc'];
      });
      return done();
    }
    if (c === CMD.ATTACH && !app.ofn) {   // the Open dialog, run by the program's WndProc (WM_APP+3): its answer comes to Opened
      const o = app.ofn = { at: p.alloc(76), file: p.alloc(260) };
      const filter = sz(p, 'ofn-filter', 'Text Files (*.txt)\0*.TXT\0All Files (*.*)\0*.*\0\0');
      p.writeA(o.file, '');
      for (const [k, v] of [[0, 76], [4, h], [12, filter], [24, 1], [28, o.file], [32, 260], [44, sz(p, 'ofn-dir', (current() || {}).cwd || 'C:\\')], [48, sz(p, 'ofn-title', 'Attach File')], [52, 0x1000 | 0x800 | 0x4]]) p.w32(o.at + k, v);   // OFN_FILEMUSTEXIST, OFN_PATHMUSTEXIST, OFN_HIDEREADONLY
      U(p, 'PostMessageA', [h, 0x8003, 0, o.at]); return done();
    }
    if (c === CMD.USAGE) {   // the app's usage meter: what this session's requests used, as the API counted it
      const u = (current() || {}).usage, n = x => x.toLocaleString('en-US');
      text(p, app.kid[ID.STATUS], 'status', u ? `Usage: context ${n(u.context)} tokens  ·  this session ${n(u.in)} in, ${n(u.out)} out over ${u.requests} request${u.requests === 1 ? '' : 's'}  ·  no plan limits` : 'Usage: no requests in this session yet.');
      return done();
    }
    if (c === ID.ABOUT) { text(p, app.kid[ID.STATUS], 'status', 'Claude for Windows 95: the Claude desktop app, as a program of the system.'); return done(); }
    if (c === ID.ANSWER0 || c === ID.ANSWER1) { answer(p, c - ID.ANSWER0); return done(); }
    if (c === ID.CARD0 || c === ID.CARD1) { const cd = card(current()); if (cd) post({ t: 'ccdCard', task: cd.task_id, label: cd.buttons[c - ID.CARD0] }); return done(); }
    const s = current(), sid = s && s.id, redraw = () => { showAll(p); return done(); };
    // Edit: a message's actions (copy, fork, rewind, a chapter) and finding in the conversation
    const promptText = () => { const b = sz(p, 'prompt-in', ' '.repeat(4096)); U(p, 'GetWindowTextA', [app.kid[ID.PROMPT], b, 4096]); return p.readA(b).trim(); };
    const select = (a, b_) => { const e = app.kid[ID.CONVO]; U(p, 'SendMessageA', [e, 0xB1, a, b_]); U(p, 'SendMessageA', [e, 0xB7, 0, 0]); return e; };   // EM_SETSEL, EM_SCROLLCARET
    // the message the caret is in (clicked into in the conversation), as the app's actions on a message; the last one
    // when the caret is at the end, where the conversation leaves it
    const msgAt = () => {
      convo(s); const sp = convo.spans.spans, pos = U(p, 'SendMessageA', [app.kid[ID.CONVO], 0xB0, 0, 0]) & 0xffff;   // EM_GETSEL: its start
      let r = null; for (const x of sp) if (x.from <= pos) r = x; return r || sp[sp.length - 1] || null;
    };
    if (c === CMD.COPY_REPLY && s) {
      const at = msgAt(); if (!at) return done();
      U(p, 'SendMessageA', [select(at.from + at.head, at.to), 0x301, 0, 0]); app.note = `Copied the message (${s.transcript[at.k].role === 'user' ? 'yours' : 'Claude\'s'}).`;   // WM_COPY: the edit control's own clipboard copy
      return redraw();
    }
    if (c === CMD.SUGGEST && app.suggestion && app.suggestion.sid === sid) {   // the suggestion into the prompt, to send or change
      const e = app.kid[ID.PROMPT], t = app.suggestion.text, n = ansi(t).length; app.suggestion = null;
      text(p, e, 'prompt-suggest', t); U(p, 'SendMessageA', [e, 0xB1, n, n]); U(p, 'SetFocus', [e]); return redraw();
    }
    if (c === CMD.RENAME && s && !app.renaming) {   // Rename Session: a dialog of the program's (WM_APP+4: DialogBoxIndirectParamA), answered in RenameProc
      app.renaming = s.id; app.tpl = app.tpl || dialogTemplate(p, 'Rename Session', 212, 62, [
        [0x50000000, 0x0082, 7, 9, 198, 8, -1, 'Session &name:'],                  // STATIC
        [0x50810080, 0x0081, 7, 20, 198, 12, 100, ''],                             // EDIT: WS_BORDER, WS_TABSTOP, ES_AUTOHSCROLL
        [0x50010001, 0x0080, 101, 41, 50, 14, 1, 'OK'],                           // BUTTON: BS_DEFPUSHBUTTON, WS_TABSTOP
        [0x50010000, 0x0080, 155, 41, 50, 14, 2, 'Cancel']]);
      U(p, 'PostMessageA', [h, 0x8004, app.tpl, p.thunkFor('CLAUDE', 'RenameProc')]); return done();
    }
    if (c === CMD.FIND && s) {
      const q = promptText(), t = ansi(convo(s)), e = app.kid[ID.CONVO];
      if (!q) { app.note = 'Type what to find in the prompt, then Edit > Find Next.'; return redraw(); }
      const from = U(p, 'SendMessageA', [e, 0xB0, 0, 0]) >>> 16, k = t.toLowerCase().indexOf(q.toLowerCase(), from), at = k >= 0 ? k : t.toLowerCase().indexOf(q.toLowerCase());   // EM_GETSEL: after the selection
      if (at < 0) { app.note = `Cannot find "${q}".`; text(p, app.kid[ID.STATUS], 'status', app.note); app.note = null; return done(); }
      select(at, at + q.length); U(p, 'SetFocus', [e]); return done();
    }
    if (c === CMD.FORK && s) {   // Fork from here: the conversation through the message, in a new session
      const at = msgAt(), upto = at ? at.k + 1 : s.transcript.length;
      const l = load(), f = { ...fresh(), title: `${s.title} (fork)`, startedBy: s.id, cwd: s.cwd, model: s.model, effort: s.effort, transcript: s.transcript.slice(0, upto).map(m => ({ ...m })), plan: s.plan.map(x => ({ ...x })) };
      l.push(f); save(l); go(f.id); return redraw();
    }
    if (c === CMD.REWIND && s && s.state !== 'working') {   // Rewind to here: back to before the prompt (the message's, or the one Claude's answers)
      const at = msgAt(), k = at ? s.transcript.slice(0, at.k + 1).map(m => m.role).lastIndexOf('user') : -1; if (k < 0) return done();
      const was = s.transcript[k].text; update(sid, x => { x.transcript = x.transcript.slice(0, k); x.next = null; });
      const e = app.kid[ID.PROMPT], n = ansi(was).length; text(p, e, 'prompt-rewind', was); U(p, 'SendMessageA', [e, 0xB1, n, n]); U(p, 'SetFocus', [e]); return redraw();
    }
    if (c === CMD.CHAPTER && s) {   // Pin as chapter: a chapter starting at the message, named by the prompt or the message
      const at = msgAt(), k = at ? at.k : s.transcript.length, first = at ? s.transcript[k].text.split('\n')[0].slice(0, 40) : '';
      const name = promptText() || first || `Chapter ${(s.chapters || []).length + 1}`;
      update(sid, x => { x.transcript.splice(k, 0, { uuid: id('msg'), t: Date.now(), role: 'chapter', text: name }); (x.chapters = x.chapters || []).push({ title: name, t: Date.now() }); });
      text(p, app.kid[ID.PROMPT], 'prompt-clear', ''); return redraw();
    }
    // View: the sidebar, the transcript view, the panes
    if (c === CMD.SIDEBAR) { setUi(u => { u.sidebarCollapsed = !u.sidebarCollapsed; }); return redraw(); }
    if (c >= 380 && c < 380 + GROUP_BY.length) { setView('group_by', GROUP_BY[c - 380][0]); return redraw(); }
    if (c >= 385 && c < 385 + SORT_BY.length) { setView('sort_by', SORT_BY[c - 385][0]); return redraw(); }
    if (c >= 388 && c < 388 + STATUS.length) { setView('status', STATUS[c - 388][0]); return redraw(); }
    if (c === CMD.HIDE_NESTED) { setUi(u => { u.hideNested = !u.hideNested; }); return redraw(); }
    if (c >= 330 && c < 330 + VIEWS.length) { if (sid) update(sid, x => { x.view = VIEWS[c - 330]; }); return redraw(); }
    if (c >= 340 && c < 340 + PANES.length) { togglePane(PANES[c - 340]); return redraw(); }
    if (c === CMD.TERMINAL) { page('ccd_view__show_pane', { pane: 'terminal' }, sid); return done(); }   // (the app's Terminal pane: the system's MS-DOS Prompt, as show_pane opens it)
    if (c === CMD.CLOSE_PANE) { setUi(u => { u.panes = u.panes.slice(0, -1); }); return redraw(); }
    // Go: back, forward, the sessions in order
    if (c === CMD.BACK && nav.back.length) { nav.fwd.push(sid); go(nav.back.pop(), 'nav'); return redraw(); }
    if (c === CMD.FORWARD && nav.fwd.length) { nav.back.push(sid); go(nav.fwd.pop(), 'nav'); return redraw(); }
    if (c === CMD.PREV || c === CMD.NEXT_SESSION) { const ids = app.rows.filter(r => r.sid).map(r => r.sid), k = ids.indexOf(sid); if (ids.length) go(ids[(k + (c === CMD.PREV ? -1 : 1) + ids.length) % ids.length]); return redraw(); }
    // Session: the mode, the pin, archiving (the app's tools, which ask as the app asks)
    if (c >= 320 && c < 320 + MODES.length) { if (sid) update(sid, x => { x.permissionMode = MODES[c - 320][0]; }); return redraw(); }
    if (c === CMD.STOP && s && s.state === 'working') { stop(p, sid); return done(); }
    if (c === CMD.PIN && sid) { update(sid, x => { x.pinned = !x.pinned; }); return redraw(); }
    if (c === CMD.ARCHIVE && sid) { page('ccd_session_mgmt__archive_session', { session_id: sid }, sid); return done(); }
    if (c === CMD.EXPORT && sid) { page('ccd_session_mgmt__export_transcript', { session_id: sid }, sid).then(r => { app.note = r.error ? r.error : `Exported to ${JSON.parse(r.result).path}`; app.dirty = true; }); return done(); }
    // a session's shortcut menu
    const t = app.ctx;
    if (t && c >= 500) {
      if (c === CMD.CTX_PIN) update(t, x => { x.pinned = !x.pinned; });
      else if (c === CMD.CTX_UNREAD) update(t, x => { x.unread = !x.unread; });
      else if (c === CMD.CTX_ARCHIVE) page('ccd_session_mgmt__archive_session', { session_id: t }, sid);
      else if (c === CMD.CTX_DELETE) page('ccd_session_mgmt__delete_session', { session_ids: [t] }, sid);
      else if (c === CMD.CTX_EXPORT) page('ccd_session_mgmt__export_transcript', { session_id: t }, sid);
      else if (c === CMD.CTX_UNGROUP) update(t, x => { x.group = null; });
      else if (c >= CMD.CTX_GROUP) { const g = record('groups', [])[c - CMD.CTX_GROUP]; if (g) update(t, x => { x.group = g.id; x.pinned = false; }); }
      app.ctx = null; return redraw();
    }
    if (c >= 300 && c < 300 + MODELS.length) { const s = current(); if (s) update(s.id, x => { x.model = MODELS[c - 300][0]; }); showAll(p); return done(); }
    if (c >= 310 && c < 310 + EFFORTS.length) { const s = current(); if (s) update(s.id, x => { x.effort = EFFORTS[c - 310]; }); showAll(p); return done(); }
    if (c === ID.SESSIONS && note === 1) {                                           // LBN_SELCHANGE (a heading: back to the session)
      const k = U(p, 'SendMessageA', [app.kid[ID.SESSIONS], 0x188, 0, 0]), r = app.rows[k];
      if (r && r.sid) { app.shown = r.sid; update(r.sid, x => { x.unread = false; }); }
      showAll(p); return done();
    }
    return 0;
  }
})();
