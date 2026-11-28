// A DLL a process imports is its program folder's own copy when another file of that name is the one loaded
// (win32.js loadDll, ownCopy), as each Windows 95 process finds an import in its program's folder first. IE4SETUP.EXE
// (OSR 2.5's first start) loads SYSTEM's ADVPACK.DLL and starts IE4WZD.EXE from the folder holding its own newer one;
// bound to SYSTEM's, IE4WZD's INSENG.DLL called its missing RegInstall and faulted
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const SYS = 'C:\\WINDOWS\\SYSTEM\\ADVPACK.DLL', TMP = 'C:\\WINDOWS\\TEMP\\IXP000.TMP\\ADVPACK.DLL';
const files = { [SYS.toUpperCase()]: new Uint8Array([1, 2, 3]), [TMP.toUpperCase()]: new Uint8Array([4, 5, 6, 7]), ['C:\\WINDOWS\\ADVPACK.DLL']: null };
const p = Object.assign(Object.create(P), {
  fs: { readFile: n => { const f = files[n.toUpperCase()]; if (!f) throw new Error('no file'); return f; } },
  byName: new Map(), dlls: new Map(), modules: [],
  diskDll(name) { for (const d of [...(this.loadDirs || []), 'C:\\WINDOWS\\SYSTEM']) { const path = d + '\\' + name + '.DLL', f = files[path.toUpperCase()]; if (f) { const r = { file: f, module: null, meta: { path } }; this.dlls.set(name, r); return r; } } return null; },
  loadImage(file, module, meta, name) { const rec = { name, meta, file }; this.modules.push(rec); this.byName.set(name, rec); return rec; },
});
const wextract = { pid: 1, path: 'D:\\WIN95\\IE4SETUP.EXE' }, wzd = { pid: 2, path: 'C:\\WINDOWS\\TEMP\\IXP000.TMP\\IE4WZD.EXE' };
p.thread16 = { pc: wextract };
const sys = p.loadDll('ADVPACK');
assert.equal(sys.meta.path, SYS, 'IE4SETUP gets SYSTEM\'s');
p.thread16 = { pc: wzd };
const mine = p.loadDll('ADVPACK');
assert.equal(mine.meta.path, TMP, 'IE4WZD gets its own folder\'s');
assert.equal(p.loadDll('ADVPACK'), mine, 'the same one each time');
p.thread16 = { pc: wextract };
assert.equal(p.loadDll('ADVPACK'), sys, 'every other process keeps the one loaded');
assert.equal(p.byName.get('ADVPACK'), sys);
p.thread16 = { pc: { pid: 3, path: 'C:\\WINDOWS\\EXPLORER.EXE' } };
assert.equal(p.loadDll('ADVPACK'), sys, 'a folder without one: the loaded one');
console.log('ownfolderdll: ok');
