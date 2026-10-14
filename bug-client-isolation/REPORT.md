# Desktop: plugin `Client` modules run in the host app's document

**Version:** Claude Code 2.1.295 (mod loaded), CLI now 2.1.296; Claude desktop app, Code tab, macOS.

## Expected
Per `claude-code.d.ts` (`ClientModule`, `ClientSurface`, `SvgProps`), a surface
module receives only `surface.elements` (Box/Text/Button/...) and draws a tree;
the hooks environment has "no DOM", and the desktop "never lets the markup reach
the page".

## Actual
On the desktop surface the `Client` module executes in the desktop app's own
renderer document with full web globals:

- `typeof document === 'object'`, `document.body.tagName === 'BODY'`
- `window`, `XMLHttpRequest`, `WebSocket`, `Worker`, `fetch` present
- `new OffscreenCanvas(4,4).getContext('webgl2')` succeeds
- the module can append an element to `document.body`, outside its region
  (repro draws a red banner across the app for 15 s)

## Impact
Any installed plugin with a `Client` module can read and modify the Claude
desktop app's UI outside its pane, so the element-tree sandbox the API
documents is not enforced on desktop.

## Repro
1. Copy `repro-mod/` into a folder loaded with `--plugin-dir`, or into a
   hot-reloaded mods folder.
2. In the desktop app, run `/win95` to open the pane.
3. A red banner appears at the top of the app window, and the pane prints
   `{"document":"object",...,"origin":"...","wroteOutsideRegion":"true"}`.
