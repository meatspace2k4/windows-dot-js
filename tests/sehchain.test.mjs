// A fault in 32-bit code whose thread's exception chain leads off its stack (a frame past the end of memory, or one
// outside the stack the TIB gives): KERNEL32 takes the chain as ending there, so nothing handles the fault and the
// program gets the fault dialog for its own fault. The emulator's dispatcher must not read past memory doing that.
// Each handler is run by the thread itself: raise answers the first handler's address, with the handler's return
// address SEH_CONT on the stack, and the handler's return there (sehStep) answers the next one's, or where the context
// says, or throws the fault when none took it
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, FaultError, sehStep, SEH_CONT } = window.W95Win32;

function thread(head) {
  const p = Object.create(Process.prototype);
  p.mem = { buffer: new ArrayBuffer(1 << 20) };
  p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'fsel', 'gsel', 'cf', 'pf', 'zf', 'sf', 'df', 'of']) p.cpu[r] = { value: 0 };
  p.modules = []; p.r0Depth = 0; p.depth = 0;
  const tib = 0x1000, stackLo = 0x80000, stackHi = 0x90000;
  p.cpu.fs.value = tib; p.cpu.esp.value = stackHi - 0x100;
  p.w32(tib, head); p.w32(tib + 4, stackHi); p.w32(tib + 8, stackLo);
  p.push = function (v) { this.cpu.esp.value -= 4; this.w32(this.cpu.esp.value >>> 0, v); };
  return p;
}
/** the thread running the handlers the dispatch goes to: `handlers` (address -> its code, which answers where to go
 *  on), each address gone to recorded; a return to the dispatcher (SEH_CONT) is sehStep's */
const run = (p, handlers, go, calls = []) => {
  for (let n = 0; go !== null && n < 20; n++) {
    go = go >>> 0;
    if (go === SEH_CONT) { go = sehStep(p); continue; }
    const h = handlers[go]; if (!h) return { at: go, calls };
    calls.push(go); assert.equal(p.r32(p.cpu.esp.value >>> 0) >>> 0, SEH_CONT, 'the handler returns to the dispatcher');
    go = h.call(p);
  }
  return { at: go, calls };
};
const declines = function () { this.cpu.eax.value = 1; this.cpu.esp.value += 4; return SEH_CONT; };   // ExceptionContinueSearch, its ret
const faults = (p, why, handlers = {}) => assert.throws(() => run(p, handlers, p.raise(14, 0x7a000000, 0x7a000000)), e => e instanceof FaultError, why);

