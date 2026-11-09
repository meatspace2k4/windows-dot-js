// SESSTRAY.EXE and its library (session-tray.js): the program is in the system's programs with its imports; its
// window takes each other person's icon to the notification area as the program's own Shell_NotifyIconA call (WM_APP+6,
// posted to itself), renames one whose name changed, takes away one who left and frees its icon after; a person's
// menu (their name, Where Is, Follow, a submenu of their windows, the settings owner's line) is tracked from the
// program's code (WM_APP+2), and Where Is, Follow and a chosen window go to the page
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis; globalThis.importScripts = () => {};
window.W95SYSTEM = { programs: {} };
new Function(readFileSync(new URL('../sesstray-exe.js', import.meta.url), 'utf8'))();
const exe = Buffer.from(window.W95SYSTEM.programs['SESSTRAY.EXE'].file, 'base64').toString('latin1');
for (const n of ['SESSTRAY.DLL', 'Start', 'Handle', 'Shell_NotifyIconA', 'TrackPopupMenu', 'GetMessageA']) assert.ok(exe.includes(n), n);

const defs = {};
window.W95Win32 = { def: (dll, name, n, f) => { defs[`${dll}.${name}`] = f; } };
const posted = []; globalThis.postMessage = m => posted.push(m);
new Function(readFileSync(new URL('../session-tray.js', import.meta.url), 'utf8'))();
// a process: memory, and the system's functions by name (each export's address its name)
const mem = new Uint8Array(1 << 16), dv = new DataView(mem.buffer); let top = 0x100;
const calls = [], icons = [];
const api = {
  GetModuleHandleA: () => 0x400000, RegisterClassA: () => 1, CreateWindowExA: () => 0x77, GetDC: () => 5, ReleaseDC: () => 1,
  CreateDIBitmap: () => 0x300, CreateBitmap: () => 0x301, CreateIconIndirect: () => { icons.push(icons.length + 0x900); return icons.at(-1); }, DeleteObject: () => 1,
  PostMessageA: (h, m, wp, lp) => { calls.push(['post', h, m, wp, lp]); return 1; }, DestroyIcon: h => { calls.push(['destroy', h]); return 1; },
  CreatePopupMenu: () => 0x55, AppendMenuA: (m, f, id, s) => { calls.push(['item', f, id, s ? p.readA(s) : null]); return 1; },
  SetForegroundWindow: () => 1, GetCursorPos: () => 1, PostQuitMessage: () => 0, LoadIconA: () => 0x10,
};
const p = {
  u8: mem, alloc(n) { const a = top; top += (n + 15) & ~15; return a; }, free() {},
  w32: (a, v) => dv.setUint32(a, v >>> 0, true), w16: (a, v) => dv.setUint16(a, v, true), r32: a => dv.getUint32(a, true),
  writeA(a, s) { for (let i = 0; i < s.length; i++) mem[a + i] = s.charCodeAt(i); mem[a + s.length] = 0; },
  readA(a) { let s = ''; while (mem[a]) s += String.fromCharCode(mem[a++]); return s; },
  byName: new Map(['USER32', 'GDI32'].map(d => [d, { exports: new Map(Object.keys(api).map(k => [k, k])) }])),
  thunkFor: (dll, n) => n, call: (f, args) => api[f](...args),
};
const people = list => { window.W95TrayPeople = list; };
people([{ client: 'a', user: 'Ann', color: [128, 0, 0] }]);
assert.equal(defs['SESSTRAY.Start'].call(p, 0x401000), 0x77);
const nids = () => calls.filter(c => c[0] === 'post' && c[2] === 0x8006);
// (Ann's icon, then the Braid icon: the session's line, its own uid past any person's)
assert.equal(nids().length, 2); assert.equal(p.r32(nids()[1][4] + 8), 0x7fff); assert.match(p.readA(nids()[1][4] + 24), /^Braid/);
{ const [, h, , op, d] = nids()[0]; assert.equal(h, 0x77); assert.equal(op, 0); assert.equal(p.readA(d + 24), 'Ann'); assert.equal(p.r32(d + 16), 0x8003); assert.equal(p.r32(d + 20), icons[0]); }
const res = p.alloc(4), handle = (m, wp, lp) => defs['SESSTRAY.Handle'].call(p, 0x77, m, wp, lp, res);
// Bob comes, Ann is renamed: one added, one changed
people([{ client: 'a', user: 'Annie' }, { client: 'b', user: 'Bob' }]); calls.length = 0;
assert.equal(handle(0x8005, 0, 0), 1);
assert.deepEqual(nids().map(c => [c[3], p.readA(c[4] + 24)]), [[1, 'Annie'], [0, 'Bob']]);
// Ann leaves: her icon taken away, then freed
people([{ client: 'b', user: 'Bob' }]); calls.length = 0; handle(0x8005, 0, 0);
assert.equal(nids()[0][3], 2); const free = calls.find(c => c[2] === 0x8007);
handle(0x8007, free[3], 0); assert.deepEqual(calls.at(-1), ['destroy', icons[0]]);
// Bob's icon clicked: his menu, tracked by the program; Where Is to the page
calls.length = 0; handle(0x8003, 2, 0x205);
assert.deepEqual(calls.filter(c => c[0] === 'item').map(c => c[3]), ['Bob', null, '&Where Is Bob?', '&Follow Bob', null, 'Settings changes go to the session owner\'s profile']);
assert.ok(calls.some(c => c[0] === 'post' && c[2] === 0x8002 && c[3] === 0x55));
handle(0x111, 1001, 0); assert.deepEqual(posted.at(-1), { t: 'trayWhere', client: 'b' });
// Follow: to the page, checked while followed, chosen again to stop
handle(0x111, 1002, 0); assert.deepEqual(posted.at(-1), { t: 'trayFollow', client: 'b' });
calls.length = 0; handle(0x8003, 2, 0x205);
assert.equal(calls.find(c => c[0] === 'item' && c[3] === '&Follow Bob')[1], 8, 'Follow checked while following');
handle(0x111, 1002, 0); assert.deepEqual(posted.at(-1), { t: 'trayFollow', client: null });
// his windows: a submenu (its & doubled), one chosen to the page
people([{ client: 'b', user: 'Bob', wins: [{ id: 'w@b.x1', title: 'Paint & Co' }] }]); handle(0x8005, 0, 0);
calls.length = 0; handle(0x8003, 2, 0x205);
const items = calls.filter(c => c[0] === 'item');
assert.ok(items.some(c => c[3] === 'Paint && Co' && c[2] === 2000), 'the window\'s item');
assert.ok(items.some(c => c[1] === 0x10 && c[3] === 'Bob\'s &Windows'), 'the popup entry');
handle(0x111, 2000, 0); assert.deepEqual(posted.at(-1), { t: 'trayWindow', id: 'w@b.x1', client: 'b' });
// the Braid icon: Mark Now, Anchor Now, Travel To the line's moments (from the page, newest first), each to the page
// as the session's (trayBraid); no moments, a grayed line saying so
window.W95TrayMoments = []; calls.length = 0; handle(0x8003, 0x7fff, 0x202);
assert.deepEqual(calls.filter(c => c[0] === 'item').map(c => c[3]), ['Braid: the session\'s line', null, '&Mark Now', '&Anchor Now', '(no moments yet)', '&Travel To']);
assert.ok(calls.some(c => c[0] === 'post' && c[2] === 0x8002), 'tracked as a notification-area menu');
handle(0x111, 3001, 0); assert.deepEqual(posted.at(-1), { t: 'trayBraid', op: 'mark' });
handle(0x111, 3002, 0); assert.deepEqual(posted.at(-1), { t: 'trayBraid', op: 'anchor' });
window.W95TrayMoments = [{ name: 'before & after', anchored: true }, { name: 'm1', broken: true }]; calls.length = 0; handle(0x8003, 0x7fff, 0x205);
const bitems = calls.filter(c => c[0] === 'item');
assert.ok(bitems.some(c => c[2] === 3100 && c[3] === 'before && after  (anchored)') && bitems.some(c => c[2] === 3101 && c[3] === 'm1  (broken)'), 'the moments, & doubled');
handle(0x111, 3101, 0); assert.deepEqual(posted.at(-1), { t: 'trayBraid', op: 'travel', name: 'm1' });
assert.equal(handle(0x0f, 0, 0), 0, 'another message: DefWindowProc\'s');
console.log('sesstray: ok');
