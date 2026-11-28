# Reading and working the screen

The tools call `window.win95`, the page's API. It is the same in the Electron app (DevTools protocol on
`127.0.0.1:9334`) and in a browser tab. Coordinates are screen pixels of the emulated display, origin top left;
`win95.screen()` gives the size.

## The screen and what went wrong

`await win95.report(n = 3)` is the screen and what went wrong. `await win95.outcome(fn, n)` runs one call (`fn`, or
none) and answers `{ result, error, events, report }`: every event since the last `outcome`, and `report` once the
machines have taken the input. The MCP tools are these two. A report has:

- `screen`: `desktop`, `dos`, `black`, `logow`, `logos` (the boot and shutdown screens).
- `windows`: each window, bottom to top, with `title`, `x`, `y`, `w`, `h`, `active` and `modal`, and `text`: every
  control as its machine has it now (`static: Setup needs to restart...`, `pushbutton: Restart Now`).
- `faults`: the last `n` faults, each with `why`, `program`, `module`, `eip` and `cr2`, and `last`, the fault log's
  last entry (`why`, `at` as a symbol, the first eight stack words).

## Acting on an element

`click`, `dblclick`, `down`, `up` and `drag` take an element (from `elements()`/`find()`) or a query for one
(`{ name, role, window }`, strings or RegExps). The element is looked up as its machine shows it now; a desktop icon or
a folder window's file is selected (`click`) or opened (`dblclick`) by its list view itself; a native button, radio
button or check box is pressed by its own window (the control is told to click itself), and a tab is chosen by its
tab control; only when a person could do so now: the control is enabled, its window is the active one and no dialog
waits over it; otherwise the call rejects, naming the window that is active. Anything else gets the pointer at its
centre. `set(query, value)` (`shell_set`) chooses a native combo box's item by its text, or moves a slider (`'min'`,
`'max'` or a number), the same way. Every answer's `how` says which of these was done. A window that is not the
active one is brought forward first with `activate(title)` (`shell_activate`). The call rejects, saying why, when
nothing matches (naming what the window has), when something covers the point, or at once when the system fails
meanwhile. `waitFor(query, ms)` looks an element up the same way and resolves with it.

Keys: `type(text)` types each character (`\n` is Enter); `key('alt+F4', 'tab', 'enter')` presses named keys with
`ctrl+`, `shift+`, `alt+`, `meta+` (`enter`, `esc`, `tab`, `backspace`, `delete`, `up`, `down`, `left`, `right`,
`home`, `end`, `pageup`, `pagedown`, `space`, `F1`..`F12`, or a character). Dialogs take mnemonics as Windows does:
`key('alt+n')` presses `&No`.

With coordinates, `move(x, y)`, `click(x, y, { button: 'right', double: true })`, `dblclick`, `down`/`up` and
`drag(x1, y1, x2, y2, steps)` act at once and return nothing; `drag` paces each part until the machine has fed the
last to USER and the page has drawn it, as a person's hand does. They are for drawing, not for working controls.

## Windows, menus, programs, files

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
