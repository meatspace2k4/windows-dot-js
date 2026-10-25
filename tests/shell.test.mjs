// the shell is EXPLORER.EXE, as SYSTEM.INI names it: MSGSRV32 starts it in the system's machine (no machine answers
// for it), and while that machine runs the page is its monitor: its whole screen is drawn, the mouse and the keys are
// its everywhere no window of the page's own is, and the page draws no desktop or taskbar of its own
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
for (const f of ['win95.js', 'worker.js']) assert.ok(!/explorer\\\.exe\$\/i\.test\(basename\(path\)\)\)\s*return 0x21/.test(read(f)), `${f} answers for EXPLORER.EXE`);
assert.ok(/\('explorer\.exe', 0x[0-9A-F]+, 0x[0-9A-F]+\)/.test(read('tools/build_system.py')), 'build_system.py does not build EXPLORER.EXE');
assert.ok(!/0x501/.test(read('win95.js')) && !/0x501/.test(read('worker.js')), 'the page posts MSGSRV32 a second shell start');

const w = read('win95.js');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };
const env = { windows: [], sysApp: null, barTop: 450, tbarOntop: true, caps: [], active: null };
const make = new Function('env', `
  const inR = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h, barTop = () => env.barTop;
  let windows, sysApp, tbar, active, nativeApps;
  const menus = [], ren = null, fullSaver = null, screen = 'desktop', modal = () => null;
  const sync = () => { windows = env.windows; sysApp = env.sysApp; tbar = { ontop: env.tbarOntop }; active = env.active; nativeApps = env.caps; };
  ${cut('const onTaskbar =', ';')}
  ${cut('function winAt(x, y) {', '\n')}
  let monitor = false;
  ${cut('const monApp = () =>', ';')}
  ${cut('function nativeAt(x, y) {', '\n}')}
  const nativeFocus = ${cut("() => (!menus.length && !ren", ';')}
  return { winAt: (x, y) => (sync(), winAt(x, y)), monApp: () => (sync(), monApp()), onTaskbar: (x, y) => (sync(), onTaskbar(x, y)),
    nativeAt: (x, y) => (sync(), nativeAt(x, y)), nativeFocus: () => (sync(), nativeFocus()) };`);
const S = make(env);
const sys = { name: 'system', alive: true, cv: {} }, other = { name: 'apart', alive: true, cv: {} };
const desk = { native: true, cls: 'Progman', app: sys, x: 0, y: 0, w: 640, h: 480 };
const note = { native: true, cls: 'Notepad', app: other, x: 100, y: 100, w: 200, h: 150 };
const shellWin = { x: 300, y: 200, w: 100, h: 100, hit: () => 'client' };

// before the system's machine runs: the page's desktop and taskbar, its windows
env.windows = [shellWin];
assert.equal(S.monApp(), null); assert.equal(S.winAt(350, 250), shellWin); assert.equal(S.nativeAt(5, 5), null); assert.equal(S.onTaskbar(5, 460), true);
// the system's machine running: everything not on a page window or another machine's window is its
env.sysApp = sys; env.windows = [note, desk, shellWin];
assert.equal(S.monApp(), sys);
assert.equal(S.winAt(5, 5), null); assert.equal(S.nativeAt(5, 5), sys); assert.equal(S.nativeAt(5, 460), sys);   // (its desktop, its taskbar)
assert.equal(S.winAt(350, 250), shellWin); assert.equal(S.nativeAt(350, 250), null);                            // a page window over it
assert.equal(S.nativeAt(150, 150), other);                                                                         // another machine's window
assert.equal(S.onTaskbar(5, 460), false);
// a machine holding the mouse (a drag) has it anywhere
env.caps = [{ ...other, capture: 1 }]; assert.equal(S.nativeAt(5, 5).name, 'apart'); env.caps = [];
// the keys: to the system's machine unless a page window is active
env.active = null; assert.equal(S.nativeFocus(), sys);
env.active = shellWin; assert.equal(S.nativeFocus(), null);
env.active = desk; assert.equal(S.nativeFocus(), sys);
// a machine not yet showing its screen (no canvas), or ended: the page's own desktop again
env.sysApp = { ...sys, cv: null }; env.active = null; assert.equal(S.monApp(), null);
env.sysApp = { ...sys, alive: false }; env.windows = [shellWin]; assert.equal(S.monApp(), null); assert.equal(S.nativeAt(5, 5), null);   // (its windows gone with it)

// render: the machine's screen first, its windows not again, no page desktop or taskbar; the page's windows over it
const r = 'let monitor = !!monApp(); const resize = () => {};\n' + cut('const sa = monApp();', 'if (!sa && tbar.ontop) drawTaskbar();');
const draws = [], scr = { name: 'system', alive: true, cv: {}, scanToCanvas: () => draws.push('screen') };
const ws = [{ ...desk, app: scr }, note, shellWin].map(x => ({ ...x, draw() { draws.push(x.cls || 'page'); } }));
new Function('monApp', 'drawDesktop', 'drawTaskbar', 'modal', 'windows', 'tbar', r)(
  () => scr, () => draws.push('page desktop'), () => draws.push('page taskbar'), () => null, ws, { ontop: true });
assert.deepEqual(draws, ['screen', 'Notepad', 'page']);
draws.length = 0;
new Function('monApp', 'drawDesktop', 'drawTaskbar', 'modal', 'windows', 'tbar', r)(
  () => null, () => draws.push('page desktop'), () => draws.push('page taskbar'), () => null, [ws[2]], { ontop: true });
assert.deepEqual(draws, ['page desktop', 'page', 'page taskbar']);

// the worker: the mouse to USER whatever the programs are doing (not paced by their reading input), moves the machine
// has not had yet folded into the latest, the screen and cursor sent as often as the machine runs
{
  const wk = read('worker.js'), i = wk.indexOf('  queueMouse(kind, x, y) {'), j = wk.indexOf('\n  }\n', wk.indexOf('  feedMouse() {')) + 4;
  const M = new Function(`return class { constructor() { this.mouseq = []; this.ax = -1; this.ay = -1; this.sw = 640; this.sh = 480; this.got = [];
    this.proc = { depth: 0, mouseEvent16: (...a) => this.got.push(a) }; } ring0() { return false; }\n${wk.slice(i, j)} }`)();
  const m = new M();
  m.queueMouse(1, 0, 0); m.queueMouse(1, 10, 10); m.queueMouse(1, 639, 479);
  assert.equal(m.mouseq.length, 1); assert.deepEqual(m.mouseq[0], [0x8001, 65535, 65535]);
  m.queueMouse(2, 320, 240); m.queueMouse(4, 320, 240); m.queueMouse(1, 0, 0);
  m.feedMouse(); assert.equal(m.mouseq.length, 0);
  assert.deepEqual(m.got.map(g => g[0]), [0x8001, 0x8001, 0x8003, 0x8005, 0x8001]);
  m.proc.depth = 1; m.queueMouse(1, 5, 5); m.feedMouse(); assert.equal(m.mouseq.length, 1);   // (inside a call the host made: later)
  assert.ok(/this\.feedMouse\(\); this\.feedKeys\(\);/.test(wk) && /if \(n\) \{ this\.poll\(\); this\.feedMouse\(\); this\.postScan\(\); \}/.test(wk));
  assert.ok(/post\(\{ t: 'held'[^\n]*this\.postScan\(\);/.test(wk), 'no screen while USER is held');
}
console.log('shell: ok');
