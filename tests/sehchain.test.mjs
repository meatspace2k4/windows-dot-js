// A fault in 32-bit code whose thread's exception chain leads off its stack (a frame past the end of memory, or one
// outside the stack the TIB gives): KERNEL32 takes the chain as ending there, so nothing handles the fault and the
// program gets the fault dialog for its own fault. The emulator's dispatcher must not read past memory doing that.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, FaultError } = window.W95Win32;

function thread(head) {
  const p = Object.create(Process.prototype);
  p.mem = { buffer: new ArrayBuffer(1 << 20) };
  p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'fsel', 'gsel', 'cf', 'pf', 'zf', 'sf', 'df', 'of']) p.cpu[r] = { value: 0 };
  p.modules = []; p.r0Depth = 0; p.depth = 0;
  const tib = 0x1000, stackLo = 0x80000, stackHi = 0x90000;
  p.cpu.fs.value = tib; p.cpu.esp.value = stackHi - 0x100;
  p.w32(tib, head); p.w32(tib + 4, stackHi); p.w32(tib + 8, stackLo);
  p.runAt = () => { throw new Error('a handler outside the stack was called'); };
  return p;
}
const faults = (p, why) => assert.throws(() => p.raise(14, 0x7a000000, 0x7a000000), e => e instanceof FaultError, why);

faults(thread(0xfffffff0), 'a frame past the end of memory ends the chain');
faults(thread(0x40000), 'a frame below the stack ends the chain');
{ // the chain's first frame on the stack, its next one off the end of memory
  const p = thread(0x8ff00); p.w32(0x8ff00, 0xfffffff0); p.w32(0x8ff04, 0x401000);
  let called = 0; p.runAt = () => { called++; p.cpu.eax.value = 1; return 0; };   // ExceptionContinueSearch
  p.push = function (v) { this.cpu.esp.value -= 4; this.w32(this.cpu.esp.value >>> 0, v); };
  faults(p, 'a handler on the stack is asked, then the chain ends');
  assert.equal(called, 1);
}
console.log('sehchain: ok');
