// the system's machine follows the page's viewport: once it holds another of the adapter's modes the page asks the
// machine for it, the machine changes mode through USER's ChangeDisplaySettings, and the page's canvases follow
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const cut = (w, a, b, keep = true) => { const i = w.indexOf(a); assert.ok(i >= 0, a); const j = w.indexOf(b, i); return w.slice(i, keep ? j + b.length : j); };

// the machine: the mini-VDD's configuration becomes the mode, a DEVMODE names it to USER (the change made now, as
// QuickRes asks for it), and the screen is read back; nothing while a thread holds USER
{
  const M = new Function(`return class {\n${cut(src('worker.js'), '  setMode(w, h, fields', '\n  }\n')}\n}`)();
  const mem = new DataView(new ArrayBuffer(0x2000)), calls = [], freed = [];
  const p = {
    depth: 0, thread16: null, win16Held: null, host: { width: 1024, height: 768 },
    alloc: () => 0x1000, allocSels: () => 0x77, free: a => freed.push(a), freeSels: s => freed.push(s),
    w16: (a, v) => mem.setUint16(a, v, true), w32: (a, v) => mem.setUint32(a, v >>> 0, true),
    user16: (o, args) => { calls.push([o, args]); return { dxax: 0 }; }, scanout: () => ({ w: 800, h: 600, bpp: 8 }), displaySlot: (w, h) => ({ w, h }),
  };
  const m = new M(); m.proc = p; m.sw = 1024; m.sh = 768;
  assert.deepEqual(m.setMode(800, 600), { r: 0, sw: 800, sh: 600 });
  assert.deepEqual([p.host.width, p.host.height], [800, 600]); assert.deepEqual([m.sw, m.sh], [800, 600]);
  assert.deepEqual(calls, [[620, [['l', 0x770000], ['l', 0x80000000]]]]); assert.deepEqual(freed, [0x77, 0x1000]);
  assert.equal(mem.getUint16(0x1000 + 36, true), 0x7c); assert.equal(mem.getUint32(0x1000 + 40, true), 0x180000);
  assert.deepEqual([104, 108, 112].map(o => mem.getUint32(0x1000 + o, true)), [8, 800, 600]);
  p.win16Held = { who: {} }; assert.equal(m.setMode(640, 480), null);
  p.win16Held = null; p.user16 = () => { throw new Error('trapped'); }; const err = console.error; console.error = () => {};
  try { assert.equal(m.setMode(640, 480).r, -1); } finally { console.error = err; }
}

// the page: the mode the viewport holds, asked for when it differs from the machine's; a busy machine asked again; the
// canvases remade for the size the machine answers with; a mode USER did not take not asked for again
{
  const w = src('win95.js');
  // (at 256 colors, the size the machine is asked for is the viewport's: bootSize; the high-color sizes are below)
  const page = `const NATIVE_MODES = [[1024, 768], [800, 600], [640, 480]];\nconst BOOT_BPP = 8;\n${cut(w, 'const nativeMode = ', '\n')}\n${cut(w, 'function bootSize() {', '\n}\n')}\n${cut(w, 'function syncMode() {', '\n}\n')}\n`
    + `class RemoteApp {\n${cut(w, '  async setMode(w, h) {', '  /** a request to the machine', false)}\n constructor(a) { Object.assign(this, a); } }\n`
    + `return { syncMode, RemoteApp, set: v => { sysApp = v; }, mode: nativeMode };`;
  let resizes = 0;
  const S = new Function('innerWidth', 'innerHeight', 'ZOOM', 'mkc', 'resize', 'setTimeout', `let sysApp = null;\n${page}`);
  const canvas = () => ({ getContext: () => ({ createImageData: (x, y) => ({ data: new Uint8ClampedArray(4 * x * y) }) }) });
  const env = (iw, ih) => S(iw, ih, 1, canvas, () => resizes++, f => f());
  // the mode is the viewport itself 640x480 at the least, 1024 wide and 960 high at most (the driver's megabyte)
  assert.deepEqual(env(1024, 768).mode(), [1024, 768]); assert.deepEqual(env(1003, 777).mode(), [1003, 777]); assert.deepEqual(env(100, 100).mode(), [640, 480]); assert.deepEqual(env(3000, 2000).mode(), [1024, 960]);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(f => setImmediate(f)); };
  // the largest mode the viewport holds, asked for once; a thread holding USER, the machine answers null and makes
  // the change when none does (its 'mode' message), the canvases following then
  const asked = [];
  const e = env(900, 700), a = new e.RemoteApp({ alive: true, sw: 1024, sh: 768, cmd: async (n, args) => { asked.push([n, ...args]); return null; } });
  e.set(a); e.syncMode(); await settle();
  assert.deepEqual(asked, [["mode", 900, 700]]); assert.deepEqual([a.sw, a.sh], [1024, 768]); assert.ok(a.modeBusy && a.modeDone);
  a.modeDone({ r: 0, sw: 900, sh: 700 }); await settle();
  assert.deepEqual(asked, [["mode", 900, 700]]); assert.deepEqual([a.sw, a.sh], [900, 700]); assert.equal(resizes, 1); assert.ok(a.cv && a.img); assert.equal(a.modeBusy, null);
  // a mode the driver did not take is not asked for again
  const e2 = env(700, 500), got = [], b = new e2.RemoteApp({ alive: true, sw: 800, sh: 600, cmd: async (n, args) => { got.push(args); return { r: -2, sw: 800, sh: 600 }; } });
  e2.set(b); e2.syncMode(); await settle(); e2.syncMode(); await settle();
  assert.deepEqual(got, [[700, 500]]); assert.deepEqual(b.modeRefused, [[700, 500]]); assert.deepEqual([b.sw, b.sh], [800, 600]);
}
// above 256 colors the machine boots at the largest of the driver's sizes that fits the viewport and FRAMEBUF.DRV's
// 1 MB (its bank probe stops at 16 banks)
{
  const w = src('win95.js');
  const B = new Function('innerWidth', 'innerHeight', 'ZOOM', `const BOOT_BPP = 16;\n${cut(w, 'const nativeMode = ', '\n')}\n${cut(w, 'function bootSize() {', '\n}\n')}\nreturn bootSize();`);
  assert.deepEqual(B(913, 765, 1), [800, 600]);
  assert.deepEqual(B(1280, 1000, 1), [800, 600], '1024x768 at 16 bits is more than 1 MB');
  assert.deepEqual(B(700, 520, 1), [640, 480]);
}
// the app's window is the monitor: the page asks the host to size the window's content to the system machine's mode
// as the machine starts and whenever its screen size is set; the preload carries the request, the main process sizes
// the window unless it is full screen or maximized
{
  const w = src('win95.js'), pre = src('electron/preload.js'), main = src('electron/main.js');
  assert.ok(/function fitWindow\(w, h\) \{ const s = window\.W95HOST && window\.W95HOST\.screen; if \(s\) s\.fit\(w \* ZOOM, h \* ZOOM\); \}/.test(w));
  assert.equal((w.match(/if \(this\.system\) fitWindow\(/g) || []).length, 2);
  assert.ok(/screen: \{ fit: \(width, height\) => ipcRenderer\.send\('fit-window', width, height\) \}/.test(pre));
  assert.ok(/ipcMain\.on\('fit-window'/.test(main) && /win\.isFullScreen\(\) \|\| win\.isMaximized\(\)/.test(main) && /win\.setContentSize\(Math\.round\(width\), Math\.round\(height\), true\)/.test(main));
}
console.log('viewport: ok');
