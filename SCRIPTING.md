# Scripting the shell

`window.win95` drives the running shell through the same paths a person uses: pointer events on the screen
canvas and keys through the shell's key handler. It is the same in the Electron app (DevTools protocol on
`127.0.0.1:9334`, `Runtime.evaluate`) and in a browser tab (`http://localhost:8095`).

Coordinates are screen pixels of the emulated display, origin top left. `win95.screen()` gives the size.

## Input

| Call | Does |
| --- | --- |
| `move(x, y)` | moves the pointer |
| `click(x, y, { button: 'right', double: true })` | press and release; both options optional |
| `dblclick(x, y)` | two clicks inside the double-click time |
| `down(x, y, o)`, `up(x, y, o)` | one half of a click, for custom gestures |
| `drag(x1, y1, x2, y2, steps = 8)` | press, move in steps, release |
| `type(text)` | each character as a key; `\n` is Enter |
| `key('alt+F4', 'tab', 'enter')` | named keys with `ctrl+`, `shift+`, `alt+`, `meta+`; names: `enter`, `esc`, `tab`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `space`, `F1`..`F12`, or a character |

Dialogs take mnemonics as Windows 95 does: `key('alt+n')` presses `&No`, and the letter alone works unless the focus is in a text field.

### Targeting an element

`click`, `dblclick`, `down`, `up` and `drag` also take an element (from `elements()`/`find()`) or a query for one
(`{ name, role, window }`, strings or RegExps) in place of coordinates. Then they return a promise:

- the element is looked up as its machine shows it now (a native window's controls are asked of the machine afresh),
  waited for up to 5 s until it is there; an element from an earlier listing that is a native window's control is
  found by its window (`hwnd`), so an edit whose text has changed since is still the same element;
- a native list view's item (a desktop icon, a folder window's file) is selected (`click`) or opened (`dblclick`) by
  its list view itself, as Enter opens the selection, wherever it is on screen; anything else gets the pointer input
  at its centre;
- it rejects, saying why, when nothing matches (naming what the window has) or when something covers the point the
  pointer input would go to.

`await win95.dblclick({ name: 'home', window: 'Matts-macbook-p' })` either opens it or throws. `waitFor(query, ms)`
waits for an element the same way and resolves with it. With coordinates the calls act at once and return nothing.

## Windows and menus

| Call | Returns |
| --- | --- |
| `windows()` | `[{ title, x, y, w, h, active, minimized, maximized, modal }]`, bottom to top |
| `elements(query?)` | what is on screen, `[{ role, name, window, x, y, w, h, ... }]`; a native window's controls as its machine last reported them (none yet for a window that has just come) |
| `await elementsNow(query?)` | the same, each native window's controls asked of its machine now |
| `window(title)` | the topmost window whose title equals the string or matches the RegExp, or `null` |
| `activate(title)` | brings it to the front, restoring it if minimized |
| `close(title)` | closes it as its close box would |
| `menus()` | the open menus, each a list of item labels without `&`, `-` for separators |

## Programs and files

| Call | Does |
| --- | --- |
| `run(command)` | what Start > Run does with the command line |
| `open(path)` | opens a folder window or the file's program |
| `saver(path)`, `stopSaver()` | runs a screen saver full screen, ends it |
| `fs` | the file system (`readText`, `writeFile`, `readdir`, `stat`, ...; see `fs.js`) |

## State

| Call | Returns |
| --- | --- |
| `screen()` | `{ width, height, taskbar }`, `taskbar` the top row of the taskbar |
| `screenshot()` | the screen as a PNG data URL |
| `state` | menus, modals, pointer capture, active window title |

## Events

| Call | Does |
| --- | --- |
| `on(type, fn)` | calls `fn(event)` for each event of `type`; returns the function that stops it |
| `next(type, test?, ms = 10000)` | a promise for the next event of `type` that passes `test`; rejects after `ms` |

`type` is an event name, its family (`'window'`, `'fs'`, ...) or `'*'` for all. Every event has `type` and `t`
(ms since the epoch).

