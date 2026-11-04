// A moment with an MS-DOS VM arrived at in another page: the VM's machine is made anew by its prototype's name
// (v86.js V86Machine, the prototype under a name of its own: as Process's it had Process's methods and none of the
// VM's, and the VM ran nothing), its registers are made anew with their values (braid.js rebind: a global of a
// machine this page had not), and the import gives it its views of the memory it shares with the system's machine
// (u8, dv: not writable, so not in the export) and its own translations (worker.js 'import').
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'v86.js']) new Function(read(f))();
// (1) the VM machine's prototype by name, exported
const M = window.W95V86, m = M.machine({ base: 0x10000, mem: new WebAssembly.Memory({ initial: 64, maximum: 64 }) });
assert.equal(Object.getPrototypeOf(m).constructor.name, 'V86Machine');
assert.equal(M.V86Machine.prototype, Object.getPrototypeOf(m));
assert.equal(typeof m.v86Run, 'function');
assert.ok(m instanceof window.W95Win32.Process, 'still a Process');
// (2) rebind: a global with no live one is made anew with its value; a live one is kept
const B = (() => { new Function(read('braid.js'))(); return window.W95Braid; })();
{
  const live = { a: new WebAssembly.Global({ value: 'i32', mutable: true }, 1) }, ex = B.serialize(B.takeGraph([{ a: new WebAssembly.Global({ value: 'i32', mutable: true }, 7), b: new WebAssembly.Global({ value: 'i32', mutable: true }, 9) }]));
  B.rebind([live], ex);
  assert.equal(live.a.value, 7, 'the live global takes the value'); assert.ok(live.b instanceof WebAssembly.Global, 'made anew'); assert.equal(live.b.value, 9);
}
// (3) the import: the classes by name, the VM's views
const w = read('worker.js'), i = w.indexOf("case 'import': {"), body = w.slice(i, w.indexOf("case 'kick':", i));
assert.match(body, /protos = \{ Machine, Process: W\.Process, \.\.\.\(V86\.V86Machine \? \{ V86Machine: V86\.V86Machine \} : \{\}\), \.\.\.\(V86\.FatView \? \{ FatView: V86\.FatView \} : \{\}\) \}/);
assert.match(body, /for \(const v of p\.vms \|\| \[\]\) \{ const m = v\.m; if \(!m \|\| !m\.mem\) continue; if \(!Object\.getOwnPropertyDescriptor\(m, 'u8'\)\) Object\.defineProperty\(m, 'u8', \{ value: new Uint8Array\(m\.mem\.buffer\) \}\);/);
console.log('arrivevm: ok');
