// The registry's other names for a key are the same key, as Windows 95 has them: HKLM\SOFTWARE\Classes is
// HKEY_CLASSES_ROOT, HKLM\Config\0001 HKEY_CURRENT_CONFIG, HKEY_USERS\.DEFAULT HKEY_CURRENT_USER. A program's lookup
// under either name finds the key (URLMON's of the Web view's MIME filter under HKLM\SOFTWARE\Classes), and what a
// registry kept under the other name before is given to the key where it has none
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, { API } = W, str = s => ({ type: 1, data: window.W95FS.encode(s + '\0') }), dec = v => v && window.W95FS.decode(v.data).replace(/\0+$/, '');

W.regSet('hkcr\\protocols\\filter\\text/webviewhtml', 'CLSID', str('{733AC4CB-F1A4-11d0-B951-00A0C90312E1}'));
assert.equal(dec(W.regGet('hklm\\software\\classes\\protocols\\filter\\text/webviewhtml', 'clsid')), '{733AC4CB-F1A4-11d0-B951-00A0C90312E1}');
assert.deepEqual(W.regKids('hklm\\software\\classes\\protocols\\filter'), ['text/webviewhtml']);
W.regSet('hklm\\config\\0001\\display\\settings', 'Resolution', str('800,600'));
assert.equal(dec(W.regGet('hkcc\\display\\settings', 'Resolution')), '800,600', 'HKLM\\Config\\0001 is HKEY_CURRENT_CONFIG');
W.regSet('hkcu\\control panel\\desktop', 'Wallpaper', str('x.bmp'));
assert.equal(dec(W.regGet('hku\\.default\\control panel\\desktop', 'Wallpaper')), 'x.bmp');

// a program's RegOpenKeyExA of HKEY_LOCAL_MACHINE\SOFTWARE\Classes\... and RegQueryValueExA
{
  const mem = new Uint8Array(0x10000), handles = new Map(); let next = 0x100;
  const p = { u8: mem, readA: a => { let s = ''; while (mem[a]) s += String.fromCharCode(mem[a++]); return s; }, writeA: (a, s) => { for (let i = 0; i < s.length; i++) mem[a + i] = s.charCodeAt(i); mem[a + s.length] = 0; },
    w32: (a, v) => new DataView(mem.buffer).setUint32(a, v >>> 0, true), r32: a => new DataView(mem.buffer).getUint32(a, true),
    newHandle: o => { handles.set(next, o); return (next += 4) - 4; }, obj: h => handles.get(h) };
  p.writeA(0x1000, 'SOFTWARE\\Classes\\PROTOCOLS\\Filter\\text/webviewhtml'); p.writeA(0x1100, 'CLSID');
  assert.equal(API.ADVAPI32.RegOpenKeyExA[1].call(p, 0x80000002, 0x1000, 0, 0, 0x1200), 0, 'opened under HKLM');
  p.w32(0x1300, 64);
  assert.equal(API.ADVAPI32.RegQueryValueExA[1].call(p, p.r32(0x1200), 0x1100, 0, 0, 0x1400, 0x1300), 0);
  assert.equal(p.readA(0x1400), '{733AC4CB-F1A4-11d0-B951-00A0C90312E1}');
}

// a registry kept under the other name before: its values given to the key where it has none
W.regLoad([['hkcr', [], null], ['hkcr\\clsid', [], null], ['hkcr\\clsid\\{a}', [['', str('kept')]], null], ['hklm', [], null], ['hklm\\software', [], null],
  ['hklm\\software\\classes', [], 'Classes'], ['hklm\\software\\classes\\clsid\\{a}', [['', str('other')], ['x', str('1')]], null],
  ['hklm\\software\\classes\\clsid\\{b}', [['', str('only here')]], null]]);
assert.equal(dec(W.regGet('hkcr\\clsid\\{a}', '')), 'kept', 'the key\'s own value stays');
assert.equal(dec(W.regGet('hkcr\\clsid\\{a}', 'x')), '1');
assert.equal(dec(W.regGet('hkcr\\clsid\\{b}', '')), 'only here');
assert.ok(W.regKids('hklm\\software').includes('classes'), 'the other name still listed under its parent');
console.log('regalias: ok');
