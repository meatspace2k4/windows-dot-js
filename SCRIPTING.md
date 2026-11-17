# Driving the machine: a manual

## 1. How a session with the machine goes

The machine is a running Windows in a browser tab. You work it the way a person at its screen would: look, do one
thing, look at what that did, decide the next thing. The tools are built so that you never act on a state you have
not been shown: **every answer is the machine's state, and the next thing you do is decided from it.**

The tools are the `devtools` MCP server's (tools/devtools-mcp.mjs, registered in `.mcp.json`). From a shell the same
tools run as `node tools/devtools-mcp.mjs --run '[["shell_report",{}]]'`, several calls in order in one list.

**Where the machine runs while you develop: the app.** `sh electron/build.sh` builds `electron/Windows 95.app` from
the working tree; `open -n "electron/Windows 95.app"` starts it with its debugger at `127.0.0.1:9334`, where the tools
find it with nothing set (Chrome at 9222 is the fallback; `CDP_URL` names another). The machine is worked through
these tools and the page's API, which read the machine's own windows, controls, faults and log. The built-in browser
pane, the Chrome extension and computer-use tools are not used on it: they see pixels of a screen the machine already
describes.

| To | Use |
| --- | --- |
| see the screen and what went wrong | `shell_report` |
| press, type, run | `shell_click`, `shell_key`, `shell_type`, `shell_run`, `shell_set` |
| ask the machine itself | `shell_cmd` (`probe`, `faults`, `call16`, ...: chapter 3), `shell_eval`, `worker_eval` |
| stop it at a line of the emulator, or where guest code or an API call enters | `breakpoint` + `paused` + `evaluate` (session: the worker); `guest_break`, `api_break` |
| watch a long run (Setup, a boot) | `node tools/shell-events.mjs` under a monitor: each fault, failure, screen and window as it comes |
| go back before a fault | `win95.braid.travel` (chapter 4) |
| start from a blank disk | quit the app, delete `~/Library/Application Support/local.win95/C.db*`, start it |

**Look.** `shell_report` answers what has happened since your last call (`events`: windows opened and closed, menus,
programs ended, faults, errors on the page) and the screen now (`report`: every window, bottom to top, with the text
of each of its controls, and the latest faults). A dialog's message and buttons are in its window's `text`, so a
screenshot is not needed to read one.

**Act.** `shell_click` (an element as `{ name, role, window }`, strings or `"/regexp/"`, never coordinates),
`shell_key`, `shell_type`, `shell_run`. Each answers as `shell_report` does once the machine has taken the input: the
events since your last call, and the screen now. That answer is the state. There is no separate wait: a window the
action opens is in its events, or in the next call's if it came later, because every call carries everything that
happened since the one before.

**Decide from the answer.** The window you meant to reach is in it: go on. Something else came (a warning, a question,
a fault): that is the state now, deal with it first. The answer has an `error`: it says what failed (a console error
or uncaught exception on the page, a fault a machine reported, an element that is not there, with what the window does
have). Read it; it names the problem.

A worked session, setting the display to True Color:

1. `shell_run {"command": "control desk.cpl"}`: the events have `window.open Display Properties`; its text is the
   Background tab's controls.
2. `shell_click {"query": {"name": "Settings ", "window": "Display Properties"}}`: its text now has
   `combobox: High Color (16 bit)` and `text: 756 by 562 pixels`.
3. `shell_click` the combo box, then `shell_key {"keys": ["end", "enter"]}`: the combo box reads True Color (24 bit).
4. `shell_click {"query": {"name": "Apply", "window": "Display Properties"}}`: the events have `window.open
   Compatibility Warning`. That is the state: click its "without restarting" option and OK. The answer to that has
   Windows' resize notice; its OK's answer has `Monitor Settings`; its Yes's answer has it closed and the display at
   True Color.

The machine runs whether or not you are looking. Monitor Settings puts the old mode back after 15 seconds unless it
is answered, so answer what an answer shows in the next call.

The tools call `window.win95`, the page's API, which the rest of this manual describes. It is the same in the
Electron app (DevTools protocol on `127.0.0.1:9334`) and in a browser tab. Coordinates are screen pixels of the
emulated display, origin top left; `win95.screen()` gives the size.

## 2. Reading and working the screen

### The screen and what went wrong

