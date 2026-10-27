// a shared session's intents (ne16.js hookIntents): USER's SystemParametersInfo as another module enters it, its
// arguments from the stack (Pascal order), an intent only for a setting kept (SPIF_UPDATEINIFILE) and one of the
// settings it knows; a WIN.INI or SYSTEM.INI line written; none from a thread applying another machine's, none from
// USER's own writes (a setting it keeps), none for another file
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'osclass.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const buf = new ArrayBuffer(0x20000), dv = new DataView(buf), u8 = new Uint8Array(buf);
const p = Object.create(P), got = [];
Object.defineProperty(p, 'u8', { value: u8 });
Object.assign(p, {
  cpu: { ss: { value: 0x10 }, esp: { value: 0x100 } }, selBase: s => ({ 0x10: 0x1000, 0x18: 0x4000 })[s] || 0, selValid: s => s === 0x10 || s === 0x18,
  r16: a => dv.getUint16(a, true), r32: a => dv.getUint32(a, true), lin: sp => p.selBase(sp >>> 16) + (sp & 0xffff),
  readA(a) { let s = ''; while (u8[a]) s += String.fromCharCode(u8[a++]); return s; }, onIntent: i => got.push(i),
});
// (Windows' own start, before this machine's person has done anything: no intents)
P.iniIntent.call(p, 'WIN.INI', 'windows', 'device', null, null); assert.equal(got.length, 0);
p.personActed = true; p.thread16 = { id: 9 };   // (a program's thread: the host's own writes make none)
const call = (action, ui, pv, flags) => { const s = 0x1100; dv.setUint16(s + 4, flags, true); dv.setUint32(s + 6, pv, true); dv.setUint16(s + 10, ui, true); dv.setUint16(s + 12, action, true); P.spiIntent.call(p); };
call(17, 1, 0, 3);                                                    // SPI_SETSCREENSAVEACTIVE, kept and sent
assert.deepEqual(got.at(-1), { key: 'spi:17', kind: 'spi', action: 17, ui: 1, flags: 3 });
'C:\\WINDOWS\\CLOUDS.BMP'.split('').forEach((c, i) => { u8[0x4000 + i] = c.charCodeAt(0); });
call(20, 0, 0x180000, 1);                                             // SPI_SETDESKWALLPAPER: its string
assert.equal(got.at(-1).str, 'C:\\WINDOWS\\CLOUDS.BMP');
dv.setInt16(0x4010, 6, true); dv.setInt16(0x4012, 10, true); dv.setInt16(0x4014, 1, true);
call(4, 0, 0x180010, 1); assert.deepEqual(got.at(-1).ints, [6, 10, 1]);   // SPI_SETMOUSE: three ints
const n = got.length;
call(17, 0, 0, 0);                                                    // not kept: a passing state, no intent
call(16, 0, 0, 1);                                                    // a GET: none
call(47, 0, 0, 1);                                                    // the work area: each machine's own
p.thread16 = { remote: true }; call(17, 1, 0, 3);                     // another machine's, applied here: none
p.thread16 = null; call(17, 1, 0, 3); p.thread16 = { id: 9 };         // the host's own (the display's mode for its page): none
assert.equal(got.length, n);
// settings files
P.iniIntent.call(p, 'C:\\WINDOWS\\SYSTEM.INI', 'boot', 'SCRNSAVE.EXE', 'C:\\WINDOWS\\SYSTEM\\3DTEXT~1.SCR', { name: 'DESKCP16' });
assert.deepEqual(got.at(-1), { key: 'ini:SYSTEM.INI:boot:scrnsave.exe', kind: 'ini', file: 'SYSTEM.INI', app: 'boot', name: 'SCRNSAVE.EXE', value: 'C:\\WINDOWS\\SYSTEM\\3DTEXT~1.SCR' });
const m = got.length;
P.iniIntent.call(p, 'WIN.INI', 'Desktop', 'Wallpaper', 'x', { name: 'USER' });   // USER's own, for a setting it keeps
P.iniIntent.call(p, 'C:\\WINDOWS\\NOTEPAD.INI', 'x', 'y', 'z', null);            // a program's own file
assert.equal(got.length, m);
// the Appearance tab's: USER32's SystemParametersInfoA with a structure (stdcall, flat), its bytes by its cbSize, or
// uiParam for the icon titles' font; SetSysColors, each colour its own; the saver's password value from the registry
{
  const sp = 0x2000; p.cpu.esp.value = sp;
  const s32 = (action, ui, pv, flags) => { dv.setUint32(sp + 4, action, true); dv.setUint32(sp + 8, ui, true); dv.setUint32(sp + 12, pv, true); dv.setUint32(sp + 16, flags, true); P.spiStructIntent.call(p); };
  dv.setUint32(0x3000, 20, true); u8[0x3004] = 7;   // MINIMIZEDMETRICS: cbSize 20
  s32(44, 20, 0x3000, 3);
  assert.equal(got.at(-1).key, 'spi:44'); assert.equal(got.at(-1).bytes.length, 20); assert.equal(got.at(-1).bytes[4], 7);
  s32(34, 60, 0x3100, 1); assert.equal(got.at(-1).bytes.length, 60, 'the icon titles\' LOGFONTA, by uiParam');
  const k = got.length; s32(17, 1, 0, 3); s32(44, 20, 0x3000, 0); assert.equal(got.length, k, 'not a structure\'s, or not kept: none');
  // SetSysColors(2, {COLOR_WINDOW, COLOR_HIGHLIGHT}, {..}): far pointers on the 16-bit stack, the last nearest
  p.cpu.esp.value = 0x100; const s = 0x1100; dv.setUint16(s + 12, 2, true); dv.setUint32(s + 8, 0x180020, true); dv.setUint32(s + 4, 0x180030, true);
  dv.setUint16(0x4020, 5, true); dv.setUint16(0x4022, 13, true); dv.setUint32(0x4030, 0xffffff, true); dv.setUint32(0x4034, 0x800000, true);
  P.colorsIntent.call(p);
  assert.deepEqual(got.slice(-2), [{ key: 'color:5', kind: 'color', index: 5, rgb: 0xffffff }, { key: 'color:13', kind: 'color', index: 13, rgb: 0x800000 }]);
  P.regIntent.call(p, 'hkcu\\control panel\\desktop', 'screensaveusepassword', { type: 1, data: Uint8Array.of(0x31, 0) });
  assert.deepEqual(got.at(-1), { key: 'reg:hkcu\\control panel\\desktop:screensaveusepassword', kind: 'reg', path: 'hkcu\\control panel\\desktop', name: 'screensaveusepassword', type: 1, data: [0x31, 0] });
  const j = got.length; P.regIntent.call(p, 'hkcu\\software\\x', 'y', { type: 1, data: [] }); assert.equal(got.length, j, 'another value: each machine\'s own');
}
console.log('intents: ok');
