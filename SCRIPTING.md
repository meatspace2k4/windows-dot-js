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
| `ccd.toolDefs()` | the tools as the Claude API takes them: every `ccd_<server>__<tool>`, and `files__read_file`, `files__list_directory`, `files__write_file`, `files__edit_file` |
| `ccd.callAs(session, name, args)` | runs a tool by that name for the session, as CLAUDE.EXE's Claude does |
| `ccd.cardAnswer(task_id, label)` | answers a card with its button's label, as CLAUDE.EXE's card buttons do |

The `files__*` tools work on C: only, the system's own disk: a path on another drive, a network drive or a share (a
remote volume, whatever its letter) is refused. Writing and editing follow the session's permission mode: Plan mode
refuses, Ask permissions asks in a message box, the others write.

| Event | Fields | When |
| --- | --- | --- |
| `ccd.<server>.<tool>` | `args`, `result`, `error` | a tool is called |
| `ccd.answer` | `label`, `message`, `session` or `card`, `action` | the user answers a next-step box or a card |
| `ccd.message` | `to`, `from`, `message`, `message_id` | `send_message` reaches a session |
| `ccd.session.start`, `ccd.session.stop` | `session`, `title`, `prompt` | a session starts or is stopped |
| `ccd.notify` | `kind` | a notification (a question, a finished task) |

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