`await win95.report(n = 3)` is the screen and what went wrong. `await win95.outcome(fn, n)` runs one call (`fn`, or
none) and answers `{ result, error, events, report }`: every event since the last `outcome`, and `report` once the
machines have taken the input. The MCP tools are these two. A report has:

- `screen`: `desktop`, `dos`, `black`, `logow`, `logos` (the boot and shutdown screens).
- `windows`: each window, bottom to top, with `title`, `x`, `y`, `w`, `h`, `active` and `modal`, and `text`: every
  control as its machine has it now (`static: Setup needs to restart...`, `pushbutton: Restart Now`).
- `faults`: the last `n` faults, each with `why`, `program`, `module`, `eip` and `cr2`, and `last`, the fault log's
  last entry (`why`, `at` as a symbol, the first eight stack words).

### Acting on an element

`click`, `dblclick`, `down`, `up` and `drag` take an element (from `elements()`/`find()`) or a query for one
(`{ name, role, window }`, strings or RegExps). The element is looked up as its machine shows it now; a desktop icon or
a folder window's file is selected (`click`) or opened (`dblclick`) by its list view itself; a native button, radio
button or check box is pressed by its own window (the control is told to click itself), and a tab is chosen by its
tab control; only when a person could do so now: the control is enabled, its window is the active one and no dialog
waits over it; otherwise the call rejects, naming the window that is active. Anything else gets the pointer at its
centre. `set(query, value)` (`shell_set`) chooses a native combo box's item by its text, or moves a slider (`'min'`,
`'max'` or a number), the same way. Every answer's `how` says which of these was done. A window that is not the
active one is brought forward first with `activate(title)` (`shell_activate`). The call rejects, saying why, when nothing matches (naming what the window has), when something
covers the point, or at once when the system fails meanwhile. `waitFor(query, ms)` looks an element up the same way
and resolves with it.

Keys: `type(text)` types each character (`\n` is Enter); `key('alt+F4', 'tab', 'enter')` presses named keys with
`ctrl+`, `shift+`, `alt+`, `meta+` (`enter`, `esc`, `tab`, `backspace`, `delete`, `up`, `down`, `left`, `right`,
`home`, `end`, `pageup`, `pagedown`, `space`, `F1`..`F12`, or a character). Dialogs take mnemonics as Windows does:
`key('alt+n')` presses `&No`.

With coordinates, `move(x, y)`, `click(x, y, { button: 'right', double: true })`, `dblclick`, `down`/`up` and
`drag(x1, y1, x2, y2, steps)` act at once and return nothing; `drag` paces each part until the machine has fed the
last to USER and the page has drawn it, as a person's hand does.

### Windows, menus, programs, files