| Event | Fields | When |
| --- | --- | --- |
| `window.open` | window fields as `windows()` gives them | a window or dialog appears |
| `window.close` | `title` | it goes away |
| `window.activate` | window fields | another window becomes active |
| `window.title` | window fields, `was` | its title changes |
| `window.minimize`, `window.maximize`, `window.restore` | window fields | |
| `menu.open` | `menus`, as `menus()` gives them | a menu opens or the open menus change |
| `menu.close` | `menus: []` | the last menu closes |
| `saver.start`, `saver.stop` | `path` | a full-screen screen saver starts or ends |
| `program.exit` | `path`, `mode` (`s`, `p`, `c`), `code`, `why` if it failed | a guest program ends |
| `screen` | `screen` | boot screens, desktop, shutdown |
| `devtools` | `open` | the browser's DevTools open or close (the Windows 95 app says; a browser tab cannot) |
| `tray.follow`, `tray.window` | `client`; `id`, `client` | Follow chosen from a person's notification-area icon (`client` null when ended); one of their windows chosen there |
| `fs.create`, `fs.write`, `fs.unlink`, `fs.mkdir`, `fs.rmdir`, `fs.rename`, `fs.attrib`, `fs.label`, `fs.mount` | `path`, `path2` for a rename | the file system changes |

Window, menu, saver and screen events are found by comparing the shell's state after each change, so the changes
made by one call arrive together, windows before menus. File system events arrive as each change happens.

### Over the control port

A DevTools client receives every event as JSON by registering the binding `__w95event`:

```js
await call('Runtime.enable')
await call('Runtime.addBinding', { name: '__w95event' })
// each event then arrives as Runtime.bindingCalled with params.payload = '{"type":"window.open",...}'
```

The binding stays registered across page reloads.

## Claude Code tools

