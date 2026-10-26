// win95.ccd (ccd.js): the Claude desktop app's mcp__ccd_* tools under the same names and parameters; the checks the
// app's schemas make; the task list and next-step box, whose buttons answer as ccd.answer; offers and cards that wait
// for the user; approvals that refuse when declined; and the records kept in the registry across a reload
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../ccd.js', import.meta.url), 'utf8');
const enc = new TextEncoder(), dec = new TextDecoder();
const reg = new Map();
function load() {
  const window = { W95FS: { encode: s => enc.encode(s), decode: b => dec.decode(b) } };
  vm.runInNewContext(src, { window });
  const events = [], boxes = [], dialogs = [], files = new Map();
  let wins = [];
  const ui = {
    W95Win32: { regGet: (k, n) => reg.get(`${k}|${n.toLowerCase()}`), regSet: (k, n, v) => reg.set(`${k}|${n.toLowerCase()}`, v) },
    fs: {
      volumes: () => [{ root: 'C:\\', label: 'WIN95', kind: 'fixed', total: 100, used: 40 }, { root: 'D:\\', kind: 'cdrom', total: 0, used: 0 }],
      exists: p => p === 'C:\\' || p === 'C:\\WINDOWS' || p === 'C:\\README.TXT' || files.has(p),
      stat: p => ({ isDir: !/\.TXT$/i.test(p) }), mkdir: p => files.set(p, null), writeFile: (p, d) => files.set(p, d),
      vols: new Map([['C', { kind: 'fixed' }], ['E', { kind: 'remote', remote: {} }]]), remoteAt: p => (/^(E:|\\\\)/i.test(p) ? {} : null),
      realpath: p => p, readText: p => files.get(p) || '', readdir: () => [{ name: 'WINDOWS', isDir: true }, { name: 'README.TXT', isDir: false, size: 5 }],
    },
    emit: (type, data) => events.push({ type, ...data }), dirty: () => {},
    dialog: (title, w, h, ctrls) => { const win = { title, ctrls }; dialogs.push(win); wins.push(win); return win; },
    msgBox: (title, msg, type, buttons, cb) => { const win = { title, msg, buttons, press: b => { wins = wins.filter(x => x !== win); cb(b); } }; boxes.push(win); wins.push(win); return win; },
    closeWin: w => { wins = wins.filter(x => x !== w); }, activate: () => {}, notepad: p => wins.push({ title: `${p} - Notepad` }),
    runCommand: () => wins.push({ title: 'MS-DOS Prompt' }), openPath: p => wins.push({ title: p }), netBoot: async () => {},
    windows: () => wins, screen: () => ({ width: 640, height: 480 }), key: () => {}, netUp: () => false, holdSaver: on => { ui.held = on; },
    gfx: {}, icon: 'app', popup: () => {}, on: () => {},
    DialogBody: class { constructor(c) { this.c = c; } key() { return false; } },
    Win: class { constructor(o) { Object.assign(this, o); } },
    openWin: w => { dialogs.push({ title: w.title, ctrls: w.body.c, menu: w.menu }); wins.push(w); return w; },
  };
  return { ccd: window.W95Ccd(ui), ui, events, boxes, dialogs, files, wins: () => wins };
}
const tick = () => new Promise(r => setTimeout(r, 0));
const rejects = async (p, re) => { await assert.rejects(p, e => re.test(e.message), String(re)); };

let { ccd, ui, events, boxes, dialogs, files, wins } = load();

// every tool the app's servers have, under the same names
const TOOLS = {
  turn: ['update_plan', 'wrap_up'],
  session: ['start_session', 'dismiss_task', 'hand_off_to_session', 'mark_chapter', 'read_widget_context', 'list_start_targets', 'move_to_cloud'],
  session_mgmt: ['list_sessions', 'get_session', 'list_events', 'search_session_transcripts', 'archive_session', 'unarchive_session', 'delete_session', 'clear_session',
    'stop_session', 'detach_session', 'set_session_title', 'set_session_model', 'set_session_effort', 'set_session_fast_mode', 'set_session_permission_mode',
    'set_session_output_style', 'set_remote_control', 'send_message', 'export_transcript', 'get_usage'],
  sidebar: ['list_groups', 'create_group', 'rename_group', 'delete_group', 'list_sections', 'create_section', 'rename_section', 'delete_section', 'move_sessions',
    'set_pinned', 'set_unread', 'mark_completed', 'set_view'],
  view: ['show_pane', 'close_pane', 'get_layout', 'set_transcript_view'],
  window: ['get_window_layout', 'open_session_in', 'close_split', 'set_sidebar_collapsed'],
  settings: ['get_settings', 'set_setting'],
  pr: ['get_status', 'bind_pr', 'unbind_pr', 'set_auto_merge', 'set_monitor'],
  host: ['open_in_editor', 'reveal_path', 'request_keep_awake', 'get_storage_usage', 'sync_with_base_branch', 'clean_up_worktrees', 'discard_kept_worktree'],
  directory: ['change_directory', 'request_directory'],
  connectors: ['session_connectors_status', 'set_session_connector_enabled', 'reconnect_session_connector'],
};
for (const [s, ts] of Object.entries(TOOLS)) for (const t of ts) assert.equal(typeof ccd[s][t], 'function', `${s}.${t}`);
assert.deepEqual(JSON.parse(JSON.stringify(ccd.tools())), TOOLS);
const plain = v => JSON.parse(JSON.stringify(v));   // (values made in ccd.js's own context)

