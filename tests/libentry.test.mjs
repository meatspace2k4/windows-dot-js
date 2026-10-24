// A library whose LibEntry returns 0 is not loaded, as the Win16 loader refuses it: LoadLibrary and LoadModule
// return an error (20), and a later load of it is refused the same way. It was a console line, and its callers were
// handed the module its own initialization had refused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32, { K16 } = window.W95NE16;

window.W95SYSTEM = { ne: { MSOPL: { fileName: 'MSOPL.DRV', meta: { name: 'MSOPL', imports: [] }, file: '', wasm: '', fileBytes: new Uint8Array(0x40), mod: {} } } };
const p = Object.create(Process.prototype);
let entries = 0;
Object.assign(p, { ne: new Map(), modules: [], byName: new Map(), init16() {}, readA: () => 'MSOPL.DRV', findFile16: () => 'C:\\WINDOWS\\SYSTEM\\MSOPL.DRV',
  fs: { readFile: () => new Uint8Array(0x40) },
  loadNE(name, file, mod, meta) { const r = { name, meta, file, hInstance: 0x1237, hModule: 0x1236 }; this.ne.set(name, r); return r; },
  initNE() { entries++; return 0; } });

assert.equal(p.loadLibrary16('MSOPL.DRV'), null, 'its LibEntry refused it: not loaded');
assert.equal(p.loadLibrary16('MSOPL.DRV'), null, 'and refused again, its LibEntry not run twice');
assert.equal(entries, 1);
assert.equal(K16['KERNEL.#95'][2].call(p, 'MSOPL.DRV'), 20, 'LoadLibrary: 20');
assert.equal(K16['KERNEL.#45'][2].call(p, 'MSOPL.DRV', 0), 20, 'LoadModule: 20');

// at boot: a driver Windows cannot start without, or USER, refused stops the boot, naming it; a mouse driver
// refused does not
const boot = (refused, userOk = true) => {
  const b = Object.create(Process.prototype), user = { name: 'USER', inited: false, meta: {} };
  Object.assign(b, { ne: new Map([['USER', user]]), byName: new Map([['USER32', {}]]), displayDriverFile: () => 'SUPERVGA',
    loadLibrary16: m => (m === refused ? null : { name: m }), initNE: () => (userOk ? 1 : 0), neExport: () => 0, userStack() {} });
  return () => b.bootUser16();
};
assert.throws(boot('KEYBOARD'), /KEYBOARD did not load: Windows cannot start/);
assert.throws(boot('SUPERVGA'), /SUPERVGA did not load/);
assert.doesNotThrow(boot('MOUSE'), 'no mouse: Windows starts');
assert.throws(boot(null, false), /USER's LibEntry refused it/);
console.log('libentry: ok');