`ccd` (ccd.js) has the Claude desktop app's own tools, the `mcp__ccd_*` servers: `ccd.<server>.<tool>(args)`, with the
app tool's name and parameters, returning a promise of its answer (the app's text, or its JSON as a string). A call
the app would refuse rejects with `ccd.Error` and its reason; a missing required field or a value outside an enum is
refused the same way. Each acts on Windows 95's own equivalent of what it acts on in the app. Sessions, groups, cards
and settings are kept in the registry (`HKCU\Software\Claude\Code`) and last as the registry does. The Claude window
(the desktop's Claude icon, or `ccd.open()`) shows them: the sessions in its sidebar, and the shown session's tasks,
transcript and next-step box. What the app asks the user about is asked in a message box, and the call waits for it.

| Server | Tools | In Windows 95 |
| --- | --- | --- |
| `turn` | `update_plan`, `wrap_up` | the Claude window's task list and next-step box; its buttons are real buttons, so `click({ name })` presses one |
| `session` | `start_session`, `dismiss_task`, `hand_off_to_session`, `mark_chapter`, `read_widget_context`, `list_start_targets`, `move_to_cloud` | sessions are records; a proposal or offer is a message box (Start / Dismiss, New session / Do it here), or, for a session of CLAUDE.EXE's, a card under its conversation; places are the drives; no cloud |
| `session_mgmt` | `list_sessions`, `get_session`, `list_events`, `search_session_transcripts`, `archive_session`, `unarchive_session`, `delete_session`, `clear_session`, `stop_session`, `detach_session`, `set_session_title`, `set_session_model`, `set_session_effort`, `set_session_fast_mode`, `set_session_permission_mode`, `set_session_output_style`, `set_remote_control`, `send_message`, `export_transcript`, `get_usage` | the records and their transcripts; an export is `C:\My Documents\<title>.TXT` |
| `sidebar` | `list_groups`, `create_group`, `rename_group`, `delete_group`, `list_sections`, `create_section`, `rename_section`, `delete_section`, `move_sessions`, `set_pinned`, `set_unread`, `mark_completed`, `set_view` | the Claude window's sidebar |
| `view` | `show_pane`, `close_pane`, `get_layout`, `set_transcript_view` | `file` is Notepad, `terminal` an MS-DOS Prompt, `plan` the Claude window, `tasks` Close Program; `diff`, `pr`, `artifact` have none |
| `window` | `get_window_layout`, `open_session_in`, `close_split`, `set_sidebar_collapsed` | the shell's windows; a split puts a session's window beside the Claude window |
| `settings` | `get_settings`, `set_setting` | the app's keys; keep-awake holds off the screen saver |
| `pr` | `get_status`, `bind_pr`, `unbind_pr`, `set_auto_merge`, `set_monitor` | no GitHub: no pull request |
| `host` | `open_in_editor`, `reveal_path`, `request_keep_awake`, `get_storage_usage`, `sync_with_base_branch`, `clean_up_worktrees`, `discard_kept_worktree` | Notepad, the folder, the screen saver, the drives; no worktrees |
| `directory` | `change_directory`, `request_directory` | the session's folder; without a path, Browse for Folder |
| `connectors` | `session_connectors_status`, `set_session_connector_enabled`, `reconnect_session_connector` | the page's hosts: `shares`, `cd`, `network`, `sound` |

| Call | Does |
| --- | --- |
| `ccd.open()` | opens the Claude window |
| `ccd.answer(i = 0)` | presses the next-step box's button `i` |
| `ccd.tools()` | the servers and their tools |
| `ccd.state()` | the records: sessions, groups, cards, settings, view |
| `ccd.toolDefs()` | the tools as the Claude API takes them: every `ccd_<server>__<tool>`, and Claude Code's `Read`, `Write`, `Edit`, `Glob`, `Grep` |
| `ccd.context(session)` | what goes ahead of each of the session's requests: the CLAUDE.MD files, the memory's index, the skills |
| `ccd.callAs(session, name, args)` | runs a tool by that name for the session, as CLAUDE.EXE's Claude does |
| `ccd.cardAnswer(task_id, label)` | answers a card with its button's label, as CLAUDE.EXE's card buttons do |

CLAUDE.EXE's Claude has Claude Code's own tools besides the app's, with Claude Code's names, parameters and answers:
- `Read`, `Write`, `Edit`, `Glob`, `Grep` work on C: only, the system's own disk: a path on another drive, a network
  drive or a share (a remote volume, whatever its letter) is refused. A path that is not absolute is in the session's
  folder. A file is Read before Write or Edit changes it. Writing and editing follow the session's permission mode:
  Plan mode refuses, Ask permissions asks in a message box, the others write.
- `WebFetch` fetches a page through the server's `/__fetch` and has Haiku answer the prompt about it.
- `Agent` starts a subagent in the background, as the app's do: the call answers at once ("Async agent launched"); the
  agent, a conversation of its own with the same tools (but `Agent`), is one block in the session's conversation (its
  description; running with its latest step, or done, with its tool uses, tokens and time; the Verbose view adds its
  prompt, steps and result) and is listed in the Tasks pane; its own tool calls stay in it, not in the conversation
  (`ccd.code.<Tool>` gives them with `agent`). When it ends, a `<task-notification>` with its result and usage is the
  session's next message, shown as one line.
- `Skill` loads `C:\WINDOWS\CLAUDE\SKILLS\<name>\SKILL.MD`.

