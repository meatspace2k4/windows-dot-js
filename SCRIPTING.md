# Scripting the shell

`window.win95` drives the running shell through the same paths a person uses: pointer events on the screen
canvas and keys through the shell's key handler. It is the same in the Electron app (DevTools protocol on
`127.0.0.1:9334`, `Runtime.evaluate`) and in a browser tab (`http://localhost:8095`).

Coordinates are screen pixels of the emulated display, origin top left. `win95.screen()` gives the size.

## Reading the screen: start here

`await win95.report(n = 3)` is the one call for "what is on the screen and what went wrong". Use it before anything
else; do not write a script to read a dialog.

- `screen`: what the `screen` event carries (`desktop`, `dos`, `logow`, ...).
- `windows`: each window, bottom to top, with `title`, `x`, `y`, `w`, `h`, `active` and `modal`. Its `text` lists
  every control as its machine has it now (`static: Setup needs to restart...`, `button: Restart Now`), so a dialog's
  message and buttons can be read without a screenshot.
- `faults`: the line's last `n` faults, each with `why`, `program`, `module`, `eip` and `cr2` in hex, and `last`, the
  fault log's last entry (`why`, `at` as a symbol, the first eight stack words as symbols).

## Input

| Call | Does |
| --- | --- |
| `move(x, y)` | moves the pointer |
| `click(x, y, { button: 'right', double: true })` | press and release; both options optional |
| `dblclick(x, y)` | two clicks inside the double-click time |
| `down(x, y, o)`, `up(x, y, o)` | one half of a click, for custom gestures |
| `drag(x1, y1, x2, y2, steps = 8)` | press, move in steps, release, each once the machine has fed the last to USER (its frames say so) and the page has drawn it, as a person's come in; a promise for the release |
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
| `pc.text()`, `pc.type(keys)`, `pc.reset()`, `pc.inWindows`, `pc.machine`, `pc.failed` | the PC under Windows: its BIOS boots C:'s MS-DOS at each start (IO.SYS, CONFIG.SYS, AUTOEXEC.BAT, WIN.COM, VMM32.VXD's loader), and Windows has the screen from where the VMM's loader enters protected mode until Windows ends (Restart in MS-DOS mode: WIN.COM's DOSSTART.BAT and COMMAND.COM; EXIT starts Windows again). Its 80x25 text screen as lines; keys typed at its keyboard (`{Enter}`, `{F8}`, ... by name); a power cycle; whether Windows has it; its v86.js machine; why it stopped |
| `cd.images()`, `cd.insert(name)`, `cd.eject()`, `cd.disc` | the CD images the drive can take (`tools/serve.py --iso` and each `--cd`, listed at `/__cd`; the app's File > Insert CD Image), putting one in D: (its tree read from the disc, the drive's media change counted for MSCDEX, AutoRun then as Explorer runs it), taking it out (D: not ready), the disc in it (`{ label, serial, sectors }` or `null`). The choice is kept for the next start; `?cd=<name>` picks one. The audio CD stays in E: |

## State

| Call | Returns |
| --- | --- |
| `screen()` | `{ width, height, taskbar, screen }`, `taskbar` the top row of the taskbar, `screen` what the `screen` event carries (`desktop`, `dos`, `black`, `logow`, `logos`): read it before waiting on the event, which comes only on a change |
| `screenshot()` | the screen as a PNG data URL |
| `state` | menus, modals, pointer capture, active window title |

## Ring α, "Braid": time travel through the running OS (braid.js, braid-page.js)

The machine's run is a line to move along, not a sequence to repeat. A moment is everything at an instant: each
machine's memory, registers and host-side objects (threads, tasks, VxD time-outs, VMs, heaps, faults: one graph,
held by identity and written back into the same objects), the registry, the page's disk (the volumes' trees; travel
writes the disk's store what the tree has then for every node written since) and the shell. Every moment is at a
time of the machine's own clock (`braid.now()`: a quantum per BUDGET blocks run and a period per step, so the same
run reads the same times on every host, and a CPU-bound check ends at the same time everywhere), and the line is the
whole of that time, in generations: travel to a moment forks it, the new generation grows from the moment, and the
one left runs no further but its moments stay, to travel to again. A lock-up, a blue screen, a fault dialog: travel
to the moment before it and go on, with the machine's scripts changed meanwhile if need be (`reloadScript`: a mod).

