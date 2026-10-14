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

## Example

```js
const s = win95.screen()
win95.click(20, s.taskbar + 15)        // Start
win95.menus()[0]                       // ['Programs', 'Documents', ..., 'Shut Down...']
win95.key('esc')
win95.run('notepad C:\\AUTOEXEC.BAT')
win95.type('REM edited by script\n')
win95.key('alt+F4', 'alt+y')           // close, then Yes to saving
```