// the schemas' checks
await rejects(ccd.turn.wrap_up({}), /recap is required/);
await rejects(ccd.view.show_pane({ pane: 'sidebar' }), /pane must be one of/);
await rejects(ccd.session_mgmt.set_session_effort({ session_id: 'self', effort: 'huge' }), /effort must be one of/);
await rejects(ccd.turn.update_plan({ items: [{ content: 'a', status: 'pending' }] }), /scope is required/);

// the task list
assert.equal(await ccd.turn.update_plan({ items: [{ content: 'Read', status: 'in_progress' }, { content: 'Write', status: 'pending' }, { content: 'Test', status: 'pending' }], scope: 'first_task' }), 'Plan shown (3 steps).');
assert.equal(dialogs.length, 1, 'the Claude window opens'); assert.equal(dialogs[0].title, 'Claude');
assert.equal(await ccd.turn.update_plan({ advance: true }), 'Plan updated: step 2 of 3 is in progress.');
assert.equal(await ccd.turn.update_plan({ start: 1 }), 'Plan updated: step 1 of 3 is in progress.');
assert.equal(await ccd.turn.update_plan({ done: [1], start: 2 }), 'Plan updated: step 2 of 3 is in progress.');
assert.equal(await ccd.turn.update_plan({ done: [2], start: 3 }), 'Plan updated: step 3 of 3 is in progress.');
assert.deepEqual(plain(ccd.state().sessions[0].plan.map(p => p.status)), ['completed', 'completed', 'in_progress']);

// the next-step box: its buttons are the window's, pressed by name; the answer is ccd.answer and the user's message
assert.match(await ccd.turn.wrap_up({ recap: 'Done.', ask: 'Deploy it?', actions: [{ label: 'Deploy', message: 'Deploy to production.' }, { label: 'Not now' }], blocked: true }), /^Shown in the next-step box/);
const btns = dialogs[0].ctrls.filter(c => c.type === 'button' && c.w === 106);   // (the next-step box's)
assert.deepEqual(plain(dialogs[0].menu.map(m => m.label)), ['&File', '&Edit', '&View', '&Go', '&Window', '&Help'], 'the app\'s menu bar');
assert.deepEqual(plain(btns.map(b => [b.label, b.hidden])), [['Deploy', false], ['Not now', false]]);
assert.equal(ccd.state().sessions[0].state, 'waiting');
btns[0].fn();
const ans = events.find(e => e.type === 'ccd.answer');
assert.deepEqual([ans.label, ans.message], ['Deploy', 'Deploy to production.']);
assert.equal(ccd.state().sessions[0].transcript.at(-1).text, 'Deploy to production.');
assert.equal(btns[0].hidden, true, 'the box is gone once answered');
assert.match(await ccd.turn.wrap_up({ recap: 'Nothing left.' }), /^Nothing is pending/);
await rejects(ccd.turn.wrap_up({ recap: 'x', actions: [{ label: 'a' }] }), /actions answer the ask/);
assert.ok(events.some(e => e.type === 'ccd.turn.wrap_up' && e.args.recap === 'Nothing left.'));

