// every 16-bit stand-in's return is one the far-call return gives back (ne16.js api16): a word in AX ('w', 'i'), a
// long or far pointer in DX:AX ('l'), none ('v'), or the stand-in's own ('jmp'). MakeProcInstance's 'x' came back as
// nothing (PROGMAN's message hook a stray DX:AX, SetWindowsHook's parameter error 7008), as did lstrcmp's and
// LoadString's 'i'; and the call itself: MakeProcInstance's far pointer in DX:AX, lstrcmp's -1 in AX
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'osclass.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { K16 } = window.W95NE16, P = window.W95Win32.Process.prototype;
for (const [k, [, ret]] of Object.entries(K16)) assert.ok(['w', 'i', 'l', 'v', 'jmp'].includes(ret), `${k}: ${ret}`);

// a far call into a stand-in: its arguments on the 16-bit stack after the return address, its answer in DX:AX
const mem = new Uint8Array(0x20000), dv = new DataView(mem.buffer);
const reg = v => ({ value: v });
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
Object.assign(p, {
  cpu: { ssb: reg(0x1000), esp: reg(0x100), eax: reg(0xdead), edx: reg(0xbeef), cs: reg(0) },
  r16: a => dv.getUint16(a, true), r32: a => dv.getUint32(a, true), w16: (a, v) => dv.setUint16(a, v, true),
  selBase: () => 0, refreshSegs() {}, seg() {}, tick16() {}, lin: a => a, exitCode: null,
  readA(a) { let s = ''; while (mem[a]) s += String.fromCharCode(mem[a++]); return s; },
});
const call = (key, words) => {
  p.th16 = [{ key, def: K16[key] }]; p.cpu.esp.value = 0x100;
  dv.setUint16(0x1100, 0x1234, true); dv.setUint16(0x1102, 0x40, true);   // (the return address)
  words.forEach((w, i) => dv.setUint16(0x1104 + 2 * i, w, true));
  p.api16(window.W95NE16.L.T16);
};
call('KERNEL.#51', [0x1d3f, 0x020c, 0x1cff]);   // MakeProcInstance(1CFF:020C, hInstance): hInstance nearest
assert.equal(p.cpu.eax.value & 0xffff, 0x020c); assert.equal(p.cpu.edx.value & 0xffff, 0x1cff);
'b'.split('').forEach((c, i) => { mem[0x3000 + i] = c.charCodeAt(0); }); 'c'.split('').forEach((c, i) => { mem[0x3010 + i] = c.charCodeAt(0); });
call('KERNEL.#87', [0x3010, 0, 0x3000, 0]);     // lstrcmp("b", "c")
assert.equal(p.cpu.eax.value & 0xffff, 0xffff);
console.log('def16ret: ok');
