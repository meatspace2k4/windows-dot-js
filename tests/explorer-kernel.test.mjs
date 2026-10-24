// what EXPLORER.EXE needs of the personality's KERNEL32 and ADVAPI32: a key's default value (RegQueryValue) for a verb
// key that has none, a process handle that is signalled when the process ends (its RunOnce waits), the process's
// instance (ShellExecute's answer for a DDE server), the daylight-saving check, and the tray clock's time format
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, API = W.API;
const call = (dll, name, self, ...a) => API[dll][name][1].apply(self, a);

// a guest memory and the calls the definitions make on it
function guest() {
  const u8 = new Uint8Array(1 << 16), dv = new DataView(u8.buffer); let top = 0x100;
  const handles = new Map(); let hn = 0x100;
  return {
    u8, r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true), r16: a => dv.getUint16(a, true),
    readA(a, n = 1e9) { let s = ''; for (let i = 0; i < n && u8[a + i]; i++) s += String.fromCharCode(u8[a + i]); return s; },
    writeA(a, s, n = 1e9) { const k = Math.min(s.length, n - 1); for (let i = 0; i < k; i++) u8[a + i] = s.charCodeAt(i); u8[a + k] = 0; return k; },
    str(s) { const a = top; this.writeA(a, s); top += s.length + 1; return a; }, buf(n) { const a = top; top += n; return a; },
    obj: h => handles.get(h), newHandle(o) { handles.set(hn, o); return hn++; }, handles,
  };
}

// RegQueryValue: a key without a default value gives an empty string; a key that is not there, ERROR_FILE_NOT_FOUND
{
  W.regSet('hkcr\\folder\\shell\\open\\command', '', 'C:\\WINDOWS\\Explorer.exe /idlist,%I,%L');
  const g = guest(), buf = g.buf(64), cb = g.buf(4);
  g.w32(cb, 64); assert.equal(call('ADVAPI32', 'RegQueryValueA', g, 0x80000000, g.str('Folder\\shell\\open'), buf, cb), 0);
  assert.equal(g.readA(buf), ''); assert.equal(g.r32(cb), 1);
  assert.equal(call('ADVAPI32', 'RegQueryValueA', g, 0x80000000, g.str('Folder\\shell\\open'), 0, 0), 0);   // (its size only)
  g.w32(cb, 64); assert.equal(call('ADVAPI32', 'RegQueryValueA', g, 0x80000000, g.str('Folder\\shell\\open\\command'), buf, cb), 0);
  assert.equal(g.readA(buf), 'C:\\WINDOWS\\Explorer.exe /idlist,%I,%L');
  assert.equal(call('ADVAPI32', 'RegQueryValueA', g, 0x80000000, g.str('Folder\\shell\\nothere'), buf, cb), 2);
  g.w32(cb, 0); assert.equal(call('ADVAPI32', 'RegQueryValueA', g, 0x80000000, g.str('Folder\\shell\\open'), buf, cb), 234);   // ERROR_MORE_DATA
}

// a process handle: unsignalled while the process runs, signalled once it has ended
{
  const g = guest(); g.procs = new Map([[0x60, { pid: 0x60 }]]); g.thread16 = null;
  g.atThreadTop = () => false; g.now = () => 0; g.mainWait = {};
  const h = g.newHandle({ kind: 'process', pid: 0x60 });
  assert.equal(call('KERNEL32', 'WaitForSingleObject', g, h, 0), 0x102);   // WAIT_TIMEOUT: still running
  g.procs.delete(0x60);
  assert.equal(call('KERNEL32', 'WaitForSingleObject', g, h, 0), 0);       // ended
}

// the daylight-saving check: KERNEL32 never moves the clock (the host's carries the zone)
assert.equal(call('KERNEL32', '#99', guest(), 1), 0);

