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

  // ---------------------------------------------------------------- the tools as Claude is given them
  // each tool's parameters: name:type (s string, n number, b boolean, a array of strings, n[] array of numbers, items and
  // actions their objects, v any); required ones and enums from SCHEMA
  const PARAMS = {
    turn: { update_plan: 'items:items scope advance:b done:n[] start:n', wrap_up: 'recap ask actions:actions blocked:b' },
    session: { start_session: 'title initiation prompt background context name cwd proposal_id permission_mode effort model target', dismiss_task: 'task_id reason',
      hand_off_to_session: 'title remaining_plan', mark_chapter: 'title summary', read_widget_context: 'tool_name', list_start_targets: '', move_to_cloud: 'summary' },
    session_mgmt: { list_sessions: 'include_archived:b limit:n linked:b group', get_session: 'session_id', list_events: 'session_id limit:n before_uuid',
      search_session_transcripts: 'query include_archived:b limit:n', archive_session: 'session_id reason', unarchive_session: 'session_id',
      delete_session: 'session_ids:a reason force_worktree_cleanup:b', clear_session: 'session_id', stop_session: 'session_id', detach_session: 'session_id',
      set_session_title: 'session_id title', set_session_model: 'session_id model', set_session_effort: 'session_id effort', set_session_fast_mode: 'session_id enabled:b',
      set_session_permission_mode: 'session_id mode', set_session_output_style: 'session_id style', set_remote_control: 'session_id enabled:b',
      send_message: 'session_id message', export_transcript: 'session_id', get_usage: 'session_id' },
    sidebar: { list_groups: '', create_group: 'name', rename_group: 'group_id name', delete_group: 'group_id', list_sections: '', create_section: 'name',
      rename_section: 'section_id name', delete_section: 'section_id', move_sessions: 'session_ids:a group_id section_id', set_pinned: 'session_id pinned:b',
      set_unread: 'session_id unread:b', mark_completed: 'session_id', set_view: 'group_by status sort_by last_activity:n section_id' },
    view: { show_pane: 'pane path line:n', close_pane: 'pane', get_layout: '', set_transcript_view: 'view session_id' },
    window: { get_window_layout: '', open_session_in: 'session_id target', close_split: 'session_id', set_sidebar_collapsed: 'collapsed:b' },
    settings: { get_settings: '', set_setting: 'key value:v' },
    pr: { get_status: 'session_id', bind_pr: 'url', unbind_pr: 'url', set_auto_merge: 'enabled:b url merge_method', set_monitor: 'auto_fix:b auto_archive_on_close:b url' },
    host: { open_in_editor: 'path line:n', reveal_path: 'path', request_keep_awake: 'until reason', get_storage_usage: '', sync_with_base_branch: 'base abort:b',
      clean_up_worktrees: 'older_than_days:n', discard_kept_worktree: 'session_id' },
    directory: { change_directory: 'path', request_directory: 'path' },
    connectors: { session_connectors_status: '', set_session_connector_enabled: 'connector enabled:b', reconnect_session_connector: 'server' },
  };
  const DESC = {
    turn: { update_plan: 'Keep this session\'s task list: {items, scope} sets the whole plan (scope "first_task", "continuation" or "new_task"); {advance: true} completes the step in progress and starts the next; {done: [n], start: n} by 1-based number.',
      wrap_up: 'End the turn with the next-step box: a short recap of what is now true; with a pending decision, one question (ask) and 1 or 2 buttons (actions: {label, message}). The button the user presses comes back as their next message.' },
    session: { start_session: 'Start a separate session for a task: initiation "user_asked" starts it now (prompt and background, 80+ characters, required); "own_initiative" proposes it as a card; "offer" asks the user New session or Do it here and waits. proposal_id starts a card.',
      dismiss_task: 'Withdraw a proposal card (task_id) the user has not started.', hand_off_to_session: 'Move the current task to a new session with the remaining plan.',
      mark_chapter: 'Mark the start of a new chapter in this session\'s transcript.', read_widget_context: 'Read the Claude window\'s state (tool_name "claude").',
      list_start_targets: 'List where a session can start: this computer\'s drives.', move_to_cloud: 'Move this session to the cloud (refused: Windows 95 has none).' },
    session_mgmt: { list_sessions: 'List the other sessions.', get_session: 'One session\'s metadata ("self" for this one).', list_events: 'Read another session\'s transcript.',
      search_session_transcripts: 'Search the sessions\' transcripts.', archive_session: 'Archive a session (the user is asked).', unarchive_session: 'Restore an archived session.',
      delete_session: 'Delete sessions for good (the user is asked).', clear_session: 'Clear a session\'s conversation (the user is asked).', stop_session: 'Stop another session\'s turn.',
      detach_session: 'Move a session this one started to top level.', set_session_title: 'Rename a session.', set_session_model: 'Set another session\'s model.',
      set_session_effort: 'Set another session\'s effort.', set_session_fast_mode: 'Turn fast mode on or off for a session.', set_session_permission_mode: 'Set a session\'s permission mode (a higher one asks the user).',
      set_session_output_style: 'Set a session\'s output style (the user is asked).', set_remote_control: 'Remote Control for a session (unavailable in Windows 95).',
      send_message: 'Send a message to another session.', export_transcript: 'Export a session\'s transcript to C:\\My Documents.', get_usage: 'Context usage for a session.' },
    sidebar: { list_groups: 'List the sidebar\'s groups.', create_group: 'Create a sidebar group.', rename_group: 'Rename a group.', delete_group: 'Delete a group (the user is asked).',
      list_sections: 'List the sidebar\'s sections.', create_section: 'Create a section.', rename_section: 'Rename a section.', delete_section: 'Delete a section (the user is asked).',
      move_sessions: 'File sessions under a group (group_id, or section_id "sessions" for none).', set_pinned: 'Pin or unpin a session.', set_unread: 'Mark a session read or unread.',
      mark_completed: 'Mark a session\'s needs-input dot completed.', set_view: 'How the sidebar lists sessions.' },
    view: { show_pane: 'Show a pane of the Claude window: plan, diff (Changes), tasks, terminal (MS-DOS Prompt), preview; file opens path in Notepad.', close_pane: 'Close a pane.',
      get_layout: 'Where this session is on screen and its open panes.', set_transcript_view: 'Normal, thinking or verbose transcript view.' },
    window: { get_window_layout: 'The windows open on the Windows 95 screen.', open_session_in: 'Show a session: focus, split or a window of its own.', close_split: 'Close a split you opened.',
      set_sidebar_collapsed: 'Collapse or expand the Claude window\'s sidebar.' },
    settings: { get_settings: 'The app\'s preferences.', set_setting: 'Change one preference (the user is asked).' },
    pr: { get_status: 'The session\'s pull request (none in Windows 95).', bind_pr: 'Bind a PR (none in Windows 95).', unbind_pr: 'Unbind a PR.', set_auto_merge: 'Auto-merge (none).', set_monitor: 'CI monitor (none).' },
    host: { open_in_editor: 'Open a file in Notepad.', reveal_path: 'Show a file or folder in its folder window.', request_keep_awake: 'Hold off the screen saver.',
      get_storage_usage: 'The drives\' space.', sync_with_base_branch: 'Merge the base branch (no git in Windows 95).', clean_up_worktrees: 'Remove idle worktrees (none).',
      discard_kept_worktree: 'Discard a kept worktree (none).' },
    directory: { change_directory: 'Move this session to another folder (the user is asked).', request_directory: 'Ask for access to a folder; without a path the user picks one.' },
    connectors: { session_connectors_status: 'The page\'s hosts as connectors: shares, cd, network, sound.', set_session_connector_enabled: 'Turn a connector on or off for the session.',
      reconnect_session_connector: 'Reconnect a connector.' },
  };
  const TYPE = { s: { type: 'string' }, n: { type: 'number' }, b: { type: 'boolean' }, a: { type: 'array', items: { type: 'string' } }, 'n[]': { type: 'array', items: { type: 'number' } }, v: {},
    items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, session: { type: 'string' } }, required: ['content', 'status'] } },
    actions: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, message: { type: 'string' }, action: { type: 'string' } } } } };
  function inputSchema(server, tool, sc) {
    const properties = {};
    for (const p of (PARAMS[server][tool] || '').split(/\s+/).filter(Boolean)) {
      const [name, t = 's'] = p.split(':');
      properties[name] = sc.enums && sc.enums[name] ? { type: 'string', enum: sc.enums[name] } : { ...TYPE[t] };
    }
    return { type: 'object', properties, ...(sc.req && sc.req.length ? { required: sc.req } : {}) };
  }

  window.W95Ccd = function (ui) {
    const KEY = 'hkcu\\software\\claude\\code';
    const R = ui.W95Win32, FS = window.W95FS;
    // ---------------------------------------------------------------- the records
    const load = (name, dflt) => {
      const v = R.regGet(KEY, name); if (!v) return dflt;
      try { return JSON.parse(typeof v === 'string' ? v : FS.decode(v.data).replace(/\0.*$/, '')); } catch (_) { return dflt; }
    };
    const save = name => { R.regSet(KEY, name, { type: 1, data: FS.encode(JSON.stringify(st[name]) + '\0') }); if (name === 'sessions') rawSessions = R.regGet(KEY, name); };
    // the sessions as the registry has them now: the Claude program (claude-app.js) writes them too, from its machine
    let rawSessions = R.regGet(KEY, 'sessions');
    const sync = () => {
      const v = R.regGet(KEY, 'sessions'); if (v === rawSessions || !v) return;
      rawSessions = v; st.sessions = load('sessions', st.sessions);
      self = st.sessions.find(s => s.id === self.id) || st.sessions.find(s => s.self) || self;
    };
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
    // Laid out as the app's Code tab is (its rendered page: the sidebar; the chat column with the session header,
    // the transcript and the composer over its footer; the panes stacked at the right), at Windows 95's scale
    let win = null, body = null;
    const CR = () => (body && body.r ? body.r : { x: 0, y: 0, w: 640, h: 420 });
    const SBW = 172, HEAD = 30, PROMPT = 28, FOOT = 24;
    let panesOpen = [], tscroll = 0, navBack = [], navFwd = [], railOpen = false;
    const sideW = () => (sidebarCollapsed ? 0 : SBW);
    // (the chat column takes a third of what the sidebar leaves, as the app's, but never under 300 pixels)
    const paneX = () => (panesOpen.length ? Math.min(CR().w - 160, sideW() + Math.max(300, Math.round((CR().w - sideW()) * 0.34))) : CR().w);
    const chatX = () => sideW() + 4, chatW = () => paneX() - sideW() - 8;
    const cur = () => byId(shown) || self;
    const boxH = () => (cur().next ? (cur().next.ask ? 78 : 50) : 0);   // (recap; question; buttons)
    const MODE_LABEL = { default: 'Ask permissions', acceptEdits: 'Edit automatically', plan: 'Plan mode', auto: 'Auto', bypassPermissions: 'Bypass permissions' };
    const PANE_TITLE = { terminal: 'Terminal', diff: 'Changes', preview: 'Preview', files: 'Files', side_chat: 'Side Chat', plan: 'Plan', tasks: 'Tasks' };
    const ago = t => { const s = (now() - t) / 1000; return s < 60 ? 'Just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toLocaleDateString(); };
    const popup = (items, x, y) => ui.popup(items, x, y);
    const visibleSessions = () => {
      let l = st.sessions.filter(s => (st.view.status === 'all' ? true : st.view.status === 'archived' ? s.archived : !s.archived));
      const by = { recency: (a, b) => b.active - a.active, alpha: (a, b) => a.title.localeCompare(b.title), created: (a, b) => b.created - a.created }[st.view.sort_by || 'recency'];
      l = l.sort(by);
      const pinned = l.filter(s => s.pinned), rest = l.filter(s => !s.pinned), rows = [];
      const head = t => rows.push({ label: t, depth: 0, path: null, head: true });
      if (pinned.length) { head('Pinned'); pinned.forEach(s => rows.push({ label: s.title, depth: 1, path: s.id, s })); }
      for (const g of st.groups) { const in_ = rest.filter(s => s.group === g.id); if (in_.length) { head(g.name); in_.forEach(s => rows.push({ label: s.title, depth: 1, path: s.id, s })); } }
      head('Recents'); rest.filter(s => !s.group || !st.groups.some(g => g.id === s.group)).forEach(s => rows.push({ label: s.title, depth: 1, path: s.id, s }));
      return rows;
    };
    const DOT = { working: '#0000a8', waiting: '#a8a800', failed: '#a80000', idle: null };
    // the sidebar: New session, the pinned sessions, each group's, the recents (the filter at their heading), the
    // account at its foot; a row's menu on the right button. Its rows are the elements tree's outline items
    const sessionMenu = s => [
      { label: s.pinned ? 'Unpin' : 'Pin', fn: () => api.sidebar.set_pinned({ session_id: s.id, pinned: !s.pinned }) },
      { label: s.unread ? 'Mark as read' : 'Mark as unread', fn: () => api.sidebar.set_unread({ session_id: s.id, unread: !s.unread }) },
      { label: 'Rename...', fn: () => renameDialog(s) },
      { label: 'Move to group', sub: [...st.groups.map(g => ({ label: g.name, check: s.group === g.id, fn: () => api.sidebar.move_sessions({ session_ids: [s.id], group_id: g.id }) })), { label: 'Ungrouped', check: !s.group, fn: () => api.sidebar.move_sessions({ session_ids: [s.id], section_id: 'sessions' }) }] },
      { sep: true },
      { label: 'Export transcript', fn: () => api.session_mgmt.export_transcript({ session_id: s.id }) },
      { label: s.archived ? 'Unarchive' : 'Archive', disabled: s === self, fn: () => (s.archived ? api.session_mgmt.unarchive_session({ session_id: s.id }) : api.session_mgmt.archive_session({ session_id: s.id })).catch(() => {}) },
      { label: 'Delete', disabled: s === self, fn: () => api.session_mgmt.delete_session({ session_ids: [s.id] }).catch(() => {}) },
    ];
    const filterMenu = () => [
      { label: 'Group by', sub: ['none', 'date', 'state', 'custom'].map(v => ({ label: v[0].toUpperCase() + v.slice(1), check: st.view.group_by === v, fn: () => api.sidebar.set_view({ group_by: v }) })) },
      { label: 'Sort by', sub: [['recency', 'Recent activity'], ['alpha', 'Name'], ['created', 'Date created']].map(([v, l]) => ({ label: l, check: st.view.sort_by === v, fn: () => api.sidebar.set_view({ sort_by: v }) })) },
      { label: 'Show', sub: [['active', 'Active'], ['archived', 'Archived'], ['all', 'All']].map(([v, l]) => ({ label: l, check: st.view.status === v, fn: () => api.sidebar.set_view({ status: v }) })) },
      { sep: true }, { label: 'New group...', fn: () => nameDialog('New Group', '', n => api.sidebar.create_group({ name: n })) },
    ];
    const sidebar = {
      type: 'custom', x: 0, y: 0, get w() { return SBW - 2; }, get h() { return CR().h; }, list: [], top: 0, sel: null, open: new Set(),
      get hidden() { return sidebarCollapsed; },
      draw(a, foc, w) {
        sync();
        const g = ui.gfx; g.field(a.x, a.y, a.w, a.h);
        this.inner = { x: a.x + 2, y: a.y + 2, w: a.w - 4, h: a.h - 4 - 24 };
        this.list = [{ label: 'New session', depth: 0, path: '@new' }, ...visibleSessions()]; this.sel = shown;
        const fit = Math.floor(this.inner.h / 17); this.top = Math.max(0, Math.min(this.top, this.list.length - fit));
        this.list.forEach((r, i) => {
          const y = this.inner.y + (i - this.top) * 17 + 1; if (y < this.inner.y || y + 16 > this.inner.y + this.inner.h) return;
          if (r.head) { g.text(g.esc(r.label), this.inner.x + 4, y + 2, g.K.sh, true); if (r.label === 'Recents') g.text('...', this.inner.x + this.inner.w - 18, y + 1, g.K.sh, true); return; }
          if (r.path === '@new') { g.text('+', this.inner.x + 8, y + 2, g.K.dk, true); g.text('New session', this.inner.x + 22, y + 2, g.K.dk); return; }
          const on = r.path === shown, lbl = g.ellipsis(g.esc(r.label), this.inner.w - 40), tx = this.inner.x + 2 + r.depth * 19;
          const dot = r.s.unread ? '#0000ff' : DOT[r.s.state];
          if (dot) g.fill(tx + 4, y + 5, 6, 6, dot);
          if (on) g.fill(tx + 18, y + 1, g.textW(lbl) + 4, 14, w.isActive ? g.K.sel : g.K.face);
          g.text(lbl, tx + 20, y + 2, on && w.isActive ? g.K.hl : r.s.archived ? g.K.sh : g.K.dk);
        });
        const uy = a.y + a.h - 24;
        g.btnUp(a.x + 2, uy, a.w - 4, 22); g.text(g.ellipsis(g.esc((window.W95HOST && window.W95HOST.userName) || 'User'), a.w - 40), a.x + 8, uy + 4);
        this.userR = { x: a.x + 2, y: uy, w: a.w - 4, h: 22 };
      },
      down(x, y, btn, dbl, a) {
        if (this.userR && y >= this.userR.y) { popup([{ label: 'Settings...', fn: settingsDialog }, { label: 'Keyboard Shortcuts', fn: shortcutsBox }, { sep: true }, { label: 'About Claude', fn: aboutBox }], x, this.userR.y); return null; }
        const i = this.top + Math.floor((y - this.inner.y) / 17), r = this.list[i]; if (!r) return null;
        if (r.head) { if (r.label === 'Recents') popup(filterMenu(), x, y); return null; }
        if (r.path === '@new') { newSession(); return null; }
        if (btn === 2) { popup(sessionMenu(r.s), x, y); return null; }
        show(r.path); if (r.s.unread) { r.s.unread = false; save('sessions'); }
        return null;
      },
      key(e) {
        const ids = this.list.filter(r => r.path && r.path !== '@new').map(r => r.path), k = ids.indexOf(shown);
        if (e.key === 'ArrowDown' && k < ids.length - 1) { show(ids[k + 1]); return true; }
        if (e.key === 'ArrowUp' && k > 0) { show(ids[k - 1]); return true; }
        return false;
      },
    };
    // ---- the session header: the sidebar's button, back and forward, the session's title (its menu), the session
    // rail (its chapters) and the view options
    const hb = (label, x, fn, o = {}) => ({ type: 'button', label, get x() { return x(); }, y: 4, w: o.w || 22, h: 22, fn, ...o });
    const viewMenu = () => [
      { label: 'Transcript view', sub: ['normal', 'thinking', 'verbose'].map(v => ({ label: v[0].toUpperCase() + v.slice(1), check: cur().view === v, fn: () => { cur().view = v; save('sessions'); ui.dirty(); } })) },
      { sep: true },
      ...['terminal', 'diff', 'preview', 'files', 'side_chat', 'plan', 'tasks'].map(p => ({ label: `${panesOpen.includes(p) ? 'Hide' : 'Show'} ${PANE_TITLE[p]}`, fn: () => togglePane(p) })),
      { label: 'Close Pane', disabled: !panesOpen.length, fn: () => closePane() },
    ];
    const titleCtl = {
      type: 'custom', get x() { return sideW() + 108; }, y: 4, get w() { return Math.max(40, chatW() - 108 - 64); }, h: 22,
      draw(a) { const g = ui.gfx; g.text(g.ellipsis(g.esc(cur().title), a.w - 16, true), a.x + 4, a.y + 5, g.K.dk, true); g.text('v', a.x + a.w - 10, a.y + 5, g.K.sh); },
      down(x) { popup([...st.sessions.filter(s => !s.archived).slice(-12).reverse().map(s => ({ label: s.title.replace(/&/g, '&&').slice(0, 48), check: s.id === shown, fn: () => show(s.id) })), { sep: true }, { label: 'Rename...', fn: () => renameDialog(cur()) }, { label: 'New Session', fn: newSession }], x, this.y + 26 + CR().y); return null; },
    };
    const header = [
      hb('Sidebar', () => sideW() + 4, () => setSidebar(!sidebarCollapsed), { w: 52 }),
      hb('<', () => sideW() + 58, () => goBack(), { get disabled() { return !navBack.length; } }),
      hb('>', () => sideW() + 82, () => goFwd(), { get disabled() { return !navFwd.length; } }),
      titleCtl,
      hb('Rail', () => paneX() - 4 - 30 - 30, () => { railOpen = !railOpen; ui.dirty(); }, { w: 28 }),
      hb('View', () => paneX() - 4 - 30, () => popup(viewMenu(), sideW() + chatW() - 120, HEAD + CR().y), { w: 30 }),
    ];
    // ---- the transcript: the user's messages as bubbles at the right, Claude's as text, tool calls as one row each
    // (their input too in the verbose view), chapters as dividers; each message with its actions; the task list and
    // the working line at the end
    const transcript = {
      type: 'custom', get x() { return chatX(); }, y: HEAD, get w() { return chatW(); }, get h() { return CR().h - HEAD - PROMPT - FOOT - boxH() - 10; }, hits: [],
      draw(a) {
        const g = ui.gfx, s = cur(), tw = a.w - 24; g.field(a.x, a.y, a.w, a.h);
        const blocks = [];   // { h, draw(y) } from the top
        const act = (labels, fns) => ({ h: 16, draw: y => { let x = a.x + 10; labels.forEach((l, k) => { const w = g.textW(l); g.text(l, x, y + 1, g.K.sh); hit(x, y, w, 14, fns[k]); x += w + 12; }); } });
        for (const [i, m] of s.transcript.entries()) {
          if (m.role === 'tool' && s.view === 'normal' && m.quiet) continue;
          if (m.role === 'thinking' && s.view === 'normal') continue;
          if (m.role === 'user') {
            const lines = g.wrap(g.esc(m.text), Math.round(tw * 0.75) - 16), bw = Math.min(Math.round(tw * 0.75), Math.max(...lines.map(l => g.textW(l))) + 16);
            blocks.push({ h: lines.length * 13 + 10, msg: i, draw: y => { const bx = a.x + a.w - 12 - bw; g.fill(bx, y, bw, lines.length * 13 + 8, '#ffffe1'); g.fill(bx, y, bw, 1, g.K.sh); g.fill(bx, y + lines.length * 13 + 7, bw, 1, g.K.sh); g.fill(bx, y, 1, lines.length * 13 + 8, g.K.sh); g.fill(bx + bw - 1, y, 1, lines.length * 13 + 8, g.K.sh); lines.forEach((l, k) => g.text(l, bx + 8, y + 4 + k * 13)); } });
            blocks.push(act(['Copy', 'Rewind'], [() => copy(m.text), () => rewind(s, i)]));
          } else if (m.role === 'assistant') {
            const lines = g.wrap(g.esc(m.text), tw);
            blocks.push({ h: lines.length * 13 + 4, msg: i, draw: y => lines.forEach((l, k) => g.text(l, a.x + 10, y + k * 13)) });
            blocks.push(act(['Copy', 'Fork', 'Pin', 'Read aloud', ago(m.t)], [() => copy(m.text), () => fork(s, i), () => pinChapter(s, i), () => readAloud(m.text), () => {}]));
          } else if (m.role === 'chapter') {
            blocks.push({ h: 22, msg: i, chapter: m.text, draw: y => { const t = g.esc(m.text), w = g.textW(t, true), cx = a.x + (a.w - w) / 2; g.fill(a.x + 10, y + 9, cx - a.x - 16, 1, g.K.sh); g.fill(cx + w + 6, y + 9, a.x + a.w - 16 - cx - w - 6, 1, g.K.sh); g.text(t, cx, y + 3, g.K.sh, true); } });
          } else if (m.role === 'tool' || m.role === 'thinking') {
            const t = g.ellipsis(g.esc(`${m.role === 'thinking' ? 'Thinking' : '>'} ${m.text}`), tw - 8), more = s.view === 'verbose' && m.detail ? g.wrap(g.esc(m.detail), tw - 20).slice(0, 8) : [];
            blocks.push({ h: 17 + more.length * 13, msg: i, draw: y => { g.btnUp(a.x + 8, y, tw, 16); g.text(t, a.x + 12, y + 2, g.K.sh); more.forEach((l, k) => g.text(l, a.x + 18, y + 18 + k * 13, g.K.sh)); } });
          } else blocks.push({ h: 15, msg: i, draw: y => g.text(g.ellipsis(g.esc(m.text), tw), a.x + 10, y, g.K.sh) });
          blocks.push({ h: 6, draw: () => {} });
        }
        if (s.plan.length) {
          const done = s.plan.filter(p => p.status === 'completed').length;
          blocks.push({ h: 16, draw: y => g.text(`Tasks  ${done}/${s.plan.length}`, a.x + 10, y, g.K.dk, true) });
          for (const p of s.plan) blocks.push({ h: 14, draw: y => { const mark = p.status === 'completed' ? '[x]' : p.status === 'in_progress' ? '[>]' : '[ ]'; g.text(g.ellipsis(g.esc(`${mark} ${p.content}${p.session ? ` (${p.session})` : ''}`), tw - 10), a.x + 18, y, p.status === 'completed' ? g.K.sh : g.K.dk, p.status === 'in_progress'); } });
          blocks.push({ h: 6, draw: () => {} });
        }
        if (s.state === 'working') blocks.push({ h: 18, draw: y => g.text(`Working\u2026  ${Math.round((now() - s.active) / 1000)}s`, a.x + 10, y + 2, '#0000a8') });
        if (!blocks.length) blocks.push({ h: 16, draw: y => g.text('Type a message to start.', a.x + 10, y, g.K.sh) });
        // from the bottom, scrolled up by tscroll pixels
        const total = blocks.reduce((n, b) => n + b.h, 0), view = a.h - 8;
        tscroll = Math.max(0, Math.min(tscroll, total - view)); this.total = total;
        let y = a.y + 4 + (total > view ? view - total + tscroll : 0);
        this.hits = []; this.marks = [];
        const hit = (x, y2, w, h, fn) => this.hits.push({ x, y: y2, w, h, fn });
        ui.gfx.clip(a.x + 2, a.y + 2, a.w - 4, a.h - 4, () => { for (const b of blocks) { if (b.chapter) this.marks.push({ title: b.chapter, off: y - a.y }); if (y + b.h > a.y && y < a.y + a.h) b.draw(y); y += b.h; } });
        if (railOpen) {   // the session rail: the chapters, each a place to go to
          const rw = 140, rx = a.x + a.w - rw - 4; g.btnUp(rx, a.y + 4, rw, Math.min(a.h - 8, 20 + this.marks.length * 15));
          g.text('Chapters', rx + 6, a.y + 7, g.K.dk, true);
          this.marks.forEach((m, k) => { const ty = a.y + 22 + k * 15; g.text(g.ellipsis(g.esc(m.title), rw - 12), rx + 6, ty); hit(rx, ty, rw, 15, () => { tscroll += m.off - 20; railOpen = false; }); });
          if (!this.marks.length) g.text('No chapters', rx + 6, a.y + 22, g.K.sh);
        }
        if (tscroll > 0) { const jx = a.x + a.w - 110, jy = a.y + a.h - 24; g.btnUp(jx, jy, 96, 18); g.text('Jump to latest', jx + 8, jy + 3); hit(jx, jy, 96, 18, () => { tscroll = 0; }); }
      },
      down(x, y) { const h = this.hits.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h); if (h) { h.fn(); ui.dirty(); } return null; },
      key(e) {
        const page = Math.max(40, this.h - 40);
        if (e.key === 'PageUp' || e.key === 'ArrowUp') { tscroll += e.key === 'PageUp' ? page : 26; return true; }
        if (e.key === 'PageDown' || e.key === 'ArrowDown') { tscroll = Math.max(0, tscroll - (e.key === 'PageDown' ? page : 26)); return true; }
        if (e.key === 'End') { tscroll = 0; return true; }
        return false;
      },
    };
    // ---- the next-step box (its recap and question; its one or two buttons below)
    const box = {
      // (its height stops above its buttons, so a press there reaches them: it is drawn the whole box high)
      type: 'custom', get x() { return chatX(); }, get y() { return CR().h - FOOT - PROMPT - 6 - boxH(); }, get w() { return chatW(); }, get h() { return Math.max(0, boxH() - 28); },
      get hidden() { return !cur().next; },
      draw(a) {
        const g = ui.gfx, n = cur().next; if (!n) return; g.btnUp(a.x, a.y, a.w, boxH() - 2);
        let y = a.y + 5;
        for (const l of g.wrap(g.esc(n.recap), a.w - 16).slice(0, n.ask ? 2 : 3)) { g.text(l, a.x + 8, y); y += 13; }
        if (n.ask) g.text(g.ellipsis(g.esc(n.ask), a.w - 16, true), a.x + 8, a.y + 34, g.K.dk, true);
      },
    };
    // the next-step box's buttons: real buttons, so win95.click({ name }) presses them
    const actBtn = i => ({
      type: 'button', h: 23, get x() { const n = cur().next, k = n && n.actions ? n.actions.length : 0; return chatX() + chatW() - 8 - (k - i) * 112; }, get y() { return CR().h - FOOT - PROMPT - 6 - 29; }, w: 106, label: '',
      get hidden() { const n = cur().next; return !(n && n.actions && n.actions[i]); },
      fn: () => answer(cur(), i),
    });
    const btns = [actBtn(0), actBtn(1)];
    // ---- the composer: Add, the prompt, Send; under it the permission mode, the model and effort, the usage
    const prompt = { type: 'edit', get x() { return chatX() + 28; }, get y() { return CR().h - FOOT - PROMPT; }, get w() { return chatW() - 28 - 56; }, h: 24, value: '', caret: 0, focus: true };
    const placeholder = { type: 'custom', get x() { return prompt.x; }, get y() { return prompt.y; }, w: 0, h: 0, draw: a => { if (!prompt.value) ui.gfx.text(cur().state === 'working' ? 'Enter to send, it is queued for later' : 'Type / for commands', a.x + 4, a.y + 6, ui.gfx.K.sh); } };
    const addBtn = { type: 'button', label: '+', get x() { return chatX(); }, get y() { return prompt.y; }, w: 24, h: 24, fn: () => popup([
      { label: 'Add folder...', fn: () => api.directory.request_directory({}).catch(() => {}) },
      { label: 'Plan mode', check: cur().permissionMode === 'plan', fn: () => setMode(cur().permissionMode === 'plan' ? 'default' : 'plan') },
      { sep: true }, { label: 'Clear conversation', fn: () => send('/clear') },
    ], chatX() + CR().x, prompt.y + CR().y - 70) };
    const sendBtn = { type: 'button', label: 'Send', def: true, get x() { return chatX() + chatW() - 52; }, get y() { return prompt.y; }, w: 52, h: 24, fn: () => send(prompt.value) };
    const modeBtn = { type: 'button', get label() { return MODE_LABEL[cur().permissionMode] || cur().permissionMode; }, get x() { return chatX(); }, get y() { return CR().h - FOOT + 1; }, w: 118, h: 21,
      fn: () => popup(Object.entries(MODE_LABEL).map(([m, l]) => ({ label: l, check: cur().permissionMode === m, fn: () => setMode(m) })), chatX() + CR().x, CR().h - FOOT - 100 + CR().y) };
    const MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1']];
    const modelName = id => (MODELS.find(m => m[0] === id) || [id, id])[1];
    const modelCtl = {
      type: 'custom', get x() { return chatX() + chatW() - 190; }, get y() { return CR().h - FOOT + 1; }, w: 160, h: 21,
      draw(a) { const g = ui.gfx, s = cur(), t = `${modelName(s.model)}  ${s.effort[0].toUpperCase()}${s.effort.slice(1)}`; g.text(t, a.x + a.w - g.textW(t) - 4, a.y + 4, g.K.dk); },
      down(x) { const s = cur(); popup([...MODELS.map(([id, n]) => ({ label: n, check: s.model === id, fn: () => { s.model = id; save('sessions'); } })), { sep: true }, ...E.effort.map(e => ({ label: `${e[0].toUpperCase()}${e.slice(1)} effort`, check: s.effort === e, fn: () => { s.effort = e; save('sessions'); } }))], x + CR().x, CR().h - FOOT - 160 + CR().y); return null; },
    };
    const usageCtl = {
      type: 'custom', get x() { return chatX() + chatW() - 26; }, get y() { return CR().h - FOOT + 3; }, w: 22, h: 18,
      draw(a) { const g = ui.gfx, p = Math.min(1, usage(cur()).percent / 100); g.field(a.x, a.y + 2, a.w, 12); g.fill(a.x + 2, a.y + 4, Math.round((a.w - 4) * p), 8, p > 0.8 ? '#a80000' : '#0000a8'); },
      down() { const u = usage(cur()); ui.msgBox('Usage', `Context: ${u.tokens} tokens (${u.percent}% of the window).\nPlan limits: not applicable in Windows 95.`, 'info'); return null; },
    };
    // ---- the panes, stacked at the right, each with its header (its title; Open in, Copy, Expand, Close)
    const panes = {
      type: 'custom', get x() { return paneX(); }, y: 0, get w() { return CR().w - paneX(); }, get h() { return CR().h; }, hits: [],
      get hidden() { return !panesOpen.length; },
      draw(a) {
        const g = ui.gfx; this.hits = []; const hit = (x, y, w, h, fn) => this.hits.push({ x, y, w, h, fn });
        const ph = Math.floor(a.h / panesOpen.length);
        panesOpen.forEach((p, k) => {
          const y0 = a.y + k * ph, h = k === panesOpen.length - 1 ? a.h - k * ph : ph - 2;
          g.btnUp(a.x, y0, a.w, 24); g.text(PANE_TITLE[p], a.x + 8, y0 + 5, g.K.dk, true);
          let bx = a.x + a.w - 4;   // (right to left: Close, Expand, Copy)
          for (const [l, fn] of [['x', () => closePane(p)], ['^', () => { panesOpen = [p]; }], ['Copy', () => copy(paneText(p).join('\n'))]]) {
            const bw = g.textW(l) + 10; bx -= bw + 2; g.btnUp(bx, y0 + 3, bw, 18); g.text(l, bx + 5, y0 + 5); hit(bx, y0 + 3, bw, 18, fn);
          }
          g.field(a.x, y0 + 25, a.w, h - 25);
          ui.gfx.clip(a.x + 2, y0 + 27, a.w - 4, h - 29, () => paneText(p).forEach((l, i) => { const ty = y0 + 30 + i * 14; g.text(g.ellipsis(g.esc(l), a.w - 16), a.x + 8, ty, i === 0 && p !== 'plan' ? g.K.sh : g.K.dk); if (paneAct[p]) hit(a.x, ty, a.w, 14, () => paneAct[p](i)); }));
        });
      },
      down(x, y) { const h = this.hits.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h); if (h) { h.fn(); ui.dirty(); } return null; },
    };
    const filesOf = s => { try { return ui.fs.readdir(s.cwd).map(e => (typeof e === 'string' ? e : e.name)); } catch (_) { return []; } };
    function paneText(p) {
      const s = cur();
      if (p === 'plan') return s.plan.length ? s.plan.map(t => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.content}`) : ['No plan for this session.'];
      if (p === 'tasks') { const kids = st.sessions.filter(x => x.startedBy === s.id); return [`${kids.length} session(s) started here`, ...kids.map(x => `${x.title}  (${x.state})`), ...st.cards.map(c => `Card: ${c.title}`)]; }
      if (p === 'files') return [s.cwd, ...filesOf(s)];
      if (p === 'diff') return [(s.changes || []).length ? `${s.changes.length} file(s) changed` : 'No changes', ...(s.changes || []).map(c => `${c.op}  ${c.path}`)];
      if (p === 'terminal') return ['MS-DOS Prompt runs in its own window.', 'Open it'];
      if (p === 'preview') return ['The screen is the preview: its windows', ...ui.windows().filter(w => !w.min && w !== win).map(w => w.title || '(untitled)')];
      if (p === 'side_chat') return ['Side chat', ...s.transcript.filter(m => m.side).map(m => `${m.role}: ${m.text}`)];
      return [];
    }
    const paneAct = {
      files: i => { const s = cur(), f = filesOf(s)[i - 1]; if (f) ui.openPath(`${s.cwd.replace(/\\$/, '')}\\${f}`); },
      diff: i => { const c = (cur().changes || [])[i - 1]; if (c && ui.fs.exists(c.path)) ui.openPath(c.path); },
      terminal: i => { if (i === 1) ui.runCommand('COMMAND.COM'); },
      preview: i => { const w = ui.windows().filter(x => !x.min && x !== win)[i - 1]; if (w) ui.activate(w); },
    };
    function togglePane(p) { if (panesOpen.includes(p)) closePane(p); else { panesOpen = [...panesOpen.filter(x => x !== p), p].slice(-2); if (p === 'terminal') ui.runCommand('COMMAND.COM'); } ui.dirty(); }
    function closePane(p) { panesOpen = p ? panesOpen.filter(x => x !== p) : panesOpen.slice(0, -1); ui.dirty(); }
    function setSidebar(collapsed) { sidebarCollapsed = collapsed; ui.dirty(); }
    function setMode(m) { const s = cur(); s.permissionMode = m; save('sessions'); ui.dirty(); }
    const usage = s => { const tokens = s.transcript.reduce((n, m) => n + Math.ceil(m.text.length / 4), 0); return { tokens, percent: +(tokens / 2e3).toFixed(1) }; };
    const copy = t => { try { navigator.clipboard.writeText(t); } catch (_) { /* no clipboard here */ } ui.emit('ccd.copy', { text: t }); };
    const readAloud = t => { try { speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } catch (_) { /* no speech here */ } };
    function fork(s, i) { const f = fresh({ title: `${s.title} (fork)`, startedBy: s.id, cwd: s.cwd, transcript: s.transcript.slice(0, i + 1).map(m => ({ ...m })) }); st.sessions.push(f); save('sessions'); show(f.id); }
    function pinChapter(s, i) { nameDialog('Pin as chapter', '', t => { s.transcript.splice(i + 1, 0, { uuid: uid('msg'), t: now(), role: 'chapter', text: t }); s.chapters.push({ title: t, t: now() }); save('sessions'); ui.dirty(); }); }
    async function rewind(s, i) { if (!await approve('Rewind the conversation to this message? The messages after it are removed.')) return; prompt.value = s.transcript[i].text; prompt.caret = prompt.value.length; s.transcript = s.transcript.slice(0, i); save('sessions'); ui.dirty(); }
    function newSession() { const s = fresh({ title: 'New session', cwd: self.cwd }); st.sessions.push(s); save('sessions'); show(s.id); openWindow(); return s; }
    function send(text) {
      const s = cur(), t = String(text || '').trim(); if (!t) return;
      prompt.value = ''; prompt.caret = 0; tscroll = 0;
      if (t === '/clear') { s.transcript = []; s.plan = []; s.next = null; save('sessions'); ui.dirty(); return; }
      if (t === '/compact') { said(s, 'system', 'Conversation compacted.'); save('sessions'); ui.dirty(); return; }
      said(s, 'user', t); s.state = 'working'; s.next = null; if (s.title === 'New session') s.title = t.slice(0, 48);
      save('sessions'); refreshLabels(); ui.dirty();
      ui.emit('ccd.prompt', { session: s.id, text: t });
      reply(s);
    }
    // the reply: the conversation's messages to the Claude API through the dev server (tools/serve.py /__claude, which
    // holds the key), streamed back a line at a time; Claude's text (and its thinking's summary) appended as it comes
    async function reply(s) {
      const messages = [];
      for (const m of s.transcript) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const last = messages[messages.length - 1];
        if (last && last.role === m.role) last.content += `\n\n${m.text}`; else messages.push({ role: m.role, content: m.text });
      }
      while (messages.length && messages[0].role !== 'user') messages.shift();
      let msg = null, think = null, failed = null;
      const on = ev => {
        if (ev.t === 'text') { if (!msg) { msg = { uuid: uid('msg'), t: now(), role: 'assistant', text: '' }; s.transcript.push(msg); } msg.text += ev.d; }
        else if (ev.t === 'thinking') { if (!think) { think = { uuid: uid('msg'), t: now(), role: 'thinking', text: '' }; s.transcript.push(think); } think.text += ev.d; }
        else if (ev.t === 'done') s.usage = { in: ev.in, out: ev.out, model: ev.model, stop: ev.stop };
        else if (ev.t === 'error') failed = ev.e;
        s.active = now(); ui.dirty();
      };
      try {
        const r = await fetch('__claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: s.model, effort: s.effort, messages }) });
        if (!r.ok) failed = r.status === 404 || r.status === 501 ? 'Not connected: this page\'s server has no Claude API.' : `Not connected (HTTP ${r.status}).`;
        else {
          const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
          for (;;) {
            const { value, done } = await rd.read(); if (done) break;
            buf += dec.decode(value, { stream: true });
            for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) on(JSON.parse(buf.slice(0, i)));
          }
        }
      } catch (e) { failed = `Not connected: ${e.message}`; }
      if (failed) said(s, 'system', failed);
      s.state = failed ? 'failed' : 'idle'; if (s.id !== shown) s.unread = true;
      save('sessions'); ui.dirty(); notify('task_complete');
      ui.emit('ccd.reply', { session: s.id, text: msg ? msg.text : '', error: failed });
    }
    function goBack() { if (!navBack.length) return; navFwd.push(shown); shown = navBack.pop(); refreshLabels(); ui.dirty(); }
    function goFwd() { if (!navFwd.length) return; navBack.push(shown); shown = navFwd.pop(); refreshLabels(); ui.dirty(); }
    function step(d) { const ids = st.sessions.filter(s => !s.archived).map(s => s.id), k = ids.indexOf(shown); if (ids.length) show(ids[(k + d + ids.length) % ids.length]); }
    // small dialogs: a name, Rename, Settings, the shortcuts, About
    function nameDialog(title, value, ok) {
      let w; const edit = { type: 'edit', x: 12, y: 12, w: 256, h: 21, value, caret: value.length, focus: true, all: true };
      const done = v => { ui.closeWin(w, true); if (v !== null && v.trim()) ok(v.trim()); };
      w = ui.dialog(title, 280, 74, [edit, { type: 'button', label: 'OK', x: 112, y: 42, w: 75, h: 23, def: true, fn: () => done(edit.value) }, { type: 'button', label: 'Cancel', x: 193, y: 42, w: 75, h: 23, cancel: true, fn: () => done(null) }], { modal: true });
    }
    const renameDialog = s => nameDialog('Rename Session', s.title, t => api.session_mgmt.set_session_title({ session_id: s.id, title: t }));
    function settingsDialog() {
      let w; const keys = Object.keys(SETTINGS).filter(k => /true \| false/.test(SETTINGS[k].accepts));
      const checks = keys.map((k, i) => ({ type: 'check', label: SETTINGS[k].does.replace(/^./, c => c.toUpperCase()), x: 12, y: 12 + i * 20, checked: !!setting(k) }));
      w = ui.dialog('Claude Code Settings', 420, 52 + keys.length * 20, [...checks,
        { type: 'button', label: 'OK', x: 252, y: 22 + keys.length * 20, w: 75, h: 23, def: true, fn: () => { keys.forEach((k, i) => { st.settings[k] = !!checks[i].checked; }); save('settings'); ui.closeWin(w, true); } },
        { type: 'button', label: 'Cancel', x: 333, y: 22 + keys.length * 20, w: 75, h: 23, cancel: true, fn: () => ui.closeWin(w, true) }], { modal: true });
    }
    const SHORTCUTS = [['Ctrl+N', 'New session'], ['Ctrl+B', 'Show or hide the sidebar'], ['Ctrl+K', 'Command palette'], ['Ctrl+F', 'Find'], ['Ctrl+Shift+[  ]', 'Previous, next session'], ['Ctrl+Shift+D', 'Changes'], ['Ctrl+Shift+P', 'Preview'], ['Ctrl+Shift+F', 'Files'], ['Ctrl+;', 'Side chat'], ['Ctrl+\\', 'Close pane'], ['Ctrl+W', 'Close window']];
    const shortcutsBox = () => ui.msgBox('Keyboard Shortcuts', SHORTCUTS.map(([k, d]) => `${k}\t${d}`).join('\n'), 'info');
    const aboutBox = () => ui.msgBox('About Claude', 'Claude\nThe desktop app\'s Code tab, in Windows 95.', 'info');
    function findDialog() {
      nameDialog('Find', '', q => {
        const s = cur(), i = s.transcript.findIndex(m => m.text.toLowerCase().includes(q.toLowerCase()));
        if (i < 0) { ui.msgBox('Find', `Cannot find "${q}"`, 'info'); return; }
        // scrolled so the message is the one at the bottom
        const after = s.transcript.slice(i + 1).reduce((n, m) => n + 13 * Math.ceil(m.text.length / 60) + 22, 0); tscroll = after; ui.dirty();
      });
    }
    // the command palette: the menus' commands by name
    const COMMANDS = () => [['New Session', newSession], ['Show/Hide Sidebar', () => setSidebar(!sidebarCollapsed)], ...['terminal', 'diff', 'preview', 'files', 'side_chat', 'plan', 'tasks'].map(p => [`Toggle ${PANE_TITLE[p]}`, () => togglePane(p)]),
      ['Close Pane', () => closePane()], ['Previous Session', () => step(-1)], ['Next Session', () => step(1)], ['Find...', findDialog], ['Settings...', settingsDialog], ['Keyboard Shortcuts', shortcutsBox], ['Rename Session...', () => renameDialog(cur())], ['Export Transcript', () => api.session_mgmt.export_transcript({ session_id: shown })]];
    function palette() { nameDialog('Command Palette', '', q => { const c = COMMANDS().find(([n]) => n.toLowerCase().includes(q.toLowerCase())); if (c) c[1](); else ui.msgBox('Command Palette', `No command matches "${q}"`, 'info'); }); }
    // the menu bar, as the app's (File, Edit, View, Go, Window, Help)
    const MENU = [
      { label: '&File', items: () => [{ label: 'New &Session', acc: 'Ctrl+N', fn: newSession }, { label: 'New Session in New &Window', fn: () => api.window.open_session_in({ session_id: newSession().id, target: 'window' }).catch(() => {}) }, { label: 'New Side &Chat', fn: () => togglePane('side_chat') }, { sep: true },
        { label: 'Close &Pane', acc: 'Ctrl+\\', disabled: !panesOpen.length, fn: () => closePane() }, { label: 'E&xport Transcript', fn: () => api.session_mgmt.export_transcript({ session_id: shown }) }, { sep: true }, { label: '&Close Window', acc: 'Ctrl+W', fn: () => ui.closeWin(win) }] },
      { label: '&Edit', items: () => [{ label: '&Find...', acc: 'Ctrl+F', fn: findDialog }, { label: 'Copy &Last Message', fn: () => { const m = [...cur().transcript].reverse().find(x => x.role === 'assistant'); if (m) copy(m.text); } }] },
      { label: '&View', items: () => [{ label: '&Command Palette...', acc: 'Ctrl+K', fn: palette }, { label: `${sidebarCollapsed ? 'Show' : 'Hide'} Side&bar`, acc: 'Ctrl+B', fn: () => setSidebar(!sidebarCollapsed) }, { sep: true }, ...viewMenu()] },
      { label: '&Go', items: () => [{ label: '&Back', disabled: !navBack.length, fn: goBack }, { label: '&Forward', disabled: !navFwd.length, fn: goFwd }, { sep: true }, { label: '&Search...', fn: findDialog }, { label: '&Previous Session', acc: 'Ctrl+Shift+[', fn: () => step(-1) }, { label: '&Next Session', acc: 'Ctrl+Shift+]', fn: () => step(1) }] },
      { label: '&Window', items: () => [...st.sessions.filter(s => !s.archived).slice(-9).map((s, i) => ({ label: `&${i + 1} ${s.title.replace(/&/g, '&&').slice(0, 40)}`, check: s.id === shown, fn: () => show(s.id) }))] },
      { label: '&Help', items: () => [{ label: '&Keyboard Shortcuts', acc: 'Ctrl+/', fn: shortcutsBox }, { label: '&Settings...', fn: settingsDialog }, { sep: true }, { label: '&About Claude', fn: aboutBox }] },
    ];
    const KEYS = {
      'ctrl+n': newSession, 'ctrl+b': () => setSidebar(!sidebarCollapsed), 'ctrl+k': palette, 'ctrl+f': findDialog, 'ctrl+\\': () => closePane(), 'ctrl+w': () => ui.closeWin(win),
      'ctrl+shift+[': () => step(-1), 'ctrl+shift+]': () => step(1), 'ctrl+shift+{': () => step(-1), 'ctrl+shift+}': () => step(1), 'ctrl+shift+d': () => togglePane('diff'), 'ctrl+shift+p': () => togglePane('preview'), 'ctrl+shift+f': () => togglePane('files'), 'ctrl+;': () => togglePane('side_chat'), 'ctrl+/': shortcutsBox,
    };
    const refreshLabels = () => { const n = cur().next; btns.forEach((b, i) => { b.label = n && n.actions && n.actions[i] ? (n.actions[i].label || n.actions[i].action || 'OK').replace(/&/g, '&&') : ''; }); };
    function show(id) { if (id !== shown) { navBack.push(shown); navFwd = []; } shown = id; tscroll = 0; refreshLabels(); if (win) ui.dirty(); }
    let quiet = false;   // (a call from the Claude program: the page's window is not opened for it)
    function openWindow(focus = true) {
      if (quiet && !(win && ui.windows().includes(win))) return null;
      refreshLabels();
      if (win && ui.windows().includes(win)) { if (focus) ui.activate(win); ui.dirty(); return win; }
      body = new ui.DialogBody([sidebar, ...header, transcript, box, ...btns, addBtn, prompt, placeholder, sendBtn, modeBtn, modelCtl, usageCtl, panes]);
      const keyOf = e => `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.shiftKey && e.key.length !== 1 ? 'shift+' : e.shiftKey && (e.ctrlKey || e.metaKey) ? 'shift+' : ''}${e.key.toLowerCase()}`;
      const keyBase = body.key.bind(body);
      body.key = e => { const f = KEYS[keyOf(e)]; if (f) { f(); ui.dirty(); return true; } return keyBase(e); };
      const sz = ui.screen(), w = Math.min(sz.width - 20, 760), h = Math.min(sz.height - 50, 520);
      win = ui.openWin(new ui.Win({ x: Math.max(0, (sz.width - w) >> 1), y: Math.max(0, (sz.height - 30 - h) >> 1), w, h, title: 'Claude', icon: ui.icon || null, minW: 420, minH: 300, menu: MENU, body }));
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
        said(s, 'assistant', a.recap, { box: true });   // (shown in the transcript; not a turn of Claude's to send back)
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
    // panes: the Claude window's, as the app's (a file is the Files pane's file, opened in Notepad)
    const PANE_OF = { diff: 'diff', file: 'files', terminal: 'terminal', tasks: 'tasks', plan: 'plan', preview: 'preview' };
    T.view = {
      show_pane(a) {
        if (a.pane === 'file') {
          if (!a.path) not('path is required for the file pane.');
          if (!ui.fs.exists(a.path)) not(`${a.path} does not exist.`);
          ui.notepad(a.path); return `Opened ${a.path}${a.line ? ` at line ${a.line}` : ''} in Notepad.`;
        }
        const p = PANE_OF[a.pane]; if (!p) return `There is no ${a.pane} pane in Windows 95: nothing shown.`;
        show(self.id); openWindow(false); if (!panesOpen.includes(p)) togglePane(p);
        return `Showing the ${PANE_TITLE[p]} pane.`;
      },
      close_pane(a) {
        const p = PANE_OF[a.pane]; if (!p || !panesOpen.includes(p)) return `The ${a.pane} pane is not open: nothing to close.`;
        closePane(p); return `Closed the ${PANE_TITLE[p]} pane.`;
      },
      get_layout() {
        const open = win && ui.windows().includes(win);
        return JSON.stringify({ views: open ? [{ where: splits.length ? 'split' : 'main', window: 'Claude' }] : [], open_panes: open ? panesOpen.slice() : [], popped_out_panes: [], transcript_view: self.view });
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
          sync();
          try {
            for (const k of sc.req || []) if (args[k] === undefined || args[k] === null || args[k] === '') not(`${k} is required.`);
            for (const [k, vs] of Object.entries(sc.enums || {})) if (args[k] !== undefined && !vs.includes(args[k])) not(`${k} must be one of ${vs.map(v => JSON.stringify(v)).join(', ')}.`);
            result = await T[server][tool](args);
          } catch (e) { if (!(e instanceof CcdError)) throw e; error = e.message; }
          ui.emit(`ccd.${server}.${tool}`, { args, result: error ? null : result, error });
          if (server !== 'turn') { said(self, 'tool', `${server}.${tool}${error ? ' (refused)' : ''}`, { detail: `${JSON.stringify(args)}\n${error || (typeof result === 'string' ? result : '')}`.slice(0, 600) }); save('sessions'); ui.dirty(); }
          if (error) throw new CcdError(error);
          return result;
        };
      }
    }
    // the Changes pane: the files changed while the session works
    if (ui.on) ui.on('fs', e => {
      if (self.state !== 'working' || !/^fs\.(write|create|unlink|mkdir|rmdir|rename)$/.test(e.type)) return;
      const c = self.changes = self.changes || [], op = e.type.slice(3);
      if (!c.some(x => x.path === e.path && x.op === op)) { c.push({ op, path: e.path }); if (c.length > 200) c.shift(); }
    });
    // the tools as the Claude API takes them (the Claude program offers them to Claude: claude-app.js), and a call made
    // for a session, as that session's own ("self")
    api.toolDefs = () => Object.entries(SCHEMA).flatMap(([server, tools]) => Object.entries(tools).map(([tool, sc]) => ({
      name: `ccd_${server}__${tool}`, description: DESC[server][tool], input_schema: inputSchema(server, tool, sc),
    })));
    api.callAs = async (sid, name, args) => {
      const m = /^ccd_(\w+?)__(\w+)$/.exec(name); if (!m || !api[m[1]] || !api[m[1]][m[2]]) throw new CcdError(`No tool ${name}.`);
      sync(); const was = self; self = byId(sid) || self; quiet = true;
      try { return await api[m[1]][m[2]](args || {}); } finally { self = st.sessions.find(s => s.id === was.id) || was; quiet = false; }
    };
    api.open = () => openWindow();
    api.send = text => send(text);
    api.answer = (i = 0) => answer(byId(shown) || self, i);
    api.Error = CcdError;
    api.state = () => JSON.parse(JSON.stringify(st));
    api.tools = () => Object.fromEntries(Object.entries(SCHEMA).map(([s, t]) => [s, Object.keys(t)]));
    return api;
  };
})();
