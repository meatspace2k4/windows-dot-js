# When something goes wrong

An error in an answer names what failed. Read it, the log and the fault log before anything else: a reload wipes
both. Then find the cause with the debugger, stepping through the code that went wrong. Don't reproduce the crash
over and over and patch around it.

`shell_cmd` needs the page opened with `?debug=1`.

- `win95.log(since)`: the machines' log, `{ n, t, level, tag, text, machine }` a line: what the emulator says of
  itself (`win32`, `ne16`, `vxd`, `spawn`), programs' `OutputDebugString`, KERNEL's `LogError`. The same lines go to
  DevTools' console at their level, and to Debug Monitor in Windows (Programs > Accessories > System Tools).
- `shell_cmd` (`win95.sysApp.cmd(name, args)`): the system's machine itself. Addresses come back as symbols:
  `USER 3:bef (ISWINDOW+12)`, `OLE32+1a2c0 (CoInitialize+40)`, `KERNEL32!GetTickCount`.

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
| `reload`, `[file]` | a machine script loaded again into the running machine (inside-windows.md) |

Static tools, with nothing running: `python3 tools/staticmap.py` (the bundle's code an entry reaches, what the
translator cannot take, the VxD services nothing provides: `findings/gapmap.json`), `tools/v86mem.py` (where VxDs
touch the first megabyte directly), `tools/realcheck.py` (each VxD stand-in against Windows 95's own service).
`?memwatch=lo,len` and `?dynat=VXDNAME` start a write watch, or block-by-block run-time code, from the first
instruction. `?scriptlog=1` logs each `win95.*` call and its answer, so the person at the screen sees what a script
does.

## The debugger

`win95.debug` (and the MCP server's `guest_*` and `api_*` tools) debugs the machine's translated code and its Windows
API calls. A place is a hex address, `MODULE+offset` or `DLL!Export`. To understand a fault: go back before it with
Braid (braid.md), set `api_break` or `guest_break` where the failing code starts, and step it with `guest_step`,
reading `guest_state` at each stop.

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
