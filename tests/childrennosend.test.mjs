// The host reads a window's controls without sending them anything (nativeChildren): a send from the host that the
// receiver did not answer within the host's call was given up, USER freed its record while the receiver's queue held
// it, and the receiver called the emptied record's procedure (W98SETUP: "invalid page fault at 0137:00000000", the page
// reading Explorer's taskbar tabs, whose GetWindowText of W98SETUP's window sent it WM_GETTEXT). What only a message
// tells is asked by a thread of its own (worker.js childrenAsked); each control comes back `unknown` until then
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const p = Object.create(P); p.mem = { buffer: new ArrayBuffer(0x10000) }; p.wbufLin = 0x1000; p.wbufSel = 0x47;
// (a dialog 0x100 holding an edit 0x104, a check box 0x108 and a tab control 0x10c)
const kids = { 0x100: [0x104, 0x108, 0x10c] }, cls = { 0x100: '#32770', 0x104: 'Edit', 0x108: 'Button', 0x10c: 'SysTabControl32' }, called = [];
const put = (at, s) => { for (let i = 0; i < s.length; i++) p.u8[at + i] = s.charCodeAt(i); return s.length; };
p.user16 = function (ord, args) {
  called.push(ord); const a = args ? args.map(x => x[1]) : [];
  const r = v => ({ ax: v & 0xffff, dx: v >>> 16, dxax: v >>> 0 });
  switch (ord) {
    case 58: return r(put(0x1000 + 0x180, cls[a[0]] || ''));                     // GetClassName
    case 262: { if (a[1] === 5) return r((kids[a[0]] || [])[0] || 0); const sib = Object.values(kids).find(l => l.includes(a[0])); return r(sib ? sib[sib.indexOf(a[0]) + 1] || 0 : 0); }   // GW_CHILD, GW_HWNDNEXT
    case 49: case 35: return r(1);                                                // IsWindowVisible, IsWindowEnabled
    case 135: return r(a[0] === 0x108 ? 0x50010003 : 0x50010000);                  // GWL_STYLE (BS_AUTOCHECKBOX)
    case 107: return r(put(0x1000 + 16, 'text'));                                 // DefWindowProc WM_GETTEXT
    default: return r(0);
  }
};
const out = p.nativeChildren(0x100);
assert.deepEqual(out.map(c => c.cls), ['Edit', 'Button', 'SysTabControl32']);
assert.ok(!called.includes(111) && !called.includes(36), 'no SendMessage, no GetWindowText');
assert.ok(out.every(c => c.unknown && c.checked === undefined && c.items === undefined), 'unknown until a thread asks');
assert.equal(out[0].text, 'text', 'USER\'s own copy of the text');
console.log('childrennosend: ok');
