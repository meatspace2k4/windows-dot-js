# Events

Every answer of a `shell_*` tool already carries the events since the last call. Read this file to watch something
long (Setup, a boot) or to wait for an event no action of yours causes.

**A long run:** `node tools/shell-events.mjs [seconds] [file]` under a monitor prints each fault, page failure,
screen, window opened, program ended, and Braid travel or anchor as it comes. Start it before the run; act on each
event as it arrives. Do not sleep or poll the screen meanwhile.

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
| `tray.follow`, `tray.window`, `sync.input`, `sync.stroke` | | a shared session's follow, and strokes (SHARED.md) |

A DevTools client gets every event as JSON by registering the binding `__w95event` (`Runtime.addBinding`); each one
arrives as `Runtime.bindingCalled` with the event in `params.payload`, across page reloads.