// GetTimeFormat's flags: the tray clock asks for no seconds
{
  const g = guest(), st = g.buf(16), out = g.buf(64);
  [2026, 10, 0, 18, 15, 7, 9, 0].forEach((v, i) => { g.u8[st + 2 * i] = v & 0xff; g.u8[st + 2 * i + 1] = v >> 8; });
  const t = flags => (call('KERNEL32', 'GetTimeFormatA', g, 0x409, flags, st, 0, out, 64), g.readA(out));
  assert.equal(t(0), '3:07:09 PM'); assert.equal(t(2), '3:07 PM'); assert.equal(t(2 | 4), '3:07'); assert.equal(t(8 | 2), '15:07 PM');
  assert.equal(t(1), '3 PM');
  call('KERNEL32', 'GetDateFormatA', g, 0x409, 2, st, 0, out, 64); assert.equal(g.readA(out), 'Sunday, October 18, 2026');
  call('KERNEL32', 'GetDateFormatA', g, 0x409, 1, st, 0, out, 64); assert.equal(g.readA(out), '10/18/26');
}
// GetProcessDword(pid, GPD_HINSTANCE): the process's instance, ShellExecute's answer when its DDE server took the verb
{
  const g = guest(); g.procs = new Map([[0x6c, { pid: 0x6c, exe: { base: 0x4b0000 } }]]); g.inSystem = () => false;
  g.hinst16 = b => (b === 0x4b0000 ? 0x2cdf : 0);
  assert.equal(call('KERNEL32', '#18', g, 0x6c, -48), 0x2cdf);
  assert.ok(call('KERNEL32', '#18', g, 0x6c, -48) > 32);
  assert.equal(call('KERNEL32', '#18', g, 0x6c, -44), 0x400);
}
// KERNEL's 16-bit waits (USER's MsgWaitForMultipleObjects polls with a 1 ms time-out between looks at its queue):
// a time-out that runs out answers WAIT_TIMEOUT, not another turn forever; INFINITE waits on; a set object answers 0
{
  const K16 = window.W95NE16.K16, YIELD = W.YIELD, w461 = K16['KERNEL.#461'][2], w460 = K16['KERNEL.#460'][2];
  const g = guest(); let now = 1000; g.now = () => now; g.lin = a => a; g.atThreadTop = () => true; g.thread16 = { id: 9 };
  const ev = { kind: 'event', manual: false, set: false }, h = g.newHandle(ev), arr = g.buf(8); g.w32(arr, h);
  assert.equal(w461.call(g, 1, arr, 0, 1), YIELD);            // not yet: the thread gives up its slice
  now += 2; assert.equal(w461.call(g, 1, arr, 0, 1), 0x102);  // its 1 ms ran out
  assert.equal(g.thread16.wake, 0);
  assert.equal(w461.call(g, 1, arr, 0, 0xffffffff), YIELD); now += 1e6; assert.equal(w461.call(g, 1, arr, 0, 0xffffffff), YIELD);
  ev.set = true; assert.equal(w461.call(g, 1, arr, 0, 5), 0); assert.equal(ev.set, false);   // (auto-reset)
  assert.equal(w460.call(g, h, 3), YIELD); now += 3; assert.equal(w460.call(g, h, 3), 0x102);
  ev.set = true; assert.equal(w460.call(g, h, 3), 0);
  assert.equal(w461.call(g, 1, arr, 0, 0), 0x102);             // (no time: a look only)
  // a process handle among them: signalled when the process has ended
  g.procs = new Map([[0x70, {}]]); const hp = g.newHandle({ kind: 'process', pid: 0x70 }); g.w32(arr, hp);
  assert.equal(w461.call(g, 1, arr, 0, 0), 0x102); g.procs.delete(0x70); assert.equal(w461.call(g, 1, arr, 0, 0), 0);
}
// INI files: a section's lines, key=value or not (SETUP.INI's group items), in order, kept when a key is written
{
  const files = new Map(), fsx = { readText: p => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); }, writeFile: (p, d) => files.set(p, typeof d === 'string' ? d : new TextDecoder().decode(d)) };
  files.set('C:\\WINDOWS\\SETUP.INI', '[progman.groups]\r\ngroup4=Accessories\r\n\r\n; a note\r\n[group4]\r\n"Notepad", NOTEPAD.EXE\r\n"Calculator", CALC.EXE,,, calc\r\nx=1\r\n');
  const g = guest(); g.fs = fsx; const buf = g.buf(256), file = g.str('SETUP.INI');
  const n = call('KERNEL32', 'GetPrivateProfileSectionA', g, g.str('group4'), buf, 256, file);
  const got = new TextDecoder().decode(g.u8.slice(buf, buf + n)).split('\0').slice(0, -1);
  assert.deepEqual(got, ['"Notepad", NOTEPAD.EXE', '"Calculator", CALC.EXE,,, calc', 'x=1']); assert.equal(g.u8[buf + n], 0);
  assert.equal(call('KERNEL32', 'GetPrivateProfileSectionA', g, g.str('nothere'), buf, 256, file), 0); assert.equal(g.u8[buf], 0); assert.equal(g.u8[buf + 1], 0);
  assert.equal(call('KERNEL32', 'GetPrivateProfileSectionA', g, g.str('group4'), buf, 12, file), 10);   // (too small: size less 2)
  W.iniSet(fsx, 'SETUP.INI', 'group4', 'x', '2'); W.iniSet(fsx, 'SETUP.INI', 'group4', 'y', '3');
  assert.equal(files.get('C:\\WINDOWS\\SETUP.INI'), '[progman.groups]\r\ngroup4=Accessories\r\n\r\n[group4]\r\n"Notepad", NOTEPAD.EXE\r\n"Calculator", CALC.EXE,,, calc\r\nx=2\r\ny=3\r\n\r\n');
}
console.log('explorer-kernel: ok');
