# Driving the machine

- Drive the running machine only with the `devtools` MCP server's `shell_*` tools (tools/devtools-mcp.mjs, `.mcp.json`).
  Without them loaded: `node tools/devtools-mcp.mjs --run '[["shell_report",{}]]'`, the same tools in one call.
- Read the state with `shell_report` before every action. Never assume a window, a tab, a dialog or a mode.
- Act with `shell_click` (an element query, never coordinates), `shell_key`, `shell_type`, `shell_run`.
- Wait only with `shell_next`, the action that causes the event passed as its `then`. It ends on the event or at once on an error.
- Write no scripts of your own against the page or the worker. No sleeps, no timeouts, no polling loops.
- On an error, read `shell_report` and the `console` tool; the error names the problem.
- The browser is the debug Chrome on port 9222. Open no second tab of the machine.
- SCRIPTING.md is the API. Use what it names before building anything.
