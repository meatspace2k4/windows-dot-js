// Each translation's JavaScript is made once and kept (dynjs.js keep: IndexedDB, and the app's file userData/dyn/
// NAME-KEY.js through api.mirror), then reused: a memo's module, whose wasm the worker does not hold, runs as the
// JavaScript kept for it (dyn.js neSet: J.has), so guest_break works on it; its source and dump come from the kept text
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../dynjs.js', import.meta.url), 'utf8'))();
const J = self.W95DynJs;
const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 10, 4, 1, 2, 0, 0x0b]);
const tick = () => new Promise(r => setTimeout(r, 0));
let reads = 0;
const m = { name: 'MSSETUP', sha256: '0123456789abcdef0123', meta: { lookup: 1, textLo: 0x1000, textHi: 0x2000, path: 'C:\\ACME\\MSSETUP.DLL' }, netSeed: { wasm: null, blocks: [], made: 77, bytes: wasm.length }, run: () => 0 };
const p = { modules: [m], seedWasm: async x => { reads++; x.netSeed.wasm = wasm; return true; } };
const files = []; J.mirror = (file, text) => files.push({ file, text });
const key = J.keyOf(m);
assert.equal(key, '0123456789abcdef-77', 'a translation\'s key: its file\'s hash and the memo\'s made');
// (the first idle step opens the store; the next keeps the module)
J.keep(p); await tick(); await tick();
assert.equal(J.keep(p), true, 'one module begun');
for (let i = 0; i < 5 && !files.length; i++) await tick();
assert.equal(files.length, 1, 'its JavaScript written once');
assert.equal(files[0].file, `MSSETUP-${key}.js`, 'named for the module and its translation');
assert.match(files[0].text, /sourceURL=dyn\/MSSETUP\.js/);
assert.equal(m.netSeed.wasm, null, 'the wasm read for it let go again, as neSet leaves a memo\'s');
assert.equal(J.keep(p), false, 'kept once: nothing more to make');
// (reused: read back into memory, a module with no wasm in hand runs as it)
assert.equal(J.has(key), false, 'not in memory until read');
const [d] = await J.debug(p, ['dump', ['MSSETUP']]);
assert.equal(d.text, files[0].text, 'the kept text, the same');
assert.equal(J.has(key), true, 'read: a memo\'s module can run as it');
const before = reads;
const run = J.make(null, 'MSSETUP', [], { lookup: { value: 0 } },{ eax: { value: 0 } }, new WebAssembly.Memory({ initial: 1 }), null, key).run;
assert.equal(typeof run, 'function', 'made from the kept text, no wasm');
assert.equal(reads, before, 'its wasm not read again');
console.log('dynjskept: ok');
