# Going back in time

`win95.braid` keeps the machine's run as a line you can move along. Mark a moment, and you can go back to it: a
lock-up, a blue screen or a fault dialog is left by travelling to the moment before it and trying again, with a
changed script loaded if need be (`reloadScript`). The line marks itself as it runs, so there is a moment to go back
to even when no one marked one, and it is kept on this computer, so a reloaded page starts where it was.

Mark a moment before each step that may fail (each page of a Setup, each reboot) and travel back to it, rather than
starting over from a fresh disk.

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
