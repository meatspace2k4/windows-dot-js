# Driving the machine

The machine is a running Windows in the app. You work it as a person at its screen would, through the `devtools` MCP
server's tools (tools/devtools-mcp.mjs; from a shell, `node tools/devtools-mcp.mjs --run '[["shell_report",{}]]'`).
**Every answer is the machine's state, and the next thing you do is decided from it.**

## The rules

1. **One action, then read its answer.** Each `shell_*` call answers with the events since the last call and the
   screen now. Read it before the next action. Don't batch actions you haven't seen the result of.
2. **Act on elements, never on pixels.** `shell_click` takes `{ name, role, window }`; `shell_type` and `shell_key`
   take the `window` they are meant for; `shell_set` chooses a combo box item or moves a slider. No coordinates, no
   screenshots to read a dialog: its text is in the report.
3. **The window must be the active one.** When the answer says another window is active, `shell_activate` the one
   you mean (several can share a title: Setup's full-screen backdrop and its dialog), then act.
4. **No sleeping, no polling.** A window an action opens is in that answer's events, or the next call's. For a long
   run (Setup, a boot), watch `node tools/shell-events.mjs` under a monitor and act on each event as it comes.
5. **Something unexpected is the state now.** A warning, a question or a fault in the answer comes first. An
   `error` names what failed: read it.
6. **Mark before a risky step, travel back after a failure.** `win95.braid.mark(name)` before each Setup page or
   reboot; `win95.braid.travel(name)` instead of starting over.
7. **Find a fault's cause with the debugger,** not by repeating the crash: go back before it, set `api_break` or
   `guest_break`, step with `guest_step`, and read `guest_state`.
8. **Open the page with `?debug=1`** when you need `shell_cmd`.

## The app

`node tools/app.mjs start [keep|fresh|<C.db file>] [build]` builds and starts the app (its debugger at
`127.0.0.1:9334`, where the tools find it) and waits for the desktop: `keep` its disk as it is, `fresh` a blank disk,
a file a copy of that disk. `node tools/app.mjs save <file>` sets its disk aside; `node tools/app.mjs eval '<expr>'`
runs one expression in its page. The built-in browser pane, the Chrome extension and computer-use tools are not used
on it.

| To | Use |
| --- | --- |
| see the screen and what went wrong | `shell_report` |
| press, type, run | `shell_click`, `shell_key`, `shell_type`, `shell_run`, `shell_set`, `shell_activate` |
| ask the machine itself | `shell_cmd`, `shell_eval`, `worker_eval` |
| stop where guest code or an API call enters | `api_break`, `guest_break`, `guest_step`, `guest_state` |
| watch a long run | `node tools/shell-events.mjs` under a monitor |
| go back before a fault | `win95.braid.travel` |

## Read more only when you need it

| File | When |
| --- | --- |
| [docs/scripting/screen.md](docs/scripting/screen.md) | what a report holds; elements, queries, keys; the windows, menus, files and CD calls |
| [docs/scripting/events.md](docs/scripting/events.md) | watching a long run; waiting for an event no action causes; the event table |
| [docs/scripting/debugging.md](docs/scripting/debugging.md) | a fault or an error: the log, `shell_cmd`'s commands, the debugger, static tools |
| [docs/scripting/braid.md](docs/scripting/braid.md) | marking, travelling, anchoring, the machine's speed |
| [docs/scripting/inside-windows.md](docs/scripting/inside-windows.md) | Claude's tools in Windows (`ccd`), reloading a script, MS-DOS machines |
| [docs/scripting/shared.md](docs/scripting/shared.md) | shared sessions, drawing, fuzzing over tabs |

A worked session, setting the display to True Color:

1. `shell_run {"command": "control desk.cpl"}`: the events have `window.open Display Properties`.
2. `shell_click {"query": {"name": "Settings ", "window": "Display Properties"}}`: its text now has
   `combobox: High Color (16 bit)`.
3. `shell_set {"query": {"role": "combobox", "window": "Display Properties"}, "value": "True Color (24 bit)"}`.
4. `shell_click {"query": {"name": "Apply", "window": "Display Properties"}}`: the events have `window.open
   Compatibility Warning`. That is the state: answer it, then Monitor Settings' Yes, each from the answer before.
