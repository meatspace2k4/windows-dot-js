// The Claude desktop app's own tools (its mcp__ccd_* servers) as Windows 95 has them: win95.ccd.<server>.<tool>(args),
// each with the app tool's name, its parameters and the shape of its answer, acting on what Windows 95 has in place of
// what the app acts on. Sessions, groups, cards and settings are records in the registry (HKCU\Software\Claude\Code),
// so they last as the registry does; the Claude window (a page-drawn window, as Find: Computer is) shows them: the
// sessions in its sidebar, and for the session on show its chapters, task list, transcript and next-step box.
// What the app asks the user about (archive, delete, a setting, a permission mode) is asked in a message box, and the
// answer is the call's. Every call emits ccd.<server>.<tool> with its arguments and answer; an answer the user gives in
// the window (a next-step button, a card's) emits ccd.answer.
(() => {
  // ---------------------------------------------------------------- the tools' parameters (the app's schemas)
  // per tool: the required fields and the fields that take one of a set of values
  const E = {
    pane: ['diff', 'file', 'terminal', 'pr', 'tasks', 'plan', 'artifact', 'preview'],
    mode: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  };
  const SCHEMA = {
    turn: {
      update_plan: { enums: { scope: ['first_task', 'continuation', 'new_task'] } },
      wrap_up: { req: ['recap'] },
    },
    session: {
      start_session: { enums: { initiation: ['user_asked', 'own_initiative', 'offer'], context: ['fresh', 'fork'], target: ['local', 'cloud', 'ssh'], effort: E.effort, permission_mode: E.mode } },
      dismiss_task: { req: ['task_id'] },
      hand_off_to_session: { req: ['title', 'remaining_plan'] },
      mark_chapter: { req: ['title'] },
      read_widget_context: { req: ['tool_name'] },
      list_start_targets: {},
      move_to_cloud: { req: ['summary'] },
    },
    session_mgmt: {
      list_sessions: {}, get_session: { req: ['session_id'] }, list_events: { req: ['session_id'] },
      search_session_transcripts: { req: ['query'] },
      archive_session: { req: ['session_id'] }, unarchive_session: { req: ['session_id'] }, delete_session: { req: ['session_ids'] },
      clear_session: { req: ['session_id'] }, stop_session: { req: ['session_id'] }, detach_session: { req: ['session_id'] },
      set_session_title: { req: ['session_id', 'title'] }, set_session_model: { req: ['session_id', 'model'] },
      set_session_effort: { req: ['session_id', 'effort'], enums: { effort: E.effort } },
      set_session_fast_mode: { req: ['session_id', 'enabled'] },
      set_session_permission_mode: { req: ['session_id', 'mode'], enums: { mode: E.mode } },
      set_session_output_style: { req: ['session_id', 'style'] },
      set_remote_control: { req: ['session_id', 'enabled'] },
      send_message: { req: ['session_id', 'message'] },
      export_transcript: { req: ['session_id'] }, get_usage: {},
    },
    sidebar: {
      list_groups: {}, create_group: { req: ['name'] }, rename_group: { req: ['group_id', 'name'] }, delete_group: { req: ['group_id'] },
      list_sections: {}, create_section: { req: ['name'] }, rename_section: { req: ['section_id', 'name'] }, delete_section: { req: ['section_id'] },
      move_sessions: { req: ['session_ids'] }, set_pinned: { req: ['session_id', 'pinned'] }, set_unread: { req: ['session_id', 'unread'] },
      mark_completed: { req: ['session_id'] },
      set_view: { enums: { group_by: ['date', 'project', 'state', 'custom', 'none'], status: ['active', 'archived', 'all'], sort_by: ['recency', 'alpha', 'created'] } },
    },
    view: {
      show_pane: { req: ['pane'], enums: { pane: E.pane } }, close_pane: { req: ['pane'], enums: { pane: E.pane } },
      get_layout: {}, set_transcript_view: { req: ['view'], enums: { view: ['normal', 'thinking', 'verbose'] } },
    },
    window: {
      get_window_layout: {}, open_session_in: { req: ['session_id', 'target'], enums: { target: ['split', 'window', 'focus'] } },
      close_split: {}, set_sidebar_collapsed: { req: ['collapsed'] },
    },
    settings: { get_settings: {}, set_setting: { req: ['key', 'value'] } },
    pr: { get_status: {}, bind_pr: { req: ['url'] }, unbind_pr: { req: ['url'] }, set_auto_merge: { req: ['enabled', 'url'], enums: { merge_method: ['squash', 'merge', 'rebase'] } }, set_monitor: {} },
    host: {
      open_in_editor: { req: ['path'], enums: { editor: ['vscode', 'cursor', 'windsurf', 'zed'] } }, reveal_path: { req: ['path'] },
      request_keep_awake: { req: ['until', 'reason'], enums: { until: ['turn_end', 'session_idle'] } },
      get_storage_usage: {}, sync_with_base_branch: {}, clean_up_worktrees: { req: ['older_than_days'] }, discard_kept_worktree: { req: ['session_id'] },
    },
    directory: { change_directory: { req: ['path'] }, request_directory: {} },
    connectors: { session_connectors_status: {}, set_session_connector_enabled: { req: ['connector', 'enabled'] }, reconnect_session_connector: { req: ['server'] } },
  };

  // the settings get_settings lists, with what each accepts and does
  const SETTINGS = {
    auto_archive_on_pr_close: { v: false, accepts: 'true | false', does: 'archive a session once its pull request merges or closes' },
    auto_archive_inactive_days: { v: 0, accepts: 'a whole number of days (0: never)', does: 'archive sessions inactive this many days' },
    branch_prefix: { v: 'claude/', accepts: 'a string', does: 'the prefix of new worktrees\' branch names' },
    permission_request_notifications: { v: 'all', accepts: 'all | none', does: 'beep and flash the taskbar when a session asks for a permission' },
    question_notifications: { v: 'all', accepts: 'all | none', does: 'beep and flash the taskbar when a session asks a question' },
    task_complete_notifications: { v: 'all', accepts: 'all | none', does: 'beep and flash the taskbar when a session finishes' },
    connect_new_sessions_to_remote_control: { v: false, accepts: 'true | false', does: 'start new sessions with Remote Control on' },
    output_style: { v: 'default', accepts: 'an output style name', does: 'the output style new sessions start with' },
    draw_attention_on_notifications: { v: true, accepts: 'true | false', does: 'flash the taskbar button with a notification' },
    notification_sound: { v: true, accepts: 'true | false', does: 'beep with a notification' },
    keep_awake_while_working: { v: true, accepts: 'true | false', does: 'hold off the screen saver while a session works' },
    keep_awake_on_battery: { v: false, accepts: 'true | false', does: 'hold off the screen saver on battery too' },
    prompt_suggestions: { v: true, accepts: 'true | false', does: 'suggest a next prompt when a turn ends' },
  };

  window.W95Ccd = function (ui) {
    const KEY = 'hkcu\\software\\claude\\code';
    const R = ui.W95Win32, FS = window.W95FS;
    // ---------------------------------------------------------------- the records
    const load = (name, dflt) => {
      const v = R.regGet(KEY, name); if (!v) return dflt;
      try { return JSON.parse(typeof v === 'string' ? v : FS.decode(v.data).replace(/\0.*$/, '')); } catch (_) { return dflt; }
    };
    const save = name => R.regSet(KEY, name, { type: 1, data: FS.encode(JSON.stringify(st[name]) + '\0') });
    const st = {
      sessions: load('sessions', []), groups: load('groups', []), cards: load('cards', []),
      settings: load('settings', {}), view: load('view', { group_by: 'none', status: 'active', sort_by: 'recency', last_activity: 0, sections: {} }),
    };
    let nextId = st.sessions.reduce((m, s) => Math.max(m, +String(s.id).split('_').pop() || 0), 0) + 1;
    const uid = p => `${p}_${(nextId++).toString(36).padStart(6, '0')}${Math.random().toString(36).slice(2, 6)}`;
    const now = () => Date.now();
    const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'session';
    const fresh = o => ({
      id: uid('local'), title: 'Windows 95', name: slug(o.title || 'windows-95'), state: 'idle', archived: false, pinned: false, unread: false,
      group: null, startedBy: null, detached: false, created: now(), active: now(), model: 'claude-opus-5-5', effort: 'medium',
      permissionMode: 'default', outputStyle: st.settings.output_style || 'default', fastMode: 'off', remoteControlState: 'off',
      cwd: 'C:\\', transcript: [], plan: [], chapters: [], next: null, view: 'normal', connectorsOff: [], ...o,
    });
    // the session the calls act on as "self": the one this page's agent works in, made the first time it is needed
    let self = st.sessions.find(s => s.self);
    if (!self) { self = fresh({ self: true }); st.sessions.unshift(self); save('sessions'); }
    let shown = self.id, sidebarCollapsed = false, splits = [], keepAwake = null;
    const byId = id => (id === 'self' ? self : st.sessions.find(s => s.id === id || s.name === id || (id === 'parent' && s.id === self.startedBy)));
    const need = id => { const s = byId(id); if (!s) throw new CcdError(`No session ${JSON.stringify(id)}: list_sessions lists the session ids.`); return s; };
    const family = s => st.sessions.filter(x => x === s || x.startedBy === s.id || s.startedBy === x.id || (x.startedBy && x.startedBy === s.startedBy));
    const said = (s, role, text, o = {}) => { s.transcript.push({ uuid: uid('msg'), t: now(), role, text, ...o }); s.active = now(); };
    const row = s => ({
      sessionId: s.id, title: s.title, ...(s.startedBy || s.self ? { name: s.name } : {}), ...(s.startedBy ? { startedBy: s.startedBy } : {}),
      state: s.state, archived: s.archived, group: s.group ? { id: s.group, name: (st.groups.find(g => g.id === s.group) || {}).name } : null,
      pinned: s.pinned, unread: s.unread, cwd: s.cwd, lastActivity: new Date(s.active).toISOString(), remoteControlActive: s.remoteControlState === 'on',
      ...(s.startedBy === self.id || s === self ? { permissionMode: s.permissionMode } : {}),
    });

    // ---------------------------------------------------------------- asking the user (the app's approval cards)
    const ask = (title, msg, buttons = ['Yes', 'No']) => new Promise(ok => ui.msgBox(title, msg, 'question', buttons, b => ok(b)));
    const approve = async (what) => (await ask('Claude', what)) === 'Yes';
    // Browse for Folder: a folder typed or kept, OK or Cancel (null)
    const pickFolder = start => new Promise(ok => {
      let w; const edit = { type: 'edit', x: 12, y: 30, w: 296, h: 21, value: start, caret: start.length, focus: true, all: true };
      const done = v => { ui.closeWin(w, true); ok(v); };
      w = ui.dialog('Browse for Folder', 320, 94, [
        { type: 'label', text: 'Choose a folder for this session:', x: 12, y: 10 }, edit,
        { type: 'button', label: 'OK', x: 152, y: 62, w: 75, h: 23, def: true, fn: () => done(ui.fs.exists(edit.value) && ui.fs.stat(edit.value).isDir ? edit.value : null) },
        { type: 'button', label: 'Cancel', x: 233, y: 62, w: 75, h: 23, cancel: true, fn: () => done(null) },
      ], { modal: true });
    });
    const notify = kind => {
      if (st.settings[`${kind}_notifications`] === 'none') return;
      if (st.settings.notification_sound !== false && ui.beep) ui.beep();
      ui.emit('ccd.notify', { kind });
    };

    // ---------------------------------------------------------------- the Claude window
    let win = null;
    const W = 600, H = 400, SIDE = 176;
    const visibleSessions = () => {
      let l = st.sessions.filter(s => (st.view.status === 'all' ? true : st.view.status === 'archived' ? s.archived : !s.archived));
      const by = { recency: (a, b) => b.active - a.active, alpha: (a, b) => a.title.localeCompare(b.title), created: (a, b) => b.created - a.created }[st.view.sort_by || 'recency'];
      l = l.sort(by);
      const pinned = l.filter(s => s.pinned), rest = l.filter(s => !s.pinned), rows = [];
      const head = t => rows.push({ label: t, depth: 0, path: null, head: true });
      if (pinned.length) { head('Pinned'); pinned.forEach(s => rows.push({ label: s.title, depth: 1, path: s.id, s })); }
      for (const g of st.groups) { const in_ = rest.filter(s => s.group === g.id); if (in_.length) { head(g.name); in_.forEach(s => rows.push({ label: s.title, depth: 1, path: s.id, s })); } }
      head('Sessions'); rest.filter(s => !s.group || !st.groups.some(g => g.id === s.group)).forEach(s => rows.push({ label: s.title, depth: 1, path: s.id, s }));
      return rows;
    };
    const DOT = { working: '#0000a8', waiting: '#a8a800', failed: '#a80000', idle: null };
    const sidebar = {
      type: 'custom', x: 6, y: 6, w: SIDE, h: H - 12, list: [], top: 0, sel: null, open: new Set(),
      get hidden() { return sidebarCollapsed; },
      draw(a, foc, w) {
        const g = ui.gfx; g.field(a.x, a.y, a.w, a.h);
        this.inner = { x: a.x + 2, y: a.y + 2, w: a.w - 4, h: a.h - 4 }; this.list = visibleSessions(); this.sel = shown;
        this.list.forEach((r, i) => {
          const y = this.inner.y + (i - this.top) * 17 + 1; if (y + 16 > this.inner.y + this.inner.h) return;
          if (r.head) { g.text(g.esc(r.label), this.inner.x + 4, y + 2, g.K.sh, true); return; }
          const on = r.path === shown, lbl = g.ellipsis(g.esc(r.label), this.inner.w - 40), tx = this.inner.x + 2 + r.depth * 19;
          const dot = r.s.unread ? '#0000ff' : DOT[r.s.state];
          if (dot) g.fill(tx + 4, y + 5, 6, 6, dot);
          if (on) g.fill(tx + 18, y + 1, g.textW(lbl) + 4, 14, w.isActive ? g.K.sel : g.K.face);
          g.text(lbl, tx + 20, y + 2, on && w.isActive ? g.K.hl : r.s.archived ? g.K.sh : g.K.dk);
        });
      },
      down(x, y) { const i = this.top + Math.floor((y - this.inner.y) / 17), r = this.list[i]; if (r && r.path) { show(r.path); const s = byId(r.path); if (s.unread) { s.unread = false; save('sessions'); } } return null; },
      key(e) {
        const ids = this.list.filter(r => r.path).map(r => r.path), k = ids.indexOf(shown);
        if (e.key === 'ArrowDown' && k < ids.length - 1) { show(ids[k + 1]); return true; }
        if (e.key === 'ArrowUp' && k > 0) { show(ids[k - 1]); return true; }
        return false;
      },
    };
    const BOX = 92;   // the next-step box's height
    const pane = {
      type: 'custom', get x() { return sidebarCollapsed ? 6 : SIDE + 12; }, y: 6, get w() { return W - this.x - 6; }, h: H - 12 - BOX - 6,
      draw(a) {
        const g = ui.gfx, s = byId(shown) || self; g.field(a.x, a.y, a.w, a.h);
        let y = a.y + 6; const x = a.x + 8, tw = a.w - 16;
        const line = (t, o = {}) => { for (const l of g.wrap(g.esc(t), tw - (o.indent || 0))) { if (y + 13 > a.y + a.h - 4) return; g.text(l, x + (o.indent || 0), y, o.color || g.K.dk, !!o.bold); y += 13; } };
        line(s.title, { bold: true }); line(`${s.state}${s.archived ? ', archived' : ''} \u00b7 ${s.cwd}`, { color: g.K.sh }); y += 4;
        if (s.plan.length) {
          line('Tasks', { bold: true });
          for (const p of s.plan) line(`${p.status === 'completed' ? '[x]' : p.status === 'in_progress' ? '[>]' : '[ ]'} ${p.content}${p.session ? ` (${p.session})` : ''}`, { indent: 6 });
          y += 4;
        }
        const msgs = s.transcript.filter(m => s.view !== 'normal' || m.role !== 'tool');
        if (msgs.length) {
          line('Transcript', { bold: true });
          const fit = Math.max(1, Math.floor((a.y + a.h - y) / 14));
          for (const m of msgs.slice(-fit)) line(m.role === 'chapter' ? `\u2014 ${m.text} \u2014` : `${m.role}: ${m.text}`, { indent: 6, color: m.role === 'chapter' ? g.K.sh : g.K.dk, bold: m.role === 'chapter' });
        }
      },
    };
    const box = {
      // (its height stops above its buttons, so a press there reaches them: it is drawn the whole BOX high)
      type: 'custom', get x() { return pane.x; }, y: H - 6 - BOX, get w() { return pane.w; }, h: BOX - 36,
      draw(a) {
        const g = ui.gfx, s = byId(shown) || self, n = s.next; g.btnUp(a.x, a.y, a.w, BOX);
        if (!n) { g.text('No next step', a.x + 8, a.y + 8, g.K.sh); return; }
        let y = a.y + 6;
        for (const l of g.wrap(g.esc(n.recap), a.w - 16).slice(0, n.ask ? 3 : 5)) { g.text(l, a.x + 8, y); y += 13; }
        if (n.ask) g.text(g.ellipsis(g.esc(n.ask), a.w - 16, true), a.x + 8, y + 2, g.K.dk, true);
      },
    };
    // the next-step box's buttons and a card's: real buttons, so win95.click({ name }) presses them
    const actBtn = i => ({
      type: 'button', h: 23, get x() { return box.x + box.w - 8 - (2 - i) * 112 + (this.solo ? 112 : 0); }, y: H - 6 - 31, w: 106, label: '',
      get hidden() { const n = (byId(shown) || self).next; return !(n && n.actions && n.actions[i]); },
      get solo() { const n = (byId(shown) || self).next; return i === 0 && !!(n && n.actions && n.actions.length === 1); },
      fn: () => answer(byId(shown) || self, i),
    });
    const btns = [actBtn(0), actBtn(1)];
    const refreshLabels = () => { const n = (byId(shown) || self).next; btns.forEach((b, i) => { b.label = n && n.actions && n.actions[i] ? (n.actions[i].label || n.actions[i].action || 'OK').replace(/&/g, '&&') : ''; b.def = i === 0; }); };
    function show(id) { shown = id; refreshLabels(); if (win) ui.dirty(); }
    function openWindow(focus = true) {
      refreshLabels();
      if (win && ui.windows().includes(win)) { if (focus) ui.activate(win); ui.dirty(); return win; }
      win = ui.dialog('Claude', W, H, [sidebar, pane, box, ...btns], { modal: false, noTask: false, icon: ui.icon || null });
      win.ccd = true; return win;
    }
    function answer(s, i) {
      const n = s.next; if (!n || !n.actions || !n.actions[i]) return;
      const a = n.actions[i], message = a.message || a.label || a.action;
      s.next = null; said(s, 'user', message); if (s.state === 'waiting') s.state = 'idle';
      save('sessions'); refreshLabels(); ui.dirty();
      ui.emit('ccd.answer', { session: s.id, label: a.label || a.action, message, action: a.action || null });
    }

    // ---------------------------------------------------------------- cards (start_session proposals and offers)
    const cardWins = new Map();
    function cardBox(card, buttons) {
      return new Promise(ok => {
        const w = ui.msgBox(card.kind === 'offer' ? 'New task' : 'Suggested task', `${card.title}${card.prompt ? `\n\n${card.prompt.slice(0, 400)}` : ''}`, 'info', buttons, b => { cardWins.delete(card.task_id); ok(b); }, { modal: false });
        cardWins.set(card.task_id, w);
      });
    }
    const dropCard = id => { st.cards = st.cards.filter(c => c.task_id !== id); save('cards'); const w = cardWins.get(id); if (w) { ui.closeWin(w, true); cardWins.delete(id); } };
    function startFrom(card, o = {}) {
      const s = fresh({ title: card.title, name: card.name || slug(card.title), startedBy: self.id, state: 'working', cwd: card.cwd || self.cwd, ...o });
      if (card.prompt) said(s, 'user', card.prompt);
      if (card.background) said(s, 'user', card.background);
      st.sessions.push(s); save('sessions'); ui.emit('ccd.session.start', { session: s.id, title: s.title, prompt: card.prompt || '' }); ui.dirty();
      return s;
    }

    // ---------------------------------------------------------------- the tools
    class CcdError extends Error {}
    const not = what => { throw new CcdError(what); };
    const T = {};
    T.turn = {
      update_plan(a) {
        const s = self;
        if (a.items) {
          if (!a.scope) not('scope is required with items: "first_task", "continuation" or "new_task".');
          if (!Array.isArray(a.items) || !a.items.length || a.items.length > 12) not('items: 1 to 12 steps.');
          s.plan = a.items.map(it => ({ content: String(it.content), status: it.status || 'pending', ...(it.session ? { session: it.session } : {}) }));
          s.state = 'working'; save('sessions'); openWindow(false); ui.dirty();
          return `Plan shown (${s.plan.length} step${s.plan.length === 1 ? '' : 's'}).`;
        }
        if (!s.plan.length) not('No plan yet: send items first.');
        if (a.advance) {
          const i = s.plan.findIndex(p => p.status === 'in_progress'); if (i >= 0) s.plan[i].status = 'completed';
          const j = s.plan.findIndex(p => p.status === 'pending'); if (j >= 0) s.plan[j].status = 'in_progress';
        }
        for (const d of a.done || []) if (s.plan[d - 1]) s.plan[d - 1].status = 'completed';
        if (a.start) { s.plan.forEach(p => { if (p.status === 'in_progress') p.status = 'pending'; }); if (s.plan[a.start - 1]) s.plan[a.start - 1].status = 'in_progress'; }
        save('sessions'); ui.dirty();
        const k = s.plan.findIndex(p => p.status === 'in_progress');
        return k >= 0 ? `Plan updated: step ${k + 1} of ${s.plan.length} is in progress.` : `Plan updated: ${s.plan.filter(p => p.status === 'completed').length} of ${s.plan.length} steps done.`;
      },
      wrap_up(a) {
        const s = self;
        if (a.ask && a.ask.length > 100) not('ask: at most 100 characters.');
        if (a.actions && (a.actions.length < 1 || a.actions.length > 2)) not('actions: 1 or 2 buttons.');
        if (a.actions && !a.ask) not('actions answer the ask: send ask with them.');
        s.plan.forEach(p => { if (p.status !== 'completed') p.status = 'completed'; });
        s.next = { recap: a.recap, ask: a.ask || null, actions: a.ask ? a.actions || [{ label: 'OK' }] : null, blocked: !!a.blocked };
        s.state = a.blocked ? 'waiting' : 'idle';
        said(s, 'assistant', a.recap);
        save('sessions'); show(s.id); openWindow(false);
        notify(a.ask ? 'question' : 'task_complete');
        if (keepAwake && keepAwake.until === 'turn_end') { keepAwake = null; ui.holdSaver(false); }
        return a.ask ? 'Shown in the next-step box. Your closing message is your answer to the user: write it now, in full, as the last thing you say this turn. The box asks your question, so do not ask it again.'
          : 'Nothing is pending, so the app draws no box; the recap is the session\'s status. Your closing message is your answer to the user: write it now, as the last thing you say this turn.';
      },
    };
    T.session = {
      async start_session(a) {
        if (a.proposal_id) {
          const card = st.cards.find(c => c.task_id === a.proposal_id); if (!card) not(`No proposal ${a.proposal_id}: it was started, dismissed or has expired.`);
          dropCard(card.task_id); const s = startFrom({ ...card, ...(a.prompt ? { prompt: a.prompt } : {}) });
          return `Started "${s.title}" (session_id: ${s.id}, name: ${s.name}).`;
        }
        if (!a.initiation) not('initiation is required unless proposal_id is set.');
        if (!a.title) not('title is required unless proposal_id is set.');
        if (a.target === 'cloud' || a.target === 'ssh') not(`Windows 95 has no ${a.target === 'cloud' ? 'cloud environments' : 'SSH connections'}: list_start_targets lists the places a session can start.`);
        if (a.initiation === 'offer') {
          const card = { task_id: uid('task'), kind: 'offer', title: a.title, created: now() };
          st.cards.push(card); save('cards');
          const b = await cardBox(card, ['New session', 'Do it here']);
          ui.emit('ccd.answer', { card: card.task_id, label: b, message: b });
          if (b === 'Do it here') { dropCard(card.task_id); return 'The user chose Do it here: carry on with the task in this session.'; }
          card.kind = 'own_initiative'; save('cards');
          return `The user chose New session: call start_session with proposal_id "${card.task_id}" and the brief as prompt to start it.`;
        }
        if (!a.prompt) not('prompt (the brief) is required for "user_asked" and "own_initiative".');
        if ((a.context || 'fresh') === 'fresh' && (!a.background || a.background.length < 80)) not('background: at least 80 characters, required with context "fresh".');
        const card = { task_id: uid('task'), kind: a.initiation, title: a.title, name: a.name, prompt: a.prompt, background: a.background, cwd: a.cwd, created: now(), expires: now() + 7 * 864e5 };
        if (a.initiation === 'user_asked') { const s = startFrom(card, a.permission_mode ? { permissionMode: a.permission_mode } : {}); return `Started "${s.title}" (session_id: ${s.id}, name: ${s.name}).`; }
        st.cards.push(card); save('cards');
        cardBox(card, ['Start', 'Dismiss']).then(b => {
          ui.emit('ccd.answer', { card: card.task_id, label: b, message: b });
          if (!st.cards.some(c => c.task_id === card.task_id)) return;
          dropCard(card.task_id); if (b === 'Start') startFrom(card);
        });
        return `Proposed "${card.title}" as a card the user can start (task_id: ${card.task_id}); it expires in 7 days.`;
      },
      dismiss_task(a) {
        if (!st.cards.some(c => c.task_id === a.task_id)) not(`No proposal ${a.task_id} waiting: it was started, answered or dismissed already.`);
        dropCard(a.task_id); return `Dismissed${a.reason ? `: ${a.reason}` : '.'}`;
      },
      hand_off_to_session(a) {
        const s = startFrom({ title: a.title, prompt: `Remaining plan:\n${a.remaining_plan}` }, { transcript: self.transcript.slice() });
        return `Handed off to "${s.title}" (session_id: ${s.id}, name: ${s.name}): stop that task here and answer the new message.`;
      },
      mark_chapter(a) {
        self.chapters.push({ title: a.title, summary: a.summary || '', t: now() }); said(self, 'chapter', a.title, { summary: a.summary || '' });
        save('sessions'); ui.dirty(); return `Chapter "${a.title}" marked.`;
      },
      read_widget_context(a) {
        if (a.tool_name !== 'claude' && a.tool_name !== 'Claude') not(`No widget ${JSON.stringify(a.tool_name)}: the one widget is "claude", the Claude window.`);
        const s = byId(shown) || self;
        return JSON.stringify({ open: !!(win && ui.windows().includes(win)), session: s.id, title: s.title, plan: s.plan, next: s.next, sidebarCollapsed });
      },
      list_start_targets() {
        const folders = ui.fs.volumes().filter(v => v.ready !== false).map(v => ({ path: v.root, label: v.label || '', kind: v.kind }));
        return JSON.stringify({ this_computer: { project: self.cwd, folders }, ssh: [], cloud: [], presets: [] });
      },
      move_to_cloud() { not('Windows 95 has no cloud: nothing moved, and this session stays here.'); },
    };
    T.session_mgmt = {
      list_sessions(a) {
        let l = st.sessions.filter(s => s !== self && (a.include_archived || !s.archived));
        if (a.linked) { const f = family(self); l = l.filter(s => f.includes(s)); }
        if (a.group) { const g = st.groups.find(x => x.id === a.group || x.name === a.group); l = l.filter(s => g && s.group === g.id); }
        return JSON.stringify(l.sort((x, y) => y.active - x.active).slice(0, a.limit || 20).map(row));
      },
      get_session(a) {
        const s = need(a.session_id);
        return JSON.stringify({ ...row(s), created: new Date(s.created).toISOString(), model: s.model, effort: s.effort, fastMode: s.fastMode,
          ...(s === self || s.startedBy === self.id ? { outputStyle: s.outputStyle, permissionMode: s.permissionMode } : {}),
          remoteControlState: s.remoteControlState, ...(s.startedBy ? { parentSessionId: s.startedBy, detached: s.detached } : {}), worktree: null });
      },
      list_events(a) {
        const s = need(a.session_id); if (s === self) not('session_id must not be the current session.');
        let m = s.transcript; if (a.before_uuid) { const i = m.findIndex(x => x.uuid === a.before_uuid); if (i >= 0) m = m.slice(0, i); }
        m = m.slice(-(a.limit || 40));
        return m.map(x => `[${x.uuid}] ${x.role}: ${x.text}`).join('\n') + (m.length ? `\n(cursor: ${m[0].uuid})` : '(no messages)');
      },
      search_session_transcripts(a) {
        if (String(a.query).length < 2) not('query: at least 2 characters.');
        const q = String(a.query).toLowerCase(), hits = [];
        for (const s of st.sessions) {
          if (s === self || (s.archived && !a.include_archived)) continue;
          const m = s.transcript.find(x => x.text.toLowerCase().includes(q)); if (!m) continue;
          const i = m.text.toLowerCase().indexOf(q);
          hits.push({ sessionId: s.id, title: s.title, snippet: m.text.slice(Math.max(0, i - 60), i + q.length + 60) });
        }
        return JSON.stringify(hits.slice(0, a.limit || 20));
      },
      async archive_session(a) {
        const s = need(a.session_id);
        if (s.state === 'working') not(`"${s.title}" is still working: not archived.`);
        if (s.pinned) not(`"${s.title}" is pinned: not archived.`);
        if (!await approve(`Archive "${s.title}"?${a.reason ? `\n\n${a.reason}` : ''}`)) not('The user declined: nothing was archived.');
        s.archived = true; s.state = 'idle';
        for (const x of st.sessions) if (x.startedBy === s.id && !x.detached && x.state !== 'working') x.archived = true;
        save('sessions'); ui.dirty();
        return s === self ? 'Archived this session: the conversation ends here.' : `Archived "${s.title}".`;
      },
      unarchive_session(a) { const s = need(a.session_id); if (!s.archived) not(`"${s.title}" is not archived.`); s.archived = false; save('sessions'); ui.dirty(); return `Restored "${s.title}".`; },
      async delete_session(a) {
        const ids = a.session_ids; if (!Array.isArray(ids) || !ids.length || ids.length > 25) not('session_ids: 1 to 25 sessions.');
        const ss = ids.map(need); if (ss.includes(self)) not('This session cannot be deleted.');
        const skip = ss.filter(s => s.state === 'working' || s.pinned || s.id === shown), go = ss.filter(s => !skip.includes(s));
        if (go.length && !await approve(`Delete ${go.length} session(s) for good?\n\n${go.map(s => s.title).join('\n')}${a.reason ? `\n\n${a.reason}` : ''}`)) not('The user declined: nothing was deleted.');
        for (const s of go) for (const x of st.sessions) if (x.startedBy === s.id && x.state !== 'working') x.archived = true;
        st.sessions = st.sessions.filter(s => !go.includes(s)); save('sessions'); ui.dirty();
        return JSON.stringify({ deleted: go.map(s => s.id), skipped: skip.map(s => ({ sessionId: s.id, why: s.state === 'working' ? 'working' : s.pinned ? 'pinned' : 'open on screen' })) });
      },
      async clear_session(a) {
        const s = need(a.session_id);
        if (s !== self && s.startedBy !== self.id) not('Only this session or one it started can be cleared.');
        if (s.state === 'working' || s.pinned) not(`"${s.title}" is ${s.pinned ? 'pinned' : 'working'}: not cleared.`);
        if (!await approve(`Clear the conversation of "${s.title}"?`)) not('The user declined: nothing was cleared.');
        s.transcript = []; s.plan = []; s.chapters = []; s.next = null; save('sessions'); ui.dirty();
        return s === self ? 'This session is cleared once this turn ends.' : `Cleared "${s.title}".`;
      },
      stop_session(a) {
        const s = need(a.session_id); if (s === self) not('Not for this session: end your own turn by finishing your reply.');
        if (s.state !== 'working') return `"${s.title}" is ${s.archived ? 'archived' : 'idle'}: left alone.`;
        s.state = 'idle'; save('sessions'); ui.dirty(); ui.emit('ccd.session.stop', { session: s.id }); return `Stopped "${s.title}".`;
      },
      detach_session(a) {
        const s = need(a.session_id);
        if (!(s.startedBy === self.id || (s === self && s.startedBy))) not('Only a session this session started, or "self" when it is a side session.');
        s.detached = true; s.startedBy = null; save('sessions'); return `"${s.title}" is a top-level session now.`;
      },
      set_session_title(a) { const s = need(a.session_id); s.title = String(a.title); save('sessions'); ui.dirty(); return `Renamed to "${s.title}".`; },
      set_session_model(a) { const s = need(a.session_id); if (s === self) not('Refused for this session: ask the user to pick the model in the model menu.'); s.model = a.model; save('sessions'); return `"${s.title}" uses ${a.model} from its next turn.`; },
      set_session_effort(a) { const s = need(a.session_id); if (s === self) not('Refused for this session.'); s.effort = a.effort; save('sessions'); return `"${s.title}" runs at ${a.effort} effort from its next turn.`; },
      set_session_fast_mode(a) { const s = need(a.session_id); s.fastMode = a.enabled ? 'on' : 'off'; save('sessions'); return `Fast mode ${s.fastMode} for "${s.title}".`; },
      async set_session_permission_mode(a) {
        const s = need(a.session_id), order = E.mode;
        if (order.indexOf(a.mode) > order.indexOf(s.permissionMode) && !await approve(`Let "${s.title}" run in ${a.mode} mode?`)) not('The user declined: the permission mode is unchanged.');
        s.permissionMode = a.mode; save('sessions'); return `"${s.title}" is in ${a.mode} mode.`;
      },
      async set_session_output_style(a) {
        const s = need(a.session_id);
        if (!await approve(`Switch "${s.title}" from the ${s.outputStyle} output style to ${a.style}?`)) not('The user declined: the output style is unchanged.');
        s.outputStyle = a.style; save('sessions'); return `"${s.title}" writes in the ${a.style} style from its next turn.`;
      },
      set_remote_control(a) { const s = need(a.session_id); s.remoteControlState = a.enabled ? 'unavailable' : 'off'; save('sessions'); return a.enabled ? 'unavailable: Windows 95 has no claude.ai link.' : 'off'; },
      send_message(a) {
        const s = need(a.session_id); if (s === self) not('session_id must not be the current session.');
        said(s, 'user', `From ${self.title}: ${a.message}`); s.unread = true; save('sessions'); ui.dirty();
        const id = uid('m'), how = s.state === 'working' ? 'queued' : 'delivered';
        ui.emit('ccd.message', { to: s.id, from: self.id, message: a.message, message_id: id });
        return `${how === 'delivered' ? `"${s.title}" has started a turn on your message.` : `Queued behind "${s.title}"'s current work.`} (delivery: ${how}; message_id: ${id})`;
      },
      export_transcript(a) {
        const s = need(a.session_id), dir = 'C:\\My Documents', name = `${s.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'Session'}.TXT`;
        try { if (!ui.fs.exists(dir)) ui.fs.mkdir(dir); } catch (_) { /* the drive will say */ }
        const body = s.transcript.map(m => `${new Date(m.t).toISOString()} ${m.role}: ${m.text}`).join('\r\n') + '\r\n';
        ui.fs.writeFile(`${dir}\\${name}`, body);
        return JSON.stringify({ path: `${dir}\\${name}`, size: body.length });
      },
      get_usage(a) {
        const s = a.session_id ? need(a.session_id) : self, used = s.transcript.reduce((n, m) => n + Math.ceil(m.text.length / 4), 0);
        return JSON.stringify({ plan: { status: 'not_applicable', note: 'Windows 95 has no plan limits.' }, context: { session_id: s.id, tokens: used, percent: +(used / 2e4).toFixed(2) } });
      },
    };
    const builtins = [{ id: 'pinned', kind: 'pinned', name: '' }, { id: 'routines', kind: 'routines', name: '' }, { id: 'sessions', kind: 'sessions', name: '' }];
    T.sidebar = {
      list_groups() { return JSON.stringify(st.groups.map((g, i) => ({ id: g.id, name: g.name, session_count: st.sessions.filter(s => s.group === g.id).length, order: i }))); },
      create_group(a) { const g = { id: uid('grp'), name: String(a.name).slice(0, 200) }; st.groups.push(g); save('groups'); ui.dirty(); return JSON.stringify({ id: g.id }); },
      create_section(a) { return T.sidebar.create_group(a); },
      rename_group(a) { const g = st.groups.find(x => x.id === a.group_id); if (!g) not(`No group ${a.group_id}.`); g.name = String(a.name).slice(0, 200); save('groups'); ui.dirty(); return `Renamed to "${g.name}".`; },
      rename_section(a) { if (builtins.some(b => b.id === a.section_id)) not('Built-in sections cannot be renamed.'); return T.sidebar.rename_group({ group_id: a.section_id, name: a.name }); },
      async delete_group(a) {
        const g = st.groups.find(x => x.id === a.group_id); if (!g) not(`No group ${a.group_id}.`);
        if (!await approve(`Delete the group "${g.name}"? Its sessions move back to Sessions.`)) not('The user declined: the group stays.');
        st.groups = st.groups.filter(x => x !== g); st.sessions.forEach(s => { if (s.group === g.id) s.group = null; }); save('groups'); save('sessions'); ui.dirty();
        return `Deleted "${g.name}".`;
      },
      delete_section(a) { if (builtins.some(b => b.id === a.section_id)) not('Built-in sections cannot be deleted.'); return T.sidebar.delete_group({ group_id: a.section_id }); },
      list_sections() {
        const v = st.view.sections || {}, sec = (o, i) => ({ ...o, order: i, session_count: o.id === 'pinned' ? st.sessions.filter(s => s.pinned).length : o.id === 'sessions' ? st.sessions.filter(s => !s.group).length : o.id === 'routines' ? 0 : st.sessions.filter(s => s.group === o.id).length,
          group_by: (v[o.id] || {}).group_by || 'none', sort_by: (v[o.id] || {}).sort_by || 'recency', ascending: false, collapsed: false, shown: true });
        return JSON.stringify([...builtins, ...st.groups.map(g => ({ id: g.id, kind: 'manual', name: g.name }))].map(sec));
      },
      move_sessions(a) {
        const to = a.section_id === 'sessions' ? null : a.section_id || a.group_id || null;
        if (to && !st.groups.some(g => g.id === to)) not(`No group ${to}.`);
        const ss = a.session_ids.map(need); ss.forEach(s => { s.group = to; if (to && s.pinned) s.pinned = false; });
        save('sessions'); ui.dirty(); return `Moved ${ss.length} session(s) to ${to ? `"${st.groups.find(g => g.id === to).name}"` : 'Ungrouped'}.`;
      },
      set_pinned(a) { const s = need(a.session_id); s.pinned = !!a.pinned; save('sessions'); ui.dirty(); return `${a.pinned ? 'Pinned' : 'Unpinned'} "${s.title}".`; },
      set_unread(a) { const s = need(a.session_id); s.unread = !!a.unread; save('sessions'); ui.dirty(); return `"${s.title}" is ${a.unread ? 'unread' : 'read'}.`; },
      mark_completed(a) { const s = need(a.session_id); if (s.state === 'waiting' || s.state === 'failed') s.state = 'idle'; s.unread = false; save('sessions'); ui.dirty(); return `"${s.title}" reads as completed.`; },
      set_view(a) {
        if (a.section_id && a.section_id !== 'sessions') {
          if (a.status !== undefined || a.last_activity !== undefined) not('status and last_activity are refused with a section_id.');
          st.view.sections = { ...st.view.sections, [a.section_id]: { ...(st.view.sections || {})[a.section_id], ...(a.group_by ? { group_by: a.group_by } : {}), ...(a.sort_by ? { sort_by: a.sort_by } : {}) } };
        } else for (const k of ['group_by', 'status', 'sort_by', 'last_activity']) if (a[k] !== undefined) st.view[k] = a[k];
        save('view'); ui.dirty();
        const { sections, ...v } = st.view; return JSON.stringify({ ...v, ...(a.section_id ? { section_shown: true } : {}) });
      },
    };
    // panes: what each opens in Windows 95, kept so close_pane can close it
    const panes = new Map();
    const openedWin = (before) => ui.windows().find(w => !before.includes(w)) || null;
    T.view = {
      show_pane(a) {
        const before = ui.windows().slice();
        if (a.pane === 'file') {
          if (!a.path) not('path is required for the file pane.');
          if (!ui.fs.exists(a.path)) not(`${a.path} does not exist.`);
          ui.notepad(a.path); panes.set('file', openedWin(before)); return `Opened ${a.path}${a.line ? ` at line ${a.line}` : ''} in Notepad.`;
        }
        if (a.pane === 'terminal') { ui.runCommand('COMMAND.COM'); panes.set('terminal', openedWin(before)); return 'Opened an MS-DOS Prompt.'; }
        if (a.pane === 'plan') { show(self.id); openWindow(); panes.set('plan', win); return 'Showing the plan in the Claude window.'; }
        if (a.pane === 'tasks') { ui.key('ctrl+alt+delete'); return 'Showing the running programs (Close Program).'; }
        if (a.pane === 'preview') { window.focus(); return 'The Windows 95 screen is in front.'; }
        return `There is no ${a.pane} pane in Windows 95: nothing shown.`;
      },
      close_pane(a) {
        const w = panes.get(a.pane); panes.delete(a.pane);
        if (!w || !ui.windows().includes(w)) return `The ${a.pane} pane is not open: nothing to close.`;
        ui.closeWin(w); return `Closed the ${a.pane} pane.`;
      },
      get_layout() {
        const open = win && ui.windows().includes(win);
        return JSON.stringify({ views: open ? [{ where: splits.length ? 'split' : 'main', window: 'Claude' }] : [], open_panes: [...panes].filter(([, w]) => w && ui.windows().includes(w)).map(([k]) => k), popped_out_panes: [], transcript_view: self.view });
      },
      set_transcript_view(a) {
        const s = a.session_id ? need(a.session_id) : self; if (s !== self && s.startedBy !== self.id) not('Only this session or a side session it started.');
        s.view = a.view; save('sessions'); ui.dirty(); return `"${s.title}" shows the ${a.view} view.`;
      },
    };
    T.window = {
      get_window_layout() {
        return JSON.stringify({ tab: 'code', windows: ui.windows().filter(w => !w.min).map(w => ({ title: w.title, x: w.x, y: w.y, w: w.w, h: w.h, active: w.isActive })),
          split: splits.map(x => x.session), sidebarCollapsed, thisSession: win && ui.windows().includes(win) ? 'Claude' : null });
      },
      open_session_in(a) {
        const s = need(a.session_id); if (s !== self && s.startedBy !== self.id) not('Only "self" or a session this session started: ask the user to open it from the sidebar.');
        if (a.target === 'focus') { show(s.id); openWindow(); return `Showing "${s.title}".`; }
        // split and window: a second Claude window showing that session, beside this one for split
        const o = openWindow(), half = Math.floor(ui.screen().width / 2);
        const other = ui.msgBox(s.title, `${s.state} \u00b7 ${s.cwd}\n\n${s.transcript.slice(-8).map(m => `${m.role}: ${m.text}`).join('\n') || '(no messages yet)'}`, null, ['Close'], () => { splits = splits.filter(x => x.win !== other); }, { modal: false });
        if (a.target === 'split') { o.x = 0; o.y = 0; other.x = half; other.y = 0; }
        splits.push({ session: s.id, win: other }); ui.dirty();
        return `Opened "${s.title}" ${a.target === 'split' ? 'in split view beside this session' : 'in a window of its own'}.`;
      },
      close_split(a) {
        const i = a.session_id ? splits.findIndex(x => x.session === (byId(a.session_id) || {}).id) : splits.length - 1;
        if (i < 0) return 'No split pane of yours is open.';
        const [x] = splits.splice(i, 1); ui.closeWin(x.win, true); return 'Closed the split pane.';
      },
      set_sidebar_collapsed(a) {
        if (sidebarCollapsed === !!a.collapsed) return `The sidebar is already ${a.collapsed ? 'collapsed' : 'expanded'}.`;
        sidebarCollapsed = !!a.collapsed; ui.dirty(); return `Sidebar ${a.collapsed ? 'collapsed' : 'expanded'}.`;
      },
    };
    const setting = k => (st.settings[k] !== undefined ? st.settings[k] : SETTINGS[k].v);
    T.settings = {
      get_settings() {
        return JSON.stringify({ settings: Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, { value: setting(k), accepts: d.accepts, does: d.does }])),
          facts: { default_permission_mode: self.permissionMode, bypass_disabled_by_policy: false, auto_disabled_by_policy: false, worktree_location: null, browser_tools: false } });
      },
      async set_setting(a) {
        const d = SETTINGS[a.key]; if (!d) not(`${a.key} is not a setting get_settings lists.`);
        const v = a.value, bool = /true \| false/.test(d.accepts);
        if (bool && typeof v !== 'boolean') not(`${a.key} takes true or false.`);
        if (a.key === 'auto_archive_inactive_days' && !(Number.isInteger(v) && v >= 0)) not(`${a.key} takes a whole number of days.`);
        if (/all \| none/.test(d.accepts) && !['all', 'none'].includes(v)) not(`${a.key} takes "all" or "none".`);
        if (setting(a.key) === v) not(`${a.key} is already ${JSON.stringify(v)}.`);
        if (!await approve(`Change ${a.key} from ${JSON.stringify(setting(a.key))} to ${JSON.stringify(v)}?`)) not('The user declined: the setting is unchanged.');
        st.settings[a.key] = v; save('settings'); return `${a.key} is ${JSON.stringify(v)}.`;
      },
    };
    const noPr = 'No pull request: Windows 95 has no GitHub, and this session has no PR bound.';
    T.pr = { get_status() { return JSON.stringify({ pr: null, note: noPr }); }, bind_pr() { not(noPr); }, unbind_pr() { not(noPr); }, set_auto_merge() { not(noPr); }, set_monitor() { not(noPr); } };
    const noWorktree = 'This session has no worktree: Windows 95 sessions work in a folder, and there is no git here.';
    T.host = {
      open_in_editor(a) { if (!ui.fs.exists(a.path)) not(`${a.path} does not exist.`); ui.notepad(a.path); return `Opened ${a.path} in Notepad.`; },
      reveal_path(a) {
        if (!ui.fs.exists(a.path)) not(`${a.path} does not exist.`);
        const st_ = ui.fs.stat(a.path), dir = st_.isDir ? a.path : a.path.replace(/\\[^\\]*$/, '') || a.path;
        ui.openPath(dir); return `Showed ${a.path} in its folder.`;
      },
      request_keep_awake(a) { keepAwake = { until: a.until, reason: a.reason }; ui.holdSaver(true); return `Holding off the screen saver until ${a.until === 'turn_end' ? 'this turn ends' : 'the session goes quiet'}.`; },
      get_storage_usage() {
        return JSON.stringify({ drives: ui.fs.volumes().filter(v => v.ready !== false).map(v => ({ drive: v.root, label: v.label || '', total: v.total || 0, used: v.used || 0, free: (v.total || 0) - (v.used || 0) })),
          sessions: st.sessions.length, transcripts_bytes: st.sessions.reduce((n, s) => n + JSON.stringify(s.transcript).length, 0), worktrees: [] });
      },
      sync_with_base_branch() { not(noWorktree); }, clean_up_worktrees() { return JSON.stringify({ removed: [], freed: 0, note: noWorktree }); }, discard_kept_worktree() { not(noWorktree); },
    };
    T.directory = {
      async change_directory(a) {
        if (!ui.fs.exists(a.path) || !ui.fs.stat(a.path).isDir) not(`${a.path} is not a folder.`);
        if (!await approve(`Move this session to ${a.path}?`)) not('The user declined: the session stays where it is.');
        self.cwd = ui.fs.realpath ? ui.fs.realpath(a.path) : a.path; save('sessions'); ui.dirty(); return `Access granted; the session works in ${self.cwd} from the end of this turn.`;
      },
      async request_directory(a) {
        if (a.path) {
          if (!ui.fs.exists(a.path)) not(`${a.path} does not exist.`);
          if (!await approve(`Let this session use ${a.path}?`)) not('The user declined.');
          (self.dirs = self.dirs || []).push(a.path); save('sessions'); return `Access to ${a.path} granted.`;
        }
        const p = await pickFolder(self.cwd);
        if (!p) not('The user picked no folder.');
        (self.dirs = self.dirs || []).push(p); save('sessions'); return `Access to ${p} granted.`;
      },
    };
    const SERVERS = () => [
      { name: 'shares', kind: 'server', status: window.W95HOST && window.W95HOST.shares ? 'connected' : 'failed', tool_count: ((window.W95HOST && window.W95HOST.shares && window.W95HOST.shares.list()) || []).length },
      { name: 'cd', kind: 'server', status: ui.fs.volumes().some(v => v.kind === 'cdrom' && v.ready !== false) ? 'connected' : 'pending', tool_count: 1 },
      { name: 'network', kind: 'connector', status: ui.netUp() ? 'connected' : 'pending', tool_count: ui.netUp() ? 1 : 0 },
      { name: 'sound', kind: 'server', status: 'connected', tool_count: 1 },
    ];
    T.connectors = {
      session_connectors_status() { return JSON.stringify(SERVERS().map(s => (self.connectorsOff.includes(s.name) ? { ...s, status: 'disabled', tool_count: 0 } : s))); },
      set_session_connector_enabled(a) {
        const c = SERVERS().find(s => s.name === a.connector); if (!c) not(`No connector ${a.connector}: session_connectors_status lists them.`);
        if (c.kind !== 'connector') not(`${a.connector} is a ${c.kind}, managed from its own settings.`);
        self.connectorsOff = self.connectorsOff.filter(n => n !== c.name).concat(a.enabled ? [] : [c.name]); save('sessions');
        return `${c.name} is ${a.enabled ? 'on' : 'off'} for this session from the next turn.`;
      },
      async reconnect_session_connector(a) {
        const c = SERVERS().find(s => s.name === a.server); if (!c) not(`No server ${a.server}.`);
        if (c.name === 'network') { await ui.netBoot(); return 'The network is reconnecting; check session_connectors_status next turn.'; }
        if (c.kind !== 'connector') not(`${a.server} is a ${c.kind}: the user reconnects it.`);
        return `${a.server} reconnects when this turn ends.`;
      },
    };

    // ---------------------------------------------------------------- the calls: checked, run, answered, emitted
    const api = {};
    for (const [server, tools] of Object.entries(SCHEMA)) {
      api[server] = {};
      for (const [tool, sc] of Object.entries(tools)) {
        api[server][tool] = async (args = {}) => {
          let result, error = null;
          try {
            for (const k of sc.req || []) if (args[k] === undefined || args[k] === null || args[k] === '') not(`${k} is required.`);
            for (const [k, vs] of Object.entries(sc.enums || {})) if (args[k] !== undefined && !vs.includes(args[k])) not(`${k} must be one of ${vs.map(v => JSON.stringify(v)).join(', ')}.`);
            result = await T[server][tool](args);
          } catch (e) { if (!(e instanceof CcdError)) throw e; error = e.message; }
          ui.emit(`ccd.${server}.${tool}`, { args, result: error ? null : result, error });
          if (error) throw new CcdError(error);
          return result;
        };
      }
    }
    api.open = () => openWindow();
    api.answer = (i = 0) => answer(byId(shown) || self, i);
    api.Error = CcdError;
    api.state = () => JSON.parse(JSON.stringify(st));
    api.tools = () => Object.fromEntries(Object.entries(SCHEMA).map(([s, t]) => [s, Object.keys(t)]));
    return api;
  };
})();