Each request starts with a system reminder, as Claude Code's do: `C:\WINDOWS\CLAUDE\CLAUDE.MD` (the user's own
instructions), each `CLAUDE.MD` from the root down to the session's folder (the project's), the memory Claude keeps in
`C:\WINDOWS\CLAUDE\MEMORY` (its index, `MEMORY.MD`), and the skills. Claude writes these with its own tools, so what it
writes there shapes its next request.
- `Bash` runs an MS-DOS command as `COMMAND.COM /C` runs it, in an MS-DOS machine with no window (v86.js: the CD's
  IO.SYS and COMMAND.COM on Windows' own C: and D:), starting in the session's folder, and answers with what it wrote
  to the console. The command line is MS-DOS's: 127 characters at most.

## MS-DOS

The MS-DOS Prompt, and any MS-DOS program opened, runs in a virtual-8086 machine (v86.js) that boots the CD's own
MS-DOS 7 (IO.SYS, COMMAND.COM; `tools/build_dos.py` writes them, with the programs Setup puts in
C:\WINDOWS\COMMAND, as msdos.js) and runs its code through the run-time translator in V86 mode. Its C: and D: are
Windows' own, as IFSMgr makes them: DOS network drives answered from fs.js. `win95.dos` lists the machines running;
each has `keys` (scan code << 8 | character, typed into its keyboard), `out` and its memory through `m8`/`m16`.

| Event | Fields | When |
| --- | --- | --- |
| `ccd.<server>.<tool>` | `args`, `result`, `error` | a tool is called |
| `ccd.code.<Tool>` | `session`, `agent`, `args`, `result`, `error` | CLAUDE.EXE's Claude uses one of Claude Code's tools that runs on the page (`Read`, `Write`, `Edit`, `Glob`, `Grep`) |
| `ccd.reply` | `session`, `text`, `error`, `stopped` | a turn ends, in the Claude window or CLAUDE.EXE (`text` its last reply) |
| `ccd.answer` | `label`, `message`, `session` or `card`, `action` | the user answers a next-step box or a card |
| `ccd.message` | `to`, `from`, `message`, `message_id` | `send_message` reaches a session |
| `ccd.session.start`, `ccd.session.stop` | `session`, `title`, `prompt` | a session starts or is stopped |
| `ccd.notify` | `kind`, `session` | a notification (a question, a finished task) |

## Diagnostics

With `?debug=1`, `win95.sysApp.cmd(name, args)` asks the system's machine (worker.js `cmd`). Each answers a promise.
Addresses in the answers are symbols where the machine knows one: `thunk USER.#47` (a 16-bit import's stand-in),
`KERNEL32!GetTickCount` (a 32-bit one's), `USER 3:bef (ISWINDOW+12)` (a 16-bit module's segment and offset, with the
export at or before it), `OLE32+1a2c0 (CoInitialize+40)` (a 32-bit module's), or hex when it is in no module.

| Call | Does |
| --- | --- |
| `cmd('probe')` | every thread (its state, program, what it waits on, where it stopped, its stack's return addresses and BP chain as symbols), the windows with their tasks, the processes, the loaded modules, and who holds the Win16 lock |
| `cmd('faults')` | the fault log, and clears it: code the machine found none at (`at`, `atIn`, `from`, `fromIn`, `thread`), USER's and KERNEL's parameter errors with the parameter, the function and its caller, and `LogError` calls |
| `cmd('trace', [threadRe, nameRe?])` | starts a trace of the stand-in and thunk calls the matching threads make (the JS-implemented imports only), with their arguments where known; `cmd('trace')` reads and clears what was traced |
| `cmd('watch', [dll, name, n = 4])` | hooks the export's entry: each call is logged with its first `n` stack arguments (dwords for a 32-bit module, words for a 16-bit one), its caller (`from`, a symbol), its thread, and once it returns to its caller its result (`eax`; for a 16-bit export `ax` and `dxax` too). `name` is an export's name, `#ordinal`, or `/regexp/` over the module's export names, so `cmd('watch', ['USER32', '/^(Create|Destroy)Window/'])` traces the calls other recompiled modules make into those. The names hooked are answered. Works for native 16-bit modules (`['USER', 'ISWINDOW']`, `['GDI', '#42']`) and 32-bit ones alike; a return is seen when it comes back through the dispatcher, that is from another module |
| `cmd('watch')` | reads and clears the watch log; `cmd('watch', [dll])` ends that module's watches |
| `cmd('watchAt', [dll, [offsets]])` | EAX each time execution comes to one of the offsets in that module from another module (a call into another DLL returning there), into the trace log; `cmd('watchAt', [dll, []])` ends it |
| `cmd('memwatch', [lin, len])` | a write watch on linear `[lin, lin+len)`: the range is compared with its last contents at each dispatch (a recompiled block's end, a stand-in's call) and each block of run-time code; `cmd('memwatch')` gives the hits so far (`at`, `n` bytes changed, `was`, `now`, `by`: what ran last, `thread`) and the count; `cmd('memwatch', [null])` ends it. Code of a recompiled module is sampled per block, so `by` names the block that ran, not the instruction |
| `cmd('call', [dll, name, args])` | calls the export on a thread of its own with dword or string arguments and answers its result; a DLL of the personality's (KERNEL32's stand-ins) is called through its thunk. `null` when there is no such export |
| `cmd('callPath', [dll, name, args, n = 400])` | the same, with the last `n` blocks it ran as symbols |
| `cmd('peek', [lin, n])` | `n` bytes of memory |
| `cmd('user16', [ordinal, [['w', v], ['l', v], ['buf', n]]])` | USER's ordinal called with those arguments; a `buf` is filled by the call and returned as bytes |
| `cmd('call16', [module, name or ordinal, [args as above, a buf with initial bytes as ['buf', n, bytes]]])` | any 16-bit module's export called the same way, the module loaded from disk if it is not yet (`['TOOLHELP', 'TASKFIRST', [['buf', 40, [40, 0]]]]`) |
| `cmd('effects')` | what the machine did and under which cause (ne16.js `effect`: input, remote, boot, host) |
| `win95.log(since = 0)` | the machines' log: `{ n, t, level, tag, text, machine }` per line, since line `n`. Everything the emulator says of itself (`win32`, `ne16`, `vxd`, `spawn` tags), what programs write with `OutputDebugString` (tagged with the program), KERNEL's `LogError`, and DevTools opening and closing. Each line is also written to the console with its level's method (`debug`, `info`, `warn`, `error`), so DevTools' level filter sorts them: Verbose shows the debug lines, Warnings the emulator's gaps, Errors the faults |
| `cmd('lag', [true])`, `cmd('lag')` | records each mouse and key event's time as it is taken from the ring and as it is fed into USER's drivers; `win95.lag(moves, keys)` sends moves and key presses and answers each one's times from the page's send: `ring`, `fed`, and for a move `seen` (the sprite showing it), with their medians |
| `win95.devtools` | whether DevTools are open (the Windows 95 app says; a browser tab cannot, so `false` there). The machine has it as the registry value `HKLM\Software\Microsoft\Windows\CurrentVersion\Debug\DevTools` (1 or 0), and a `devtools` event (`{ open }`) says when it changes |

The same log is in Windows itself: **Debug Monitor** (Programs > Accessories > System Tools, DBWIN.EXE, dbwin.js), a
window the lines are appended to as they come, as the SDK's DBWIN showed `OutputDebugString` output; Options >
Verbose shows the debug lines too. Option+Cmd+I (Ctrl+Alt+I, Ctrl+Shift+I, F12) opens the browser's DevTools before
the key reaches Windows; in the Windows 95 app the same key toggles them.

Before any reload, read `read_console_messages` and `cmd('faults')`: a reload wipes both. `console.log('=== MARK ...')`
before each step keeps the console in order.

### A shared session fuzzed over real machines

In a tab of the shell opened in a session of its own (`?debug=1&mute=1&session=<name>&user=Ann`):

```js
await import('/tools/convolution/fuzz-tabs.mjs'); await W95FuzzTabs.run({ seed: 1, actions: 10 })
```

opens two more tabs in that session (the browser must allow pop-ups for the page), gives this machine random
actions (programs run, text typed, windows moved and closed) while the second reloads in the middle and the third
joins late, waits until nothing is in flight, and compares the machines' digests (the session's windows, the shared
registry values, the effects logs: a remote start made twice, echoes; MRU values that differ are logged). A failing
trace is shrunk to the fewest actions that still fail, each try in a fresh session, and offered as a replay test
(`W95FuzzTabs.replay({ trace })`). `tools/convolution/fuzz.mjs` walks the protocol's model the same way, without
machines.

## Exploring

`node bench/explore.mjs [endpoint] [--minutes 10] [--depth 12]` drives the system with these calls only, clicking
elements `elements()` lists and pressing keys, and reports what went wrong on the way (as `gaps.mjs` does) with the
path of inputs that led to each finding. It writes `bench/results/explore-<stamp>.json` and, per finding, a replay
`bench/repro-<stamp>-<n>.mjs` that `gaps.mjs` runs as it is: a fix is done when that replay shows the finding no
more and the last bench replay shows nothing worse.

## Example

```js
const s = win95.screen()
win95.click(20, s.taskbar + 15)        // Start
win95.menus()[0]                       // ['Programs', 'Documents', ..., 'Shut Down...']
win95.key('esc')
win95.run('notepad C:\\AUTOEXEC.BAT')
await win95.next('window.open', e => /Notepad$/.test(e.title))
win95.type('REM edited by script\n')
win95.key('alt+F4')
await win95.next('window.open', e => e.modal)   // the save prompt
win95.key('alt+y')                     // Yes
```
