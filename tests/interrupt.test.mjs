// What arrives between two of the guest's instructions runs through P.asInterrupt: on a stack of its own, interrupts
// disabled, with a client register set of its own on the VM's locked stack; the interrupted code's stack, flags and
// client registers come back as they were. Each path that
// skipped this wrote over DIBENG's 4Ah-byte blit stack at the first start (the sound card's interrupt, VTDAPI's timer
// event nesting MMSYSTEM's callback on the interrupted client's SS:SP), and WELCOME's blit ran its count from 0.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype;

const mk = () => {
  const p = Object.create(P), mem = { buffer: new ArrayBuffer(0x100000) };
  const cpu = {}; for (const r of ['ss', 'ssb', 'esp', 'if', 'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'eip', 'cs', 'csb']) cpu[r] = { value: 0 };
  let next = 0x20000;
  Object.assign(p, { mem, cpu, alloc: n => { const a = next; next += (n + 15) & ~15; return a; }, allocSels: () => 0x3fff });
  p.vmcb = 0x9000; p.crs = 0x8000; p.crsLevel = 1; p.crsPool = ['outer pool']; p.w32(p.vmcb + 8, p.crs);
  // interrupted: WELCOME blitting on DIBENG's stack, inside a PM API call (its client registers at 8000h)
  cpu.ss.value = 0x129f; cpu.ssb.value = 0x1e40360; cpu.esp.value = 0x40; cpu.if.value = 1;
  p.w32(0x8000 + 0x34, 0x129f); p.w32(0x8000 + 0x30, 0x40);
  return p;
};

// inside: its own stack, IF clear, its own client registers (CB_Client_Pointer too), and an idle client on the
// locked stack for the VxDs' events
{
  const p = mk(); let seen;
  p.asInterrupt(() => {
    const c = p.vmClientIdle();
    seen = { ss: p.cpu.ss.value, esp: p.cpu.esp.value, ie: p.cpu.if.value, crs: p.crs, cb: p.r32(p.vmcb + 8), level: p.crsLevel, clientSS: p.r16(c + 0x34), clientSP: p.r32(c + 0x30), sameAsOuter: c === 0x8000 };
  });
  assert.equal(seen.ss, 0); assert.ok(seen.esp > 0x20000 && seen.esp < 0x40000, 'the interrupt stack');
  assert.equal(seen.ie, 0, 'interrupts disabled');
  assert.notEqual(seen.crs, 0x8000); assert.equal(seen.cb, seen.crs); assert.equal(seen.level, 0);
  assert.equal(seen.sameAsOuter, false, "not the interrupted client's registers");
  assert.equal(seen.clientSS, 0x3fff, 'Client_SS: the locked stack'); assert.equal(seen.clientSP, 0x3ff0);
  // after: all as it was
  assert.deepEqual([p.cpu.ss.value, p.cpu.ssb.value, p.cpu.esp.value, p.cpu.if.value], [0x129f, 0x1e40360, 0x40, 1]);
  assert.deepEqual([p.crs, p.crsLevel, p.crsPool[0], p.r32(p.vmcb + 8)], [0x8000, 1, 'outer pool', 0x8000]);
  assert.deepEqual([p.r16(0x8000 + 0x34), p.r32(0x8000 + 0x30)], [0x129f, 0x40], "the interrupted client's registers untouched");
  assert.equal(p.inInterrupt, false);
}
// nested (a hardware interrupt inside the poll's code): stays on the interrupt stack where it is
{
  const p = mk(); let inner;
  p.asInterrupt(() => { p.cpu.esp.value -= 0x100; const outer = p.cpu.esp.value; p.asInterrupt(() => { inner = p.cpu.esp.value === outer; }); });
  assert.equal(inner, true);
}
// a VxD event run while a VM call to a VxD is in progress (MSGSRV32's, its client at 8000h on its own stack) gets a
// client of its own on the locked stack, CB_Client_Pointer and the thread's TCB pointing at it; the caller's client,
// its stack and both pointers are as they were after. With the caller's, an event's nested execution wrote under
// MSGSRV32's SS:SP, and its saved DS came back as garbage (exception 0Eh at USER 1:143, a pop ds)
{
  const p = mk(), tcb = 0xa000, seen = [];
  p.cpu.ss.value = 0x1cf7; p.w32(0x8000 + 0x34, 0x1cf7); p.w32(0x8000 + 0x30, 0x34ac);
  p.r0Thread = () => tcb; p.currentThreadId = () => 94; p.w32(tcb + 0x10, 0x8000);
  p.sysVM = () => p.vmcb; p.depth = 0; p.r0Runs = [];
  p.vxdEvents = [{ fn: 0x18200ba, ref: 0x2000000 }];
  p.vxdCall = function (fn, regs) { seen.push({ fn, ebp: regs.ebp, ss: p.r16(regs.ebp + 0x34), sp: p.r32(regs.ebp + 0x30), cb: p.r32(p.vmcb + 8), tcb: p.r32(tcb + 0x10) }); return {}; };
  p.vxdRunEvents();
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0].ebp, 0x8000, "not the caller's client");
  assert.deepEqual([seen[0].ss, seen[0].sp], [0x3fff, 0x3ff0], 'its client on the locked stack');
  assert.equal(seen[0].cb, seen[0].ebp); assert.equal(seen[0].tcb, seen[0].ebp);
  assert.deepEqual([p.r16(0x8000 + 0x34), p.r32(0x8000 + 0x30), p.r32(p.vmcb + 8), p.r32(tcb + 0x10), p.crs, p.crsLevel], [0x1cf7, 0x34ac, 0x8000, 0x8000, 0x8000, 1]);
}
console.log('interrupt: ok');
