// A VxD the bundle carries is mapped at its base in the arena (vmm.js P.vxd); its record has its size, so an image
// looked for room (win32.js imageRoom: a DLL from its file) is not mapped over it. The record had none, moduleSpans
// passed it over, and Windows 98's MSHTML.DLL (2.25 MB, relocated) went over the VxD at 1200000h: MSGSRV32's next
// call into the VxD ran MSHTML's bytes and jumped to garbage (8D177502, 9A11E919), on every first start.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
// a module with a function `run` and nothing else (the VxD's translation stood in for)
const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 7, 1, 3, 0x72, 0x75, 0x6e, 0, 0, 10, 4, 1, 2, 0, 0x0b);
const b64 = u => Buffer.from(u).toString('base64');
const VXD = 0x01200000, SIZE = 0x30000;
window.W95SYSTEM = { vxds: { 'TESTVXD.VXD': { image: b64(new Uint8Array(SIZE)), wasm: b64(wasm), meta: { name: 'TESTVXD ', id: 0x4242, base: VXD, size: SIZE, textLo: VXD, textHi: VXD + 0x100, lookup: 0x100000, blocks: [], ddb: VXD + 0x10, procs: {} } } } };
const p = Object.create(P);
p.mem = { buffer: new ArrayBuffer(0x2000000) }; p.modules = []; p.imports = {};
Object.defineProperty(p, 'u8', { value: new Uint8Array(p.mem.buffer) });
p.protect = () => {};
const v = p.vxd('TESTVXD.VXD');
assert.ok(v && v.kind === 'vxd');
assert.deepEqual(p.moduleSpans(), [[VXD, VXD + SIZE]], 'the VxD is where it is');
// a relocatable DLL of 2.25 MB preferring 1190000h (MSHTML's place on Windows 98's first start): not over the VxD
const at = p.imageRoom(0x01190000, 0x240000, true);
assert.ok(at && (at + 0x240000 <= VXD || at >= VXD + SIZE), `room at ${at.toString(16)}, clear of the VxD at ${VXD.toString(16)}`);
assert.equal(p.imageRoom(0x01190000, 0x240000, false), 0, 'one that cannot be relocated: no room there');
// a relocated DLL is placed clear of the programs' base 1000000h (35 of Windows 98's programs linked there with no
// relocations: MSVCRT relocated beside MSHTA's image left PSTORES no room), though a program's own image goes there
p.modules.push({ name: 'EXE', base: 0x01000000, size: 0xb000 });                   // MSHTA's image
p.modules.push({ name: 'BIG', base: 0x00620000, size: 0x01000000 - 0x00620000 });   // the arena below it full
const msvcrt = p.imageRoom(0x78000000, 0x40000, true);
assert.ok(msvcrt >= 0x01100000, `MSVCRT clear of the programs' base: ${msvcrt.toString(16)}`);
assert.equal(p.imageRoom(0x01000000, 0x17000, false, true), 0x01000000, 'PSTORES at its base, over MSHTA\'s image in a view of its own');
console.log('vxdroom: ok');