Moments live in this page's memory and end with it, unless anchored on this computer (IndexedDB), where a page that
starts later travels to them; neither needs a server. A running line is always anchored: `every` anchors it as well
as marking it, so a reload costs a run nothing; marks are for moving about within the page. An anchor is stored as
chunks of 256 KB under their SHA-256, each kept once, so anchors minutes apart share all the memory that did not
change, and letting one go deletes only the chunks no other anchor has. A moment is a record of named sections under a checksum and the
signature of the build that made it (braid.js, win32.js, ne16.js, vmm.js, v86.js, dyn.js, fs.js): a damaged copy or
another build's is refused. The lint compares moments and disallows system-breaking states (its verdict on each:
`broken`, `suspect`, `ok`); the mods are named beside a moment, as a sidecar, never carried in it. In a shared
session every person's marks, anchors, travels, scrubs and forgets are the session's: each is posted as an intent and
made on every machine, the asker's too, as it reaches it in the session's op order, so each machine takes its own
moment, or goes back to it, at the same place in the session's history (its disk and registry stay its own, as a
session keeps them). The server keeps the session's shared state (its objects, settings and strokes) with each mark
or anchor (tools/sessions.py), the anchored ones in its folder; a travel to one sets it back on every machine, which
then sets its copies of the session's objects to it, as a machine joining does. Braid's intents are not settings: a
machine joining does not make them again. The line marking and anchoring itself (`every`) is each machine's own. In a
session, SESSTRAY.EXE's Braid icon in the notification area marks or anchors a moment, or travels to one, from inside
Windows.

