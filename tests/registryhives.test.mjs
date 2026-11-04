// The registry's files read back and Windows 98 Setup's kept: win32.js regReadHive reads the CREG files regHive
// writes (and Windows 9x's own); win95.js's shutdown writes the registry back only into files that are still the ones
// Windows had, and Windows starting from the PC's boot loads its registry from SYSTEM.DAT and USER.DAT as the VMM does.
// Setup builds Windows 98's registry as files and puts them in place before its restart; Windows 95's shutdown wrote
// its own registry over them, and Windows 98 started on Windows 95's registry: no RunOnce, no CLSIDs, Explorer's fault
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32;
const str = s => ({ type: 1, data: Uint8Array.from([...s].map(c => c.charCodeAt(0)).concat(0)) });

// ---- a round trip: every root a file keeps, strings, numbers, binary, names in their case
W.regLoad([]);
W.regSet('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion', 'ProductName', str('Microsoft Windows 98'));
W.regSet('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce\\Setup', 'Programs on the Start menu', str('C:\\WINDOWS\\grpconv.exe -t'));
W.regSet('hkcr\\CLSID\\{ECD4FC4D-521C-11D0-B792-00A0C90312E1}\\InProcServer32', '', str('BROWSEUI.DLL'));
W.regSet('hkcc\\Display\\Settings', 'Resolution', str('800,600'));
W.regSet('hklm\\System\\CurrentControlSet\\Control', 'Count', 7);
W.regSet('hklm\\System\\CurrentControlSet\\Control', 'Blob', { type: 3, data: Uint8Array.of(1, 2, 3) });
W.regSet('hkcu\\Control Panel\\Desktop', 'Wallpaper', str('C:\\WINDOWS\\Clouds.bmp'));
W.regSet('hku\\.Default\\Keyboard Layout', null, null);
const sys = W.regReadHive(W.regHive('system'), 'system'), usr = W.regReadHive(W.regHive('user'), 'user');
const get = (list, path, name) => { const e = list.find(([p]) => p === path); const v = e && e[1].find(([n]) => n === name); return v && v[1]; };
const text = v => v && v.data ? String.fromCharCode(...v.data).replace(/\0$/, '') : v;
assert.equal(text(get(sys, 'hklm\\software\\microsoft\\windows\\currentversion', 'productname')), 'Microsoft Windows 98');
assert.equal(text(get(sys, 'hklm\\software\\microsoft\\windows\\currentversion\\runonce\\setup', 'programs on the start menu')), 'C:\\WINDOWS\\grpconv.exe -t');
assert.equal(text(get(sys, 'hkcr\\clsid\\{ecd4fc4d-521c-11d0-b792-00a0c90312e1}\\inprocserver32', '')), 'BROWSEUI.DLL', 'classes: hkcr');
assert.equal(text(get(sys, 'hkcc\\display\\settings', 'resolution')), '800,600', 'the current config: hkcc');
assert.equal(get(sys, 'hklm\\system\\currentcontrolset\\control', 'count'), 7);
assert.deepEqual([...get(sys, 'hklm\\system\\currentcontrolset\\control', 'blob').data], [1, 2, 3]);
assert.equal(text(get(usr, 'hkcu\\control panel\\desktop', 'wallpaper')), 'C:\\WINDOWS\\Clouds.bmp', '.default: hkcu');
assert.ok(sys.some(([p, , n]) => p === 'hklm\\software\\microsoft\\windows\\currentversion\\runonce\\setup' && n === 'Setup'), 'a key\'s name in its case');
assert.equal(W.regReadHive(Uint8Array.of(1, 2, 3), 'system'), null, 'not a registry file');

// ---- the shutdown and the start, win95.js's own code over an fs.js disk
const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const piece = (from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i); assert.ok(i > 0 && j > i, from); return src.slice(i, j); };
const code = piece('const HIVES = ', '\n// the PC\'s text screen') ;
const fs = new window.W95FS.FileSystem(); fs.mount('C', { kind: 'fixed', total: 1 << 24 }); fs.mkdir('C:\\WINDOWS', { recursive: true });
const H = new Function('W95Win32', 'fs', 'join', 'WINDIR', 'ATTR', 'diskSystem', 'console', `${code.slice(0, code.indexOf('function pcBoot'))}\nreturn { flushRegistry, loadHives, hiveStamp };`)(
  W, fs, (...a) => a.join('\\'), 'C:\\WINDOWS', { HIDDEN: 2, SYSTEM: 4, READONLY: 1 }, () => 'win95', { info() {}, error(...a) { throw new Error(a.join(' ')); } });
assert.match(src, /emit\('pc\.windows', \{ path \}\);\n\s+loadHives\(\);/, 'Windows starting from the PC\'s boot loads its registry from its files');
// Windows 95's registry, written as it shuts down
W.regLoad([]); W.regSet('hklm\\software\\microsoft\\windows\\currentversion', 'version', str('Windows 95')); W.regSet('hkdd\\perfstats', 'x', 1);
H.flushRegistry();
assert.ok(fs.exists('C:\\WINDOWS\\SYSTEM.DAT') && W.regGet('hkhost\\hives', 'system.dat'), 'written, and its stamp kept');
// Setup puts Windows 98's registry file in place (its own build of it), then Windows 95 shuts down for the restart
const win98 = (() => { const keep = W.regDump(); W.regLoad([]); W.regSet('hklm\\software\\microsoft\\windows\\currentversion', 'version', str('Windows 98')); W.regSet('hkcr\\clsid\\{ecd4fc4d-521c-11d0-b792-00a0c90312e1}\\inprocserver32', '', str('BROWSEUI.DLL')); const h = W.regHive('system'); W.regLoad(keep); return h; })();
fs.setAttrs('C:\\WINDOWS\\SYSTEM.DAT', 0); fs.writeFile('C:\\WINDOWS\\SYSTEM.DAT', win98);
H.flushRegistry();
assert.deepEqual([...fs.readFile('C:\\WINDOWS\\SYSTEM.DAT')], [...win98], 'Setup\'s file left as it is');
// the PC boots, and Windows starts on the registry its file holds
H.loadHives();
assert.equal(text(W.regGet('hklm\\software\\microsoft\\windows\\currentversion', 'version')), 'Windows 98');
assert.equal(text(W.regGet('hkcr\\clsid\\{ecd4fc4d-521c-11d0-b792-00a0c90312e1}\\inprocserver32', '')), 'BROWSEUI.DLL');
assert.equal(W.regGet('hkdd\\perfstats', 'x'), 1, 'a root no file holds kept');
// from then on the file is Windows' own again: its next shutdown writes it
W.regSet('hklm\\software\\microsoft\\windows\\currentversion', 'versionnumber', str('4.10.2222'));
H.flushRegistry();
const again = W.regReadHive(fs.readFile('C:\\WINDOWS\\SYSTEM.DAT'), 'system');
assert.equal(text(get(again, 'hklm\\software\\microsoft\\windows\\currentversion', 'versionnumber')), '4.10.2222');
// and a file the host wrote itself is not read again at the start (the registry is already it)
const before = W.regDump().length; H.loadHives(); assert.equal(W.regDump().length, before);
console.log('registryhives: ok');
