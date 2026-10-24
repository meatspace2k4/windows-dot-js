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
