// KERNEL32's fibers (win32.js): ConvertThreadToFiber makes the thread a fiber the TIB names at +10h, CreateFiber one
// with a stack of its own that starts at its procedure with its data as the argument, SwitchToFiber keeps the running
// fiber's place (ESP past the call, the callee-saved registers, the return address, the TIB's SEH chain and stack
// bounds) and goes on with the other's. MSHTML decodes images on them on Windows 98.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../fs.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../win32.js', import.meta.url), 'utf8'))();
const { API } = window.W95Win32, K = API.KERNEL32;
const mem = new DataView(new ArrayBuffer(0x40000)), regs = { esp: 0, ebp: 0, ebx: 0, esi: 0, edi: 0 };
let top = 0x1000;
const p = {
  u8: new Uint8Array(mem.buffer), cpu: { fs: { value: 0x200 } },
  r32: a => mem.getUint32(a, true), w32: (a, v) => mem.setUint32(a, v >>> 0, true),
  alloc(n) { const a = top; top += (n + 15) & ~15; return a; }, free() {},
  reg(n, v) { if (v === undefined) return regs[n] >>> 0; regs[n] = v >>> 0; }, thunkFor: () => 0xdead0000,
};
const tib = 0x200;
p.w32(tib, 0x1111); p.w32(tib + 4, 0x9000); p.w32(tib + 8, 0x8000);
const main = K.ConvertThreadToFiber[1].call(p, 0xaaaa);
assert.equal(p.r32(tib + 0x10), main, 'the TIB names the thread\'s fiber'); assert.equal(p.r32(main), 0xaaaa, 'its data first in the record');
const f = K.CreateFiber[1].call(p, 0, 0x401000, 0xbbbb);
assert.equal(p.r32(f), 0xbbbb);
// the thread, at ESP 8800h with [ESP] the return address and [ESP+4] the fiber, switches to the new fiber
Object.assign(regs, { esp: 0x8800, ebp: 1, ebx: 2, esi: 3, edi: 4 }); p.w32(0x8800, 0x402222); p.w32(0x8804, f);
assert.equal(K.SwitchToFiber[1].call(p), 0x401000, 'goes on at the fiber\'s procedure');
assert.equal(p.r32(tib + 0x10), f); assert.equal(p.r32(tib), 0xffffffff, 'its own SEH chain');
assert.ok(regs.esp >= p.r32(tib + 8) && regs.esp < p.r32(tib + 4), 'on its own stack, the TIB\'s bounds its stack\'s');
assert.equal(p.r32(regs.esp + 4), 0xbbbb, 'its data the procedure\'s argument'); assert.equal(p.r32(regs.esp), 0xdead0000, 'a return ends the thread');
// the fiber switches back: the thread goes on after its call, its registers and TIB as they were
const fsp = regs.esp - 0x40; Object.assign(regs, { esp: fsp, ebp: 9, ebx: 9, esi: 9, edi: 9 }); p.w32(tib, 0x7777); p.w32(fsp, 0x403333); p.w32(fsp + 4, main);
assert.equal(K.SwitchToFiber[1].call(p), 0x402222, 'the thread\'s return address');
assert.deepEqual(regs, { esp: 0x8808, ebp: 1, ebx: 2, esi: 3, edi: 4 }, 'ESP past the call and its argument; EBP, EBX, ESI, EDI as it left them');
assert.equal(p.r32(tib), 0x1111); assert.equal(p.r32(tib + 4), 0x9000); assert.equal(p.r32(tib + 8), 0x8000); assert.equal(p.r32(tib + 0x10), main);
// and to the fiber again: where it left off, with the SEH chain it had
p.w32(0x8808, 0x404444); p.w32(0x880c, f);
assert.equal(K.SwitchToFiber[1].call(p), 0x403333); assert.equal(regs.esp, fsp + 8); assert.equal(p.r32(tib), 0x7777);
assert.equal(K.DeleteFiber[1].call(p, f), 0, 'the running fiber is not deleted from under itself');
console.log('fiber: ok');
