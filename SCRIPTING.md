# Driving the machine

You work the running Windows as a person at its screen would, through the `devtools` MCP server's tools
(tools/devtools-mcp.mjs; from a shell, `node tools/devtools-mcp.mjs --run '[["shell_report",{}]]'`).
**Every answer is the machine's state; decide the next thing from it.**

1. **One action, then read its answer.** Each `shell_*` call answers with the events since the last call and the
   screen now. Never batch actions whose results you haven't read.
2. **Elements, never pixels.** `shell_click {query: {name, role, window}}`; `shell_type` and `shell_key` with the
   `window` they are for; `shell_set` for a combo box or slider. A dialog's text is in the report: no screenshots.
3. **Act on the active window.** When the answer names another as active, `shell_activate` yours first (Setup's
   full-screen backdrop and its dialogs share one title).
4. **No sleeps, no polling.** What an action opens is in its answer's events or the next call's. For a long run
   (Setup, a boot), run `node tools/shell-events.mjs` under a monitor and act on each event.
5. **A warning, question or fault in the answer is the state now**: deal with it first. An `error` names what failed.
6. **Mark before a risky step, travel back after a failure**: `win95.braid.mark(name)` / `win95.braid.travel(name)`.
7. **A fault's cause is found with the debugger**: travel back before it, `api_break` or `guest_break`, step with
   `guest_step`, read `guest_state`. Not by repeating the crash.
8. **The page runs with `?debug=1`** (the app opens so; a browser page needs it in its address) for `shell_cmd`.

**The app** is where the machine runs: `node tools/app.mjs start [keep|fresh|<C.db>] [build]` builds, starts and waits
for the desktop; `save <file>` sets its disk aside; `eval '<expr>'` runs one expression in its page. The tools reach
it at its remote debugging address, 127.0.0.1:9334; for a Chrome started with `--remote-debugging-port=9222`, set
`BROWSER_DEBUGGER_URL=http://127.0.0.1:9222`.

| Read | When |
| --- | --- |
| [docs/scripting/SCREEN.md](docs/scripting/SCREEN.md) | what a report holds; elements, queries, keys; windows, menus, files, CD; a worked session |
| [docs/scripting/EVENTS.md](docs/scripting/EVENTS.md) | watching a long run; waiting for an event no action causes |
| [docs/scripting/DEBUGGING.md](docs/scripting/DEBUGGING.md) | a fault or an error: the log, `shell_cmd`, the debugger, static tools |
| [docs/scripting/BRAID.md](docs/scripting/BRAID.md) | marking, travelling, anchoring, the machine's speed |
| [docs/scripting/INSIDE-WINDOWS.md](docs/scripting/INSIDE-WINDOWS.md) | Claude's tools in Windows, reloading a script, MS-DOS machines |
| [docs/scripting/SHARED.md](docs/scripting/SHARED.md) | shared sessions, drawing, fuzzing over tabs |