| Call | Does |
| --- | --- |
| `windows()` | `[{ title, x, y, w, h, active, minimized, maximized, modal }]`, bottom to top |
| `elements(query?)`, `await elementsNow(query?)` | what is on screen, `[{ role, name, window, x, y, w, h, ... }]`; `elementsNow` asks each native window's machine afresh |
| `window(title)`, `activate(title)`, `close(title)` | the topmost window by title (string or RegExp); brings one forward; closes one as its close box would |
| `menus()` | the open menus, each a list of item labels without `&`, `-` for separators |
| `run(command)`, `open(path)` | what Start > Run does; opens a folder window or the file's program |
| `saver(path)`, `stopSaver()` | a screen saver full screen, and its end |
| `fs` | the file system (`readText`, `writeFile`, `readdir`, `stat`, ...; fs.js) |
| `cd.images()`, `cd.insert(name)`, `cd.eject()`, `cd.disc` | the CD images D: can take, putting one in (AutoRun then runs as Explorer runs it), taking it out, the disc in it. `?cd=<name>` picks one at start; the audio CD stays in E:. Inside Windows, Start > Programs > Accessories > System Tools > Insert CD Image puts one in (the app's File > Insert CD Image; in a browser, an .iso file on this computer), and the drive's Eject takes it out (the app's Eject CD) |
| `pc.text()`, `pc.type(keys)`, `pc.reset()`, `pc.inWindows`, `pc.failed` | the PC under Windows: its 80x25 text screen as lines, keys at its keyboard (`{Enter}`, `{F8}`), a power cycle, whether Windows has the screen, why it stopped |
| `screen()` | `{ width, height, taskbar, screen }`: the size, the taskbar's top row, and what the `screen` event carries now |
| `screenshot()`, `state` | a PNG data URL; menus, modals, pointer capture, the active window |

### Events

`on(type, fn)` calls `fn(event)` for each event of a type (a name, its family such as `'window'`, or `'*'`) and
returns the function that stops it. `next(type, test?, ms)` is a promise for the next one that passes `test`; it
rejects at once with what failed when the system fails meanwhile, else after `ms`. An action's `outcome` already
carries every event, so `next` is for an event no action of yours causes (a program finishing on its own).

| Event | Fields | When |
| --- | --- | --- |
| `window.open`, `window.close` | window fields; `title` | a window or dialog appears; goes away |
| `window.activate`, `window.title`, `window.minimize`, `window.maximize`, `window.restore` | window fields (`was` for a title) | |
| `menu.open`, `menu.close` | `menus` | a menu opens or the open menus change; the last one closes |
| `program.exit` | `path`, `mode`, `code`, `why` if it failed | a guest program ends |
| `screen` | `screen` | boot screens, the desktop, shutdown |
| `system.fail` | `kind` (`console`, `exception`, `rejection`), `text` | the page logs an error (a worker's and the machines' error lines come through it) or has an uncaught exception |
| `braid.fault` | `machine`, `fault` | a machine reports a fault |
| `saver.start`, `saver.stop` | `path` | a full-screen screen saver starts or ends |
| `devtools` | `open` | the browser's DevTools open or close (the app says; a browser tab cannot) |
| `fs.create`, `fs.write`, `fs.unlink`, `fs.mkdir`, `fs.rmdir`, `fs.rename`, `fs.attrib`, `fs.label`, `fs.mount` | `path`, `path2` | the file system changes |
| `tray.follow`, `tray.window`, `sync.input`, `sync.stroke` | | a shared session's follow, and strokes (chapter 6) |

A DevTools client gets every event as JSON by registering the binding `__w95event` (`Runtime.addBinding`); each one
arrives as `Runtime.bindingCalled` with the event in `params.payload`, across page reloads.

## 3. When something goes wrong

An error in an answer names what failed. To see more:

- `win95.log(since)`: the machines' log, `{ n, t, level, tag, text, machine }` a line: what the emulator says of
  itself (`win32`, `ne16`, `vxd`, `spawn`), programs' `OutputDebugString`, KERNEL's `LogError`. The same lines go to
  DevTools' console at their level, and to Debug Monitor in Windows (Programs > Accessories > System Tools).
- `shell_cmd` (`win95.sysApp.cmd(name, args)`, with `?debug=1`): the system's machine itself. Addresses come back as
  symbols: `USER 3:bef (ISWINDOW+12)`, `OLE32+1a2c0 (CoInitialize+40)`, `KERNEL32!GetTickCount`.

Read the console and the fault log before reloading the page: a reload wipes both.

| `cmd` | Answers |
| --- | --- |
| `probe` | every thread (state, program, what it waits on, where it stopped, its stack as symbols), the windows and their tasks, the processes, the modules, who holds the Win16 lock, `stats` |
| `faults` | the fault log, cleared: code with nothing at it, USER's and KERNEL's parameter errors, `LogError`, the exception that ended a program or the system (`ring`, `module`, `cr2`, `regs`, `stack`) |
| `watch`, `[dll, name, n]` | each call of an export (a name, `#ordinal` or `/regexp/`), 16- or 32-bit, with its first `n` arguments, its caller, its thread and its result; `watch` alone reads and clears; `[dll]` ends that module's |
| `trace`, `[threadRe, nameRe]` | the stand-in and thunk calls (the JavaScript imports) of the matching threads with their arguments; `trace` alone reads and clears |
| `call`, `[dll, name, args]`; `callPath` | an export called on a thread of its own, with dword or string arguments; with the last blocks it ran |
| `call16`, `[module, name or ordinal, args]`; `user16` | a 16-bit export called: args `['w', v]`, `['l', v]`, `['buf', n, bytes]`, a buffer answered as bytes |
| `peek`, `[lin, n]`; `memwatch`, `[lin, len]` | memory; a write watch on a range, its hits (`by`: the block that ran) |
| `blocks`, `[pathRe, n]` | the run-time code blocks a program's threads ran, as symbols |
| `watchAt`, `[dll, offsets]` | EAX each time execution comes into a module at those offsets from another |
| `effects` | what the machine did and under which cause (input, remote, boot, host) |
| `lag`, `strokes`, `pace` | input timing; a shared session's strokes; a drag's look-ahead |
| `reload`, `[file]` | a machine script loaded again into the running machine (chapter 5) |

Static tools, with nothing running: `python3 tools/staticmap.py` (the bundle's code an entry reaches, what the
translator cannot take, the VxD services nothing provides: `findings/gapmap.json`), `tools/v86mem.py` (where VxDs
touch the first megabyte directly), `tools/realcheck.py` (each VxD stand-in against Windows 95's own service).
`?memwatch=lo,len` and `?dynat=VXDNAME` start a write watch, or block-by-block run-time code, from the first
instruction. `?scriptlog=1` logs each `win95.*` call and its answer, so the person at the screen sees what a script
does.

### The debugger

`win95.debug` (and the MCP server's `guest_*` and `api_*` tools) debugs the machine's translated code and its Windows
API calls. A place is a hex address, `MODULE+offset` or `DLL!Export`.

| Call | Does |
| --- | --- |
| `modules()`, `run(names)` | the translated modules; running some as JavaScript, so DevTools shows them as `dyn/NAME.js`, one function a block, registers in `R` |
| `breakpoint({ at, when, capture })`, `hits(since)`, `next(id)` | a recording breakpoint at a block, with a condition and a captured value over `R`, `r8/r16/r32`, `n`, `thread`; its hits |
| `stopAt(call)`, `unstop(id)` | a stop at each call of an API, in DevTools' debugger |
| `watch(dll, name, n)`, `calls()`, `unwatch(dll)` | calls of an export traced without stopping |
| `state()`, `source(place)`, `read(place, n)`, `resolve(place)`, `where(addr)` | registers and the stack named; a block's JavaScript; memory; places and names |

The MCP server adds the browser debugger's own (`breakpoint`, `pause`, `resume`, `step`, `paused`, `evaluate`,
`scripts`, `source`, `console`, `screenshot`) and `guest_break`, `api_break`, `guest_state`, `guest_step`,
`guest_memory`, `guest_record`, `guest_hits`, `guest_modules`, `guest_run`.

`node bench/explore.mjs` walks the system by its elements and keys and reports what went wrong on the way, each finding
with a replay `gaps.mjs` runs.

## 4. Going back in time

`win95.braid` keeps the machine's run as a line you can move along. Mark a moment, and you can go back to it: a
lock-up, a blue screen or a fault dialog is left by travelling to the moment before it and trying again, with a
changed script loaded if need be (`reloadScript`). The line marks itself as it runs, so there is a moment to go back
to even when no one marked one, and it is kept on this computer, so a reloaded page starts where it was.

| Call | Does |
| --- | --- |
| `braid.mark(name?)`, `braid.anchor(name?)` | a moment now; one kept on this computer for later pages |
| `braid.travel(name)`, `braid.travel({ t })` | back (or ahead) to a moment; to a time on the machine's clock |
| `braid.moments()`, `braid.forget(name)` | the moments; one let go |
| `braid.every(ms)` | the line marking itself (and anchoring itself less often); `every(0)` ends it |
| `braid.lint(a, b?)` | whether the machine between two moments looks like one that will not come back (`broken`, `suspect`, `ok`); a refused travel to a `broken` one takes `{ force: true }` |
| `braid.setMachineSpeed(x)`, `braid.speed()`, `braid.now()` | the machines run `x` times faster than the wall; the speeds; the machine's clock |
| `braid.memo(actions)` | a span already lived with these actions, travelled past instead of run again |
| `braid.window()`, Run > `braid` | the Braid window: the line as a slider, its moments, Mark, Anchor, Lint |

Its events are `braid.mark`, `braid.travel`, `braid.anchor`, `braid.lint`, `braid.broken`, `braid.fault`. CLAUDE.EXE's
Claude has it as its `Braid` tool.

## 5. Inside Windows

### Claude's tools in Windows

`ccd` (ccd.js) is the Claude desktop app's own tools as Windows has them: `ccd.<server>.<tool>(args)` with the app's
names and parameters, answering what the app would; what the app asks the user is a message box, and the call waits
for its answer. Sessions, groups, cards and settings live in the registry (`HKCU\Software\Claude\Code`); the Claude
window (its desktop icon, or `ccd.open()`) shows them.

| Server | Tools | In Windows |
| --- | --- | --- |
| `turn` | `update_plan`, `wrap_up` | the Claude window's task list and next-step box; its buttons are real buttons |
| `session` | `start_session`, `dismiss_task`, `hand_off_to_session`, `mark_chapter`, `read_widget_context`, `list_start_targets`, `move_to_cloud` | records; a proposal is a message box, or a card under CLAUDE.EXE's conversation; places are drives; no cloud |
| `session_mgmt` | `list_sessions`, `get_session`, `list_events`, `search_session_transcripts`, `archive_session`, `unarchive_session`, `delete_session`, `clear_session`, `stop_session`, `detach_session`, `set_session_*`, `set_remote_control`, `send_message`, `export_transcript`, `get_usage` | the records and transcripts; an export is `C:\My Documents\<title>.TXT` |
| `sidebar` | groups, sections, `move_sessions`, `set_pinned`, `set_unread`, `mark_completed`, `set_view` | the Claude window's sidebar |
| `view` | `show_pane`, `close_pane`, `get_layout`, `set_transcript_view` | `file` is Notepad, `terminal` an MS-DOS Prompt, `plan` the Claude window, `tasks` Close Program |
| `window`, `settings`, `host`, `directory`, `connectors`, `pr` | | the shell's windows; the app's keys; Notepad and folders; the session's folder; the page's hosts; no GitHub |

`ccd.open()`, `ccd.answer(i)`, `ccd.tools()`, `ccd.state()`, `ccd.toolDefs()`, `ccd.context(session)`,
`ccd.callAs(session, name, args)` and `ccd.cardAnswer(task_id, label)` drive it from the page. Its events are
`ccd.<server>.<tool>`, `ccd.code.<Tool>`, `ccd.reply`, `ccd.answer`, `ccd.message`, `ccd.session.start`,
`ccd.session.stop`, `ccd.notify`.

CLAUDE.EXE's Claude also has Claude Code's own tools: `Read`, `Write`, `Edit`, `Glob` and `Grep` on C: and on
`SRC:\`, the project's code as the local server serves it (refused on the deployed site, and for other drives);
`WebFetch`; `Agent`, a background subagent; `Skill` (`C:\WINDOWS\CLAUDE\SKILLS\<name>\SKILL.MD`); `JavaScript`, code in
the page with `win95` in scope; and `Bash`, an MS-DOS command (127 characters) run by `COMMAND.COM /C` in a machine
with no window. Each request begins with `C:\WINDOWS\CLAUDE\CLAUDE.MD`, the `CLAUDE.MD` files down to the session's
folder, the memory index `C:\WINDOWS\CLAUDE\MEMORY\MEMORY.MD`, and the skills.

### Changing the system while it runs

`win95.reloadScript(file)` loads one of the machines' scripts again into the running system (`claude-app.js`,
`shell32.js`, `dbwin.js`, ...): its definitions replace the exports in place, so programs already holding them call
the new code. Of the page's own scripts only `ccd.js` reloads; for any other (`win95.js`, ...) reload the page.

### MS-DOS

The MS-DOS Prompt and MS-DOS programs run in a virtual-8086 machine (v86.js) that boots the CD's own MS-DOS 7, with
Windows' C: and D:. `win95.dos` lists the machines; each has `keys` (scan code << 8 | character), `out`, and its
memory through `m8`/`m16`.

## 6. Shared sessions

In a shared session several people use one Windows: each runs their own machine on the session's disk and registry,
and each program's windows are the session's objects, kept alike on every machine. A person's mouse strokes into a
window (a drag in Paint, a card in Solitaire) are fed into every machine's copy of that window, so several people can
draw in one Paint at once; the windows are the same size everywhere so the strokes land alike. Another person's pointer
is drawn where their stroke has got to.

To draw with the pointer from an SVG: `await import('/tools/sketch.mjs'); await W95Sketch.draw(svgText, { box, ms })`
(paths, lines, shapes, each subpath one stroke). To fuzz a session over real machines, in a tab opened with
`?debug=1&mute=1&session=<name>&user=Ann`: `await import('/tools/convolution/fuzz-tabs.mjs');
await W95FuzzTabs.run({ seed: 1, actions: 10 })`; it opens two more tabs (or frames, `{ frames: true }`), acts on one
while another reloads and a third joins late, compares the machines, and shrinks a failing trace to a replay test.