| Call | Does |
| --- | --- |
| `braid.mark(name?)` | a moment of everything, now (between two steps; about half a second and the memory's size), `m<n>` when unnamed; linted against the moment before it on the line. Resolves with what was taken (`bytes`, the `build` signature, `sum`, `verdict`, `findings`, `gen`). In a shared session, at a machine time 200 ms ahead, which every machine marks at |
| `braid.travel(name, { force })` | to that moment, back or ahead, in any generation: the machines first, then the disk, registry and shell, then the disk's store (`disk.wrote`, `disk.removed`). The input waiting is dropped; the clock reads the moment's time; the mods loaded now stay. A moment anchored on this computer and not in this page's memory is arrived at in the page's machines, booted as they are, by the paths of their objects. Refused for a damaged moment, another build's, or one the lint found broken, unless `force` |
| `braid.travel({ t })` | to machine time `t` on the line (a scrub, back or ahead): the moment at or before it on the lineage, then the run from there to `t`, fast (`speed`), with the journal's actions made again as the clock reaches each one's time; from where the line is when that is between the moment and `t` |
| `braid.anchor(name?)` | the moment of now anchored on this computer (every machine's bytes and objects by name and path, the disk, the shell, the registry, the mods, the line), under a checksum and the build signature; marked on the line here as well. The memo's ground: a page that has it starts there, nothing run again |
| `braid.moments()`, `braid.forget(name)` | every moment on the line (`here`: this page's memory; `anchored`: this computer; `gen`, `at`, `verdict`); one let go from both |
| `braid.every(ms = 30000, keep = 3, { anchorEvery = 300000, anchorKeep = 3 })`, `braid.auto` | the line marking itself as the machine runs, `t1`, `t2`, ..., the last `keep` held (one found broken is held beyond them): what a lock-up or a crash is travelled back from when no one marked a moment. And anchoring itself on this computer every `anchorEvery` ms, `live1`, `live2`, ..., the last `anchorKeep` kept (a broken one held beyond them), an older one let go only after a newer one is written: what a reloaded page travels back to. `every(0)` ends both; `anchorEvery: 0` the anchoring alone |
| `braid.lint(a, b?)` | the system's machine between two moments (or a moment and now): `verdict` and `findings`. The signs of a machine that will not come back: the Win16Lock held by one thread across both, a thread at the same place with its time running out each slice, a ring-0 run at the same place, faults since, the process ended, a heap or queue only growing. Heuristics: the halting problem allows no proof |
| `braid.memo(actions)` | a span already computed: the segment from the moment the line is at whose actions are these (`[[op, args], ...]`, as the journal has them) and whose end is on the line. The line travels to its end, the work between not done again (PIDGEN's key check, a copy): `{ from, to, ms, gen }`, or null |
| `braid.line` | the line: `gen` now, `forks` (each generation: the moment and generation it grew from, `how`: travel, scrub, memo, anchor), `moments` with their verdicts, `segments` (each pair of moments, with how many actions between), `events` (every fault a machine reported, under its generation), `journal` |
| `braid.journal` | the actions made through the API since the last moment (`click`, `dblclick`, `type`, `key`, `run`, `drag`, `open`), each stamped with the machine's clock; `segments`: each pair of moments with the actions between them |
| `braid.same(a, b)` | two faults of the line compared record for record (by index into `line.events`, or `{ gen }` for a generation's last): `same`, and `diff` where they part |
| `braid.now()` | the machine's own clock (ms since its start) |
| `braid.setMachineSpeed(x)` | both machines run ahead of the wall by `x`: the PC's (its clock times the loading screen and the boot before Windows' own machine starts) and the system's (steps back to back, each `x` periods), so what waits on time passes `x` times faster than real time (progress bars included; `setMachineSpeed(1)` is a person's pace again). Resolves with what `speed()` reads |
| `braid.speed()` | read only: the speed each machine is set to (`pc`, `system`; `null` for one not running) and the system's clock (`now`) |
| `braid.watchPageLongTasks(ms = 300)`, `braid.pageLongTasks()` | each time one task held the page's main thread longer than `ms` (the PC's machine, the shell and a travel's unpacking run there): `at`, `ms`, `heapMB`, the braid `step` in progress. `watchPageLongTasks` starts the log afresh (`0` ends it and hands it back), `pageLongTasks` reads it; each is also the event `braid.pageLongTask` |
| `braid.mods` | the scripts loaded over the running machine or page (`reloadScript`), `{ name, sum }` each: named beside every moment marked from then on |
| `braid.window()`, Run > `braid` | the Braid window: the line as a slider (moments as ticks coloured by the lint, forks as wedges, the thumb at now); drag the thumb to a time or click a moment to travel; Mark, Anchor, Lint; the line marking itself |
| `sysApp.cmd('mark' \| 'markAt' \| 'travel' \| 'moments' \| 'forget' \| 'lint' \| 'probe' \| 'speed' \| 'now' \| 'until' \| 'mods' \| 'export' \| 'import', [...])` | the same for one machine alone (`markAt`: at a time of its clock; `until`: run fast to a time and answer; `export`, `import`: its moment as bytes, and arrived at from them) |

Events: `braid.mark`, `braid.travel`, `braid.scrub`, `braid.anchor`, `braid.lint` (`moment`, `from`, `verdict`,
`findings`), `braid.broken` (the line marked itself and found the state broken), `braid.fault` (`gen`, `machine`,
`fault`, `faults`, `index`), `braid.mod`.

CLAUDE.EXE's Claude has it as its `Braid` tool (`action`: mark, travel, moments, lint, line, memo, anchor, every, mods,
speed, now, forget, window), so a lock-up met while it works is left by travelling, and a fix loaded with
`reloadScript` is tried from the moment before the fault. The page API is the test entry point.

`bench/setup98.mjs`'s `pageDrive(key, { every: 30000 })` runs Windows 98 Setup with the line marking itself: a fault
dialog or a broken verdict is travelled back from (the moment before it) and the step lived again, the fork recorded;
the key check and each page already lived from the same moment are memo'd past.

## Events

| Call | Does |
| --- | --- |
| `on(type, fn)` | calls `fn(event)` for each event of `type`; returns the function that stops it |
| `next(type, test?, ms = 10000)` | a promise for the next event of `type` that passes `test`; rejects at once, with what failed, when the system fails meanwhile (`system.fail`, `braid.fault`), else after `ms`. An element's lookup (`click({ name })`, `waitFor`) ends the same way |

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
| `system.fail` | `kind` (`console`, `exception`, `rejection`), `text` | the page logs an error (a worker's error and the machines' error lines come through it) or has an uncaught exception or rejection |
| `devtools` | `open` | the browser's DevTools open or close (the Windows 95 app says; a browser tab cannot) |
| `tray.follow`, `tray.window` | `client`; `id`, `client` | Follow chosen from a person's notification-area icon (`client` null when ended); one of their windows chosen there |
| `sync.input` | `id`, `n`, `events`, `done` | this person's mouse stroke into a session object's window, or part of one, sent to the session |
| `sync.stroke` | `id`, `by`, `events`, `done` | another person's stroke, or part of one, fed into this machine's copy of the window |
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
| `ccd.toolDefs()` | the tools as the Claude API takes them: every `ccd_<server>__<tool>`, and Claude Code's `AskUserQuestion`, `Bash`, `JavaScript`, `Read`, `Write`, `Edit`, `Glob`, `Grep` |
| `ccd.context(session)` | what goes ahead of each of the session's requests: the CLAUDE.MD files, the memory's index, the skills |
| `ccd.callAs(session, name, args)` | runs a tool by that name for the session, as CLAUDE.EXE's Claude does |
| `ccd.cardAnswer(task_id, label)` | answers a card with its button's label, as CLAUDE.EXE's card buttons do |

CLAUDE.EXE's Claude has Claude Code's own tools besides the app's, with Claude Code's names, parameters and answers:
- `Read`, `Write`, `Edit`, `Glob`, `Grep` work on C:, the system's own disk, and on `SRC:\`, the project's own code:
  the checkout `tools/serve.py` serves, through its `/__src` (tools/src_api.py; this machine's own pages only; `.git`,
  and a path through a symbolic link, such as a worktree's link to a generated bundle, refused). A page whose server
  has no `/__src` (the deployed site) refuses `SRC:\`. Any other drive, a network drive or a share (a remote volume,
  whatever its letter) is refused. A path that is not absolute is in the session's
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
- `JavaScript` runs code in the page, with `win95` (this API, `sysApp.cmd` diagnostics included) in scope: an
  expression's value (a promise awaited) or a function body's return, as JSON up to 30000 characters. Asked first in
  Ask permissions and Plan mode.

### Changing the system while it runs

`win95.reloadScript(file)` loads a script of the site again from its server into the running system, no restart. A
script of the machines' (`claude-app.js`, `shell32.js`, `session-tray.js`, `dbwin.js`, ...) goes to the system's
machine, `cmd('reload', [file])`: its `def()`s replace the exports' functions in place (win32.js `def`), so the
thunks programs already hold call the new code. Of the page's scripts only `ccd.js` is loaded again into the page; any other
(`win95.js`, ...) runs the page itself and is refused: reload the page instead. `ccd.js`'s tools
are made again on next use from their registry records. A script keeps across a reload only what it puts on the
worker itself: `claude-app.js` keeps its window, its turns in progress and its tools' pending answers
(`self.W95ClaudeKeep`), so CLAUDE.EXE's Claude can `Edit` its own code on `SRC:\` and reload it in the middle of a
turn (tests/claudeturn.test.mjs). A script's other module state starts again.

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
| `cmd('probe')` | every thread (its state, program, what it waits on, where it stopped, its stack's return addresses and BP chain as symbols), the windows with their tasks, the processes, the loaded modules, who holds the Win16 lock, and `stats` (timer messages, GL frames, slices, `guestMs`: the processor time guest code has had) |
| `cmd('reload', [file])` | loads a script of the machine's again into it, no restart (see Changing the system while it runs) |
| `cmd('faults')` | the fault log, and clears it: code the machine found none at (`at`, `atIn`, `from`, `fromIn`, `thread`), USER's and KERNEL's parameter errors with the parameter, the function and its caller, `LogError` calls, and the processor exception that ended a program or the system (`ring`, `module`, `cr2`, `regs`, `stack`) |
| `cmd('trace', [threadRe, nameRe?])` | starts a trace of the stand-in and thunk calls the matching threads make (the JS-implemented imports only), with their arguments where known; `cmd('trace')` reads and clears what was traced |
| `cmd('watch', [dll, name, n = 4])` | hooks the export's entry: each call is logged with its first `n` stack arguments (dwords for a 32-bit module, words for a 16-bit one), its caller (`from`, a symbol), its thread, and once it returns to its caller its result (`eax`; for a 16-bit export `ax` and `dxax` too). `name` is an export's name, `#ordinal`, or `/regexp/` over the module's export names, so `cmd('watch', ['USER32', '/^(Create|Destroy)Window/'])` traces the calls other recompiled modules make into those. The names hooked are answered. Works for native 16-bit modules (`['USER', 'ISWINDOW']`, `['GDI', '#42']`) and 32-bit ones alike; a return is seen when it comes back through the dispatcher, that is from another module |
| `cmd('watch')` | reads and clears the watch log; `cmd('watch', [dll])` ends that module's watches |
| `cmd('watchAt', [dll, [offsets]])` | EAX each time execution comes to one of the offsets in that module from another module (a call into another DLL returning there), into the trace log; `dll` may be a program's file name (`AUTORUN`), its process's own image; `cmd('watchAt', [dll, []])` ends it and answers how many dispatches came into the module and at which offsets |
| `cmd('blocks', [pathRe, n = 4000])` | records each block of run-time code (dyn.js) the threads of programs whose path (a Windows 3.x task's module name) matches run, as `thread symbol`, the last `n`; `cmd('blocks')` answers them and ends it. A program the bundle does not carry runs this way, its imports' code too where it is a module run from its file |
| `?scriptlog=1`, `win95.scriptLog = true` | each `win95.*` call and each `win95.sysApp.cmd`, numbered, then what it answered, as `script` lines at the debug level (Verbose in DevTools' console and in Debug Monitor's Options), so the person at the screen sees what a script does; `win95.note(text)` adds a line of the script's own |
| `python3 tools/staticmap.py` | the gap map, by static analysis of the bundle's modules with nothing run (`findings/gapmap.json`): each module's code reachable from its entry points; the instructions there the recompiler made #UD and the blocks run-time translation cannot take, graded by how they are reached (control flow from an entry point, or only a data pointer); the VxD services called that nothing provides (a VxD's service an entry point only when reachable code calls it and no stand-in takes it), and those of devices the system does not have, guarded or not by a test of the device's Get_Version; and each stand-in whose callers read a result it does not set (a flag tested after the call, a register a C service's caller reads besides EAX). `W95_SCRIPTS=<folder>` runs it on other scripts (an older `vmm.js`) |
| `python3 tools/v86mem.py <folder of .vxd>` | where a VxD reads or writes the system VM's first megabyte itself, not through a VMM service (an interrupt vector by its number, `[reg*4]`; an absolute address in the IVT, the BIOS data area or the adapter area; a linear address made segment:offset for real-mode code), by static scan with the LE fixups excluded (`findings/v86mem.json`). Every such place is state that must be in guest memory, not in a stand-in's own table: VNETBIOS read the INT 5Ch vector at 170h and the vectors lived in a map |
| `python3 tools/realcheck.py` | each VxD service stand-in against Windows 95's own service (VMM32.VXD's VMM and the CD cabinets' VxDs, from `cdrom.iso` with 7z, or `--vxds <folder>`), by static analysis of the originals after `tools/staticmap.py`: a result the original returns that callers read and the stand-in does not set, or a register or flag the stand-in changes that the original keeps and callers read (`findings/realcheck.json`) |
| `?memwatch=lo,len` | `cmd('memwatch')` from the machine's first instruction (hex), boot's writes too |
| `?dynat=IFSMGR` or `?dynat=12219c9,...` | a VxD's blocks (all of a VxD's, by its name) run as run-time code, block by block: a write watch then names the block that wrote, and the return addresses on its stack (`stack`) |
| `cmd('memwatch', [lin, len])` | a write watch on linear `[lin, lin+len)`: the range is compared with its last contents at each dispatch (a recompiled block's end, a stand-in's call) and each block of run-time code; `cmd('memwatch')` gives the hits so far (`at`, `n` bytes changed, `was`, `now`, `by`: what ran last, `thread`) and the count; `cmd('memwatch', [null])` ends it. Code of a recompiled module is sampled per block, so `by` names the block that ran, not the instruction |
| `cmd('call', [dll, name, args])` | calls the export on a thread of its own with dword or string arguments and answers its result; a DLL of the personality's (KERNEL32's stand-ins) is called through its thunk. `null` when there is no such export |
| `cmd('callPath', [dll, name, args, n = 400])` | the same, with the last `n` blocks it ran as symbols |
| `cmd('peek', [lin, n])` | `n` bytes of memory |
| `cmd('user16', [ordinal, [['w', v], ['l', v], ['buf', n]]])` | USER's ordinal called with those arguments; a `buf` is filled by the call and returned as bytes |
| `cmd('call16', [module, name or ordinal, [args as above, a buf with initial bytes as ['buf', n, bytes]]])` | any 16-bit module's export called the same way, the module loaded from disk if it is not yet (`['TOOLHELP', 'TASKFIRST', [['buf', 40, [40, 0]]]]`) |
| `cmd('effects')` | what the machine did and under which cause (ne16.js `effect`: input, remote, boot, host) |
| `win95.log(since = 0)` | the machines' log: `{ n, t, level, tag, text, machine }` per line, since line `n`. Everything the emulator says of itself (`win32`, `ne16`, `vxd`, `spawn` tags), what programs write with `OutputDebugString` (tagged with the program), KERNEL's `LogError`, and DevTools opening and closing. Each line is also written to the console with its level's method (`debug`, `info`, `warn`, `error`), so DevTools' level filter sorts them: Verbose shows the debug lines, Warnings the emulator's gaps, Errors the faults |
| `cmd('lag', [true])`, `cmd('lag')` | records each mouse and key event's time as it is taken from the ring and as it is fed into USER's drivers; `win95.lag(moves, keys)` sends moves and key presses and answers each one's times from the page's send: `ring`, `fed`, and for a move `seen` (the sprite showing it), with their medians. With the log on, a shared session's strokes are in it too: `stroke-rec` (this person's, as recorded), `stroke-fed` (another's, as posted), `stroke-miss` (a press no window took) |
| `cmd('strokes', [hwnd?, x, y])` | a shared session's strokes here: the others' waiting and being fed (by key, events left, lost), this person's going, the buttons held, the moves fed and taken (`movesFed`, `taken`: the program's DispatchMessage counted, which paces a drag), the mouse queue; with a window, its queue's state and the child under the point |
| `cmd('pace', [n])` | how many of a drag's moves may go in ahead of the program taking them (4) |
| `win95.devtools` | whether DevTools are open (the Windows 95 app says; a browser tab cannot, so `false` there). The machine has it as the registry value `HKLM\Software\Microsoft\Windows\CurrentVersion\Debug\DevTools` (1 or 0), and a `devtools` event (`{ open }`) says when it changes |

The same log is in Windows itself: **Debug Monitor** (Programs > Accessories > System Tools, DBWIN.EXE, dbwin.js), a
window the lines are appended to as they come, as the SDK's DBWIN showed `OutputDebugString` output; Options >
Verbose shows the debug lines too. Option+Cmd+I (Ctrl+Alt+I, Ctrl+Shift+I, F12) opens the browser's DevTools before
the key reaches Windows; in the Windows 95 app the same key toggles them.

Before any reload, read `read_console_messages` and `cmd('faults')`: a reload wipes both. `console.log('=== MARK ...')`
before each step keeps the console in order.

### A shared session's input

A person's mouse strokes into a session object's window (a button pressed, the moves while it is held, its release)
are the session's, as the windows are: several people draw in one Paint at once, deal in one Solitaire, press one
Calculator's keys. The machine records this person's strokes as offsets from the top-level window they went to
(worker.js `recordStroke`, ne16.js `strokeTarget`: not a press on a caption, border or button, whose outcome the
object sync carries; a stroke into a popup of the object's, a menu or a dialog, names it by class and title), posts
them to the page in parts as they go, and the page sends them by the object's id (`input` ops, shared.js; the server
keeps each object's for a machine joining, which feeds them into its copy once the object is up). Another machine's
stroke is fed into this machine's copy of the window as the mouse messages it would be, posted to the window under
its first point (ne16.js `childAt`, `postMouse`), one stroke at a time and only while this person holds no button
(worker.js `feedStroke`), so the program sees each stroke whole and this person's pointer stays where it is; the
other person's pointer is drawn where their stroke has got to here (`strokeAt`). A drag's own moves go in up to
four ahead of the program taking them (USER32's `DispatchMessageA` and USER's `DispatchMessage` watched at their
entry, ne16.js `hookTaken`) and are never coalesced while a button is held, so every point of a curve reaches the
program. Each person's pointer shows to the others as their Windows shows it to them: the cursor image goes with the
pointer once per image, with its hot spot (win95.js `peerCursorOf`, sessions.py `cursors`). The windows must be the
same size on every machine for the offsets to land alike, which the object sync keeps (a maximized window is each
screen's own: the same screen size on each machine, then).

### Sketching from vectors

```js
await import('/tools/sketch.mjs'); await W95Sketch.draw(svgText, { box: { x: 100, y: 80, w: 840, h: 520 }, ms: 5 })
```

draws an SVG with the pointer (`win95.down/move/up`): its `path`, `line`, `polyline`, `polygon`, `rect`, `circle` and
`ellipse` elements, the path commands M, L, H, V, C, S, Q, T, A and Z, absolute or relative, each subpath one stroke,
curves flattened by flatness and resampled `step` (3) pixels apart with corners kept, the viewBox fitted into `box`,
`ms` the pace per point. `paths(svg, o)` gives the strokes as screen points without drawing; `flatten(d, tol)` a
path's polylines; `resample(poly, step)`. tests/sketch.test.mjs checks the flattening.

### A shared session fuzzed over real machines

In a tab of the shell opened in a session of its own (`?debug=1&mute=1&session=<name>&user=Ann`):

```js
await import('/tools/convolution/fuzz-tabs.mjs'); await W95FuzzTabs.run({ seed: 1, actions: 10 })
```

opens two more tabs in that session (the browser must allow pop-ups for the page; where it gives no tabs, as the
desktop app's browser pane, `{ frames: true }` makes them frames in this tab, each a machine with a client id of its
own: `?client=` names a page's machine), gives this machine random
actions (programs run, text typed, windows moved and closed) while the second reloads in the middle and the third
joins late, waits until nothing is in flight, and compares the machines' digests (the session's windows, the shared
registry values, the effects logs: a remote start made twice, echoes; MRU values that differ are logged). A failing
trace is shrunk to the fewest actions that still fail, each try in a fresh session, and offered as a replay test
(`W95FuzzTabs.replay({ trace })`). `tools/convolution/fuzz.mjs` walks the protocol's model the same way, without
machines.

## The debugger

`win95.debug` debugs the system machine's translated code and its Windows API calls (dynjs.js). Every call returns a
promise. A place is an address in hex, `MODULE+offset`, or an API `DLL!Export` (`USER32!DrawIconEx`, `USER!#123`).

| Call | Does |
| --- | --- |
| `modules()` | the translated modules: `[{ name, lo, hi, base, blocks, js }]` |
| `run(names)` | runs exactly these modules as JavaScript (`'*'` for all), the rest as WebAssembly; their source shows in DevTools as `dyn/NAME.js`, a function a block (`b_1001def`), registers in `R` |
| `breakpoint({ at, when, capture })` | records a hit each time the block at `at` is entered, and runs on; `when` and `capture` are expressions over `R`, `r8/r16/r32`, `n`, `thread` |
| `hits(since)`, `next(id, ms)` | the recorded hits; the next one (also the `debug.hit` event) |
| `remove(id)`, `clear()`, `breakpoints()` | |
| `watch(dll, name, n)`, `calls()`, `unwatch(dll)` | traces calls of an export (or `/regexp/`) with `n` arguments, without stopping |
| `stopAt(call, n)`, `unstop(id)`, `stops()` | routes an API's calls through `w95ApiEntry`, where a debugger's breakpoint stops at them |
| `resolve(place)`, `where(address)` | a place's address; an address's name |
| `state()` | registers, flags, the stack with code addresses named, the thread, its program, the Win16Lock |
| `source(place)`, `read(place, n)` | the JavaScript of the block holding a place; guest memory |

`tools/devtools-mcp.mjs` is an MCP server that drives a browser's debugger over the Chrome DevTools Protocol
(`CDP_URL`, default `http://127.0.0.1:9222`; registered in `.mcp.json` as `devtools`). It attaches to the page and
its worker and adds, on top of the debugger's own tools (`breakpoint`, `pause`, `resume`, `step`, `paused`,
`evaluate`, `scripts`, `source`, `console`, `screenshot`), the machine's: `guest_break` (stop at a place, with a
condition), `api_break` (stop at an API's calls), `api_watch` and `api_calls`, `guest_state`, `guest_step` (to the
next block), `guest_memory`, `guest_record` and `guest_hits`, `guest_modules`, `guest_run`. From a shell:
`node tools/devtools-mcp.mjs --daemon`, then `--call <tool> '<json>'`.

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