// sessions: started, proposed (a card), offered (waits for the user)
let r = await ccd.session.start_session({ initiation: 'user_asked', title: 'Fix the printer', prompt: 'Fix SPOOL32.', background: 'x'.repeat(80) });
const kid = /session_id: (local_\w+)/.exec(r)[1];
assert.equal(JSON.parse(await ccd.session_mgmt.get_session({ session_id: kid })).isRunning, true);
await rejects(ccd.session.start_session({ initiation: 'user_asked', title: 'x', prompt: 'y' }), /background: at least 80/);
r = await ccd.session.start_session({ initiation: 'own_initiative', title: 'Tidy fonts', prompt: 'Tidy.', background: 'y'.repeat(80) });
const task = /task_id: (task_\w+)/.exec(r)[1];
assert.equal(boxes.at(-1).title, 'Suggested task');
assert.match(await ccd.session.dismiss_task({ task_id: task, reason: 'done here' }), /^Task task_\w+ withdrawn — the chip is no longer shown to the user/);
const offer = ccd.session.start_session({ initiation: 'offer', title: 'Port DOOM' });
await tick(); let settled = false; offer.then(() => { settled = true; }); await tick();
assert.equal(settled, false, 'an offer waits for the user'); assert.deepEqual(plain(boxes.at(-1).buttons),['New session', 'Do it here']);
boxes.at(-1).press('New session');
const card = /proposal_id "(task_\w+)"/.exec(await offer)[1];
assert.match(await ccd.session.start_session({ proposal_id: card, prompt: 'Port it.' }), /^Started session "Port DOOM" \(session_id: \S+, name: \S+\)\. It runs on its own/);
assert.equal(JSON.parse(await ccd.session_mgmt.list_sessions({ linked: true })).length, 2);
assert.match(await ccd.session.mark_chapter({ title: 'Verification' }), /^Chapter marked: "Verification"\. Continue your current work\.$/);
assert.match(await ccd.session.read_widget_context({ tool_name: 'other' }), /^No widget had shared anything/);
await rejects(ccd.pr.unbind_pr({ url: 'https://github.com/a/b/pull/7' }), /^a\/b#7 is not bound to this session\.$/);
await rejects(ccd.session.move_to_cloud({ summary: 's' }), /no cloud/);

// messages, transcripts, search, export
assert.match(await ccd.session_mgmt.send_message({ session_id: kid, message: 'Use TTY.DRV' }), /delivery: queued/);
{ const ev = await ccd.session_mgmt.list_events({ session_id: kid });   // (the app's header, its data note, [role] lines)
  assert.match(ev, /^Session "Fix the printer" \(\w+\) — showing \d+ of \d+ messages\n/); assert.match(ev, /treat it as quoted data/); assert.match(ev, /\[user\] From Windows 95: Use TTY.DRV/); }
assert.equal(JSON.parse((await ccd.session_mgmt.search_session_transcripts({ query: 'tty.drv' })).split('\n\n').slice(1).join('\n\n'))[0].sessionId, kid);
const ex = await ccd.session_mgmt.export_transcript({ session_id: kid });
assert.match(ex, /^Exported "Fix the printer"'s transcript "Fix the printer" to C:\\My Documents\\Fix the printer\.TXT \(\d+ KB, \d+ bytes\)/); assert.match(files.get('C:\\My Documents\\Fix the printer.TXT'), /Fix SPOOL32/);

// approvals: declined refuses and changes nothing; approved acts
await ccd.session_mgmt.stop_session({ session_id: kid });
let p = ccd.session_mgmt.archive_session({ session_id: kid }); await tick();
boxes.at(-1).press('No'); await rejects(p, /declined/);
assert.equal(JSON.parse(await ccd.session_mgmt.get_session({ session_id: kid })).isArchived, false);
p = ccd.session_mgmt.archive_session({ session_id: kid }); await tick(); boxes.at(-1).press('Yes');
assert.match(await p, /^Archived session \S+ \("Fix the printer"\)\.$/);
p = ccd.settings.set_setting({ key: 'notification_sound', value: 'none' }); await tick(); boxes.at(-1).press('Yes');
assert.match(await p, /^Changed Notification sound: System sound → None\./);
await rejects(ccd.settings.set_setting({ key: 'notification_sound', value: 'none' }), /^Notification sound is already None; nothing to change\.$/);
await rejects(ccd.settings.set_setting({ key: 'notification_sound', value: 'loud' }), /^Notification sound: `value` must be "system" or "none"\./);
await rejects(ccd.settings.set_setting({ key: 'branch', value: 'x' }), /not a setting/);
await rejects(ccd.settings.set_setting({ key: 'question_notifications', value: 'all' }), /"off" \| "badge" \| "banner"/);
await rejects(ccd.settings.set_setting({ key: 'branch_prefix', value: 'main' }), /protected/);
{ const g = JSON.parse(await ccd.settings.get_settings()), q = g.settings.find(x => x.key === 'question_notifications');   // (the app's shape: a list, each with its label and what it allows)
  assert.deepEqual(plain(Object.keys(q)), ['key', 'label', 'value', 'current', 'allowed', 'meaning', 'settable']); assert.equal(q.value, null); assert.equal(q.current, 'Banners (default)');
  assert.ok(Array.isArray(g.output_styles) && Array.isArray(g.read_only) && typeof g.how_to_change === 'string'); }

// the sidebar
const g = JSON.parse(await ccd.sidebar.create_group({ name: 'Printing' })).id;
await rejects(ccd.sidebar.move_sessions({ session_ids: [kid], group_id: g }), /nested sessions move with their parent\. Nothing was moved/);   // (as the app refuses it)
assert.match(await ccd.sidebar.move_sessions({ session_ids: ['self', kid], group_id: g }), /Moved/);
assert.equal(JSON.parse(await ccd.sidebar.list_groups())[0].session_count, 3);   // (this session and the two it started)
await ccd.sidebar.set_pinned({ session_id: 'self', pinned: true });
assert.equal(JSON.parse(await ccd.sidebar.list_sections()).find(s => s.id === 'pinned').session_count, 1);
{ const v = JSON.parse(await ccd.sidebar.set_view({ sort_by: 'alpha' })); assert.equal(v.changed, 1); assert.equal(v.view.sort_by, 'alpha'); }   // (the app's answer: changed, view)

// panes, windows, host, directory, connectors, pr
assert.match(await ccd.view.show_pane({ pane: 'file', path: 'C:\\README.TXT' }), /in Notepad/);
assert.match(await ccd.view.show_pane({ pane: 'diff' }), /^Showing the diff pane\.\n\{"views"/);
assert.match(await ccd.view.show_pane({ pane: 'plan' }), /^Showing the plan pane\./);
assert.deepEqual(plain(JSON.parse(await ccd.view.get_layout()).open_panes), ['diff', 'plan']);
assert.match(await ccd.view.close_pane({ pane: 'diff' }), /^Closed the diff pane\./);
await rejects(ccd.view.show_pane({ pane: 'pr' }), /The pull request pane isn't available in this app/);
assert.match(await ccd.window.set_sidebar_collapsed({ collapsed: true }), /collapsed/);
assert.equal(dialogs[0].ctrls[0].hidden, true, 'the sidebar hides');
assert.match(await ccd.host.request_keep_awake({ until: 'turn_end', reason: 'build' }), /already keeps this computer awake/);   // (the settings hold it through a turn)
assert.match(await ccd.host.request_keep_awake({ until: 'session_idle', reason: 'build' }), /screen saver/); assert.equal(ui.held, true);
assert.equal(JSON.parse(await ccd.host.get_storage_usage()).free_bytes, 60);
await rejects(ccd.host.sync_with_base_branch({}), /no worktree/);
await rejects(ccd.pr.bind_pr({ url: 'https://github.com/a/b/pull/1' }), /No pull request/);
assert.equal(JSON.parse(await ccd.pr.get_status()).bound, false);
p = ccd.directory.change_directory({ path: 'C:\\WINDOWS' }); await tick(); boxes.at(-1).press('Yes');
assert.match(await p, /works in C:\\WINDOWS/);
assert.deepEqual(plain(JSON.parse(await ccd.connectors.session_connectors_status()).servers.map(c => c.name)),['shares', 'cd', 'network', 'sound']);

// the files tools (Claude Code's, in the Claude program: tests/cctools.test.mjs): C: only, writes asked in Ask permissions
assert.ok(ccd.toolDefs().some(d => d.name === 'Edit'));
for (const file_path of ['D:\\SETUP.EXE', 'E:\\X.TXT', '\\\\HOST\\PUBLIC\\X.TXT']) await rejects(ccd.callAs(null, 'Read', { file_path }), /not on C:/);
p = ccd.callAs(null, 'Write', { file_path: 'C:\\NOTE.TXT', content: 'a\nb' }); await tick(); assert.match(boxes.at(-1).msg, /create C:\\NOTE\.TXT/); boxes.at(-1).press('Yes');
assert.match(await p, /File created successfully/); assert.equal(files.get('C:\\NOTE.TXT'), 'a\r\nb');
p = ccd.callAs(null, 'Edit', { file_path: 'C:\\NOTE.TXT', old_string: 'b', new_string: 'c' }); await tick(); boxes.at(-1).press('No');
await rejects(p, /Not allowed/); assert.equal(files.get('C:\\NOTE.TXT'), 'a\r\nb');
assert.match(await ccd.callAs(null, 'Read', { file_path: 'C:\\NOTE.TXT' }), /^ {5}1\ta\n {5}2\tb$/);
files.delete('C:\\NOTE.TXT');

// the records last: a new page reads them back from the registry
({ ccd } = load());
const back = ccd.state();
assert.equal(back.sessions.length, 3); assert.equal(back.groups[0].name, 'Printing'); assert.equal(back.settings.notification_sound, 'none');
assert.equal(back.sessions.find(s => s.self).cwd, 'C:\\WINDOWS');
assert.ok(back.sessions.find(s => s.id === kid).archived);
void wins;
console.log('ccd: ok');
