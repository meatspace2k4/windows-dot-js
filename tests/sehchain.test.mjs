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
// a handler that faults itself (its code not there: Paint's and WordPad's MFC run-time faulted in USER, and the
// handler's own fault went to the same handler, and its fault again, until the page's stack ran out: "Maximum call
// stack size exceeded"). As KERNEL32 dispatches an exception raised inside a handler (a nested one), the search starts
// above the frame whose handler is running; past the chain's end it is not handled, and the program gets its dialog
{
  const p = thread(0x8ff80); p.push = function (v) { this.cpu.esp.value -= 4; this.w32(this.cpu.esp.value >>> 0, v); };
  p.w32(0x8ff80, 0x8ffc0); p.w32(0x8ff84, 0x401000);   // the inner frame: its handler faults
  p.w32(0x8ffc0, 0xffffffff); p.w32(0x8ffc4, 0x402000);   // the outer frame: its handler continues the search
  const calls = [];
  p.runAt = function (fn) { calls.push(fn >>> 0); if (calls.length > 20) throw new Error('the handler ran again and again');
    if (fn === 0x401000) return this.raise(14, 0x7b000000, 0x7b000000) === null ? 2 : 0;   // (its fault, raised in it)
    this.cpu.eax.value = 1; return 0; };
  faults(p, 'a fault inside a handler is not handled by that handler again');
  assert.deepEqual(calls.slice(0, 2), [0x401000, 0x402000], 'the inner handler, then the nested fault goes to the outer one only');
  assert.ok(!calls.slice(1).includes(0x401000), 'the faulting handler is not asked about its own fault');
}
console.log('sehchain: ok');
