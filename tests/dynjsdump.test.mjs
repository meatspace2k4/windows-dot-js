// The debugger's dump (dynjs.js D.dump, devtools-mcp guest_save): a translated module's whole JavaScript, as a JS-run
// module has it, named for its file (dyn/NAME.js), the modules asked for by name or '*'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../dynjs.js', import.meta.url), 'utf8'))();
// (a wasm module of one function, () -> (), its body empty: the smallest a translation is)
const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 10, 4, 1, 2, 0, 0x0b]);
const mod = (name, path) => ({ name, meta: { lookup: 1, textLo: 0x1000, textHi: 0x2000, path }, netSeed: { wasm, blocks: [], made: 1 }, run: () => 0 });
const p = { modules: [mod('MSSETUP', 'C:\\ACME\\MSSETUP.DLL'), mod('EXE', 'C:\\ACME\\ACMSETUP.EXE')] };
const all = await self.W95DynJs.debug(p, ['dump', ['*']]);
assert.equal(all.length, 2, 'every translated module');
const [m] = await self.W95DynJs.debug(p, ['dump', ['mssetup.dll']]);
assert.equal(m.name, 'MSSETUP', 'by its name, any case, with or without the extension');
assert.match(m.file, /\.js$/);
assert.match(m.text, /^\(function|F\[0\] = function run\(/m, 'its JavaScript');
assert.ok(m.text.includes(`//# sourceURL=dyn/${m.file}`), 'the same name DevTools shows it under');
assert.match(m.hash, /^[0-9a-f]+$/, 'its text\'s hash');
// (saved before with that hash: not sent again; another hash: sent)
const [again] = await self.W95DynJs.debug(p, ['dump', ['MSSETUP'], { [m.file]: m.hash }]);
assert.equal(again.text, null, 'unchanged: no text'); assert.equal(again.hash, m.hash);
const [changed] = await self.W95DynJs.debug(p, ['dump', ['MSSETUP'], { [m.file]: '0' }]);
assert.equal(changed.text, m.text, 'another hash: the text');
assert.deepEqual(await self.W95DynJs.debug(p, ['dump', ['NOSUCH']]), []);
console.log('dynjsdump: ok');