faults(thread(0xfffffff0), 'a frame past the end of memory ends the chain');
faults(thread(0x40000), 'a frame below the stack ends the chain');
{ // the chain's first frame on the stack, its next one off the end of memory
  const p = thread(0x8ff00); p.w32(0x8ff00, 0xfffffff0); p.w32(0x8ff04, 0x401000);
  let called = 0;
  faults(p, 'a handler on the stack is asked, then the chain ends', { 0x401000: function () { called++; return declines.call(this); } });
  assert.equal(called, 1);
}
// a handler that faults itself (its code not there: Paint's and WordPad's MFC run-time faulted in USER, and the
// handler's own fault went to the same handler, and its fault again, until the page's stack ran out: "Maximum call
// stack size exceeded"). As KERNEL32 dispatches an exception raised inside a handler (a nested one), the search starts
// above the frame whose handler is running; past the chain's end it is not handled, and the program gets its dialog
{
  const p = thread(0x8ff80);
  p.w32(0x8ff80, 0x8ffc0); p.w32(0x8ff84, 0x401000);   // the inner frame: its handler faults
  p.w32(0x8ffc0, 0xffffffff); p.w32(0x8ffc4, 0x402000);   // the outer frame: its handler continues the search
  const calls = [];
  assert.throws(() => run(p, { 0x401000: function () { return this.raise(14, 0x7b000000, 0x7b000000); }, 0x402000: declines }, p.raise(14, 0x7a000000, 0x7a000000), calls),
    e => e instanceof FaultError, 'a fault inside a handler is not handled by that handler again');
  assert.deepEqual(calls.slice(0, 2), [0x401000, 0x402000], 'the inner handler, then the nested fault goes to the outer one only');
  assert.ok(!calls.slice(1).includes(0x401000), 'the faulting handler is not asked about its own fault');
}
// a handler that continues execution (EAX 0): the thread goes on where the context says, the stack as it says
{
  const p = thread(0x8ff00); p.w32(0x8ff00, 0xffffffff); p.w32(0x8ff04, 0x401000);
  const sp = p.cpu.esp.value;
  const r = run(p, { 0x401000: function () {
    const ctx = this.r32((this.cpu.esp.value >>> 0) + 12); this.w32(ctx + 0xb8, 0x7a000002);   // past the faulting instruction
    this.cpu.eax.value = 0; this.cpu.esp.value += 4; return SEH_CONT; } }, p.raise(6, 0x7a000000));
  assert.equal(r.at >>> 0, 0x7a000002, 'on at the address the handler set in the context');
  assert.equal(p.cpu.esp.value >>> 0, sp, 'the stack as the exception found it');
}
// a handler that takes it (MSVC's __except): it never returns to the dispatcher; the thread runs on as itself
{
  const p = thread(0x8ff00); p.w32(0x8ff00, 0xffffffff); p.w32(0x8ff04, 0x401000);
  const r = run(p, { 0x401000: function () { this.cpu.esp.value = 0x8ff00 - 0x20; return 0x7c000000; } }, p.raise(6, 0x7a000000));
  assert.equal(r.at >>> 0, 0x7c000000, 'the __except block runs as the thread\'s own code, not inside a call the host made');
}
// another thread's dispatch, its handler having taken the exception (its record left higher in memory), is not this
// thread's outer one: this thread's search starts at its own chain's head (QUARTZ's MMX probe in REGSVR32 went unhandled,
// its search begun in another thread's chain)
{
  const p = thread(0x8ff00); p.w32(0x8ff00, 0xffffffff); p.w32(0x8ff04, 0x401000);
  run(p, { 0x401000: function () { this.cpu.esp.value = 0x8ff00 - 0x20; return 0x7c000000; } }, p.raise(6, 0x7a000000));   // thread A's, taken
  const tibB = 0x2000; p.cpu.fs.value = tibB; p.w32(tibB, 0x6ff00); p.w32(tibB + 4, 0x70000); p.w32(tibB + 8, 0x60000);
  p.w32(0x6ff00, 0xffffffff); p.w32(0x6ff04, 0x403000); p.cpu.esp.value = 0x6ff80;
  const r = run(p, { 0x403000: function () { this.cpu.esp.value = 0x6ff00 - 0x20; return 0x7d000000; } }, p.raise(6, 0x7b000000));
  assert.deepEqual(r.calls, [0x403000], 'thread B\'s own handler is asked');
  assert.equal(r.at >>> 0, 0x7d000000);
}
// a handler that took its exception through RtlUnwind ends that dispatch: the thread's next exception, raised deeper
// in the stack, is not taken for one raised inside it (QUARTZ's second MMX probe went unhandled)
{
  const p = thread(0x8ff00); p.w32(0x8ff00, 0xffffffff); p.w32(0x8ff04, 0x401000);
  const { API } = window.W95Win32;
  const takes = function () {   // (_except_handler3: RtlUnwind(frame, ...), then the __except block)
    const frame = this.r32((this.cpu.esp.value >>> 0) + 8), sp = (this.cpu.esp.value >>> 0) - 0x40;
    this.cpu.esp.value = sp; this.w32(sp, 0x7e000000); this.w32(sp + 4, frame); this.w32(sp + 8, 0); this.w32(sp + 12, 0); this.w32(sp + 16, 0);
    API.KERNEL32.RtlUnwind[1].call(this);
    this.cpu.esp.value = 0x8ff00 - 0x20; return 0x7c000000;
  };
  const a = run(p, { 0x401000: takes }, p.raise(6, 0x7a000000));
  assert.equal(a.at >>> 0, 0x7c000000);
  p.cpu.esp.value = 0x8fd00;   // (deeper than the first's record)
  const b = run(p, { 0x401000: takes }, p.raise(6, 0x7a000010));
  assert.deepEqual(b.calls, [0x401000], 'the second probe goes to the thread\'s own handler too');
  assert.equal(b.at >>> 0, 0x7c000000);
}
console.log('sehchain: ok');
