// A V86 nested execution block's far call (Begin_Nest_V86_Exec, Simulate_Far_Call, Resume_Exec) runs real-mode code
// on the system VM's first megabyte, its segment a paragraph; the words pushed after Simulate_Far_Call lie above the
// call's return frame, where the callee pops them first. VNETBIOS posts an NCB so: Simulate_Push(flags),
// Simulate_Far_Call(a `cli; retf` stub in V86 memory), Simulate_Push(vector seg), Simulate_Push(vector off),
// Resume_Exec: the retf goes to the vector, whose IRET frame is the flags and the return pushed before. Run as
// protected-mode code, the stub's paragraph was taken for a selector of base 0 and the call went to address 0
// (SUWIN's fault as Windows 98 Setup saved its system files, NETBEUI's timer on its thread).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'dyn.js', 'v86.js']) new Function(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, { INTS } = window.W95NE16, V = window.W95V86;

// the services, with the real-mode call recorded: the pushes before the call, the target, the pushes after it
{
  const mem = { buffer: new ArrayBuffer(0x100000) }, p = Object.create(P), dv = new DataView(mem.buffer), C = 0x8000;
  const cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cf']) cpu[r] = { value: 0 };
  const calls = [];
  Object.assign(p, { mem, cpu, vmClient: () => C, r0Out: fn => fn(), tick16() {}, alloc: () => 0x20000, allocSels: () => 0x3fff, rmFarCall(c, seg, off, before, after) { calls.push({ c, seg, off, before, after }); }, vmFarCall() { calls.push('pm'); } });
  p.r32 = a => dv.getUint32(a, true); p.w32 = (a, v) => dv.setUint32(a, v >>> 0, true); p.r16 = a => dv.getUint16(a, true);
  const svc = n => { dv.setUint32(0x10002, 0x00010000 | n, true); return INTS[0x20].call(p, 0x10006); };
  svc(0x82);                                        // Begin_Nest_V86_Exec
  cpu.eax.value = 0x0202; svc(0x4d);                 // Simulate_Push: the flags
  cpu.ecx.value = 0x0700; cpu.edx.value = 0x0000; svc(0x48);   // Simulate_Far_Call 0700:0000
  cpu.eax.value = 0x0710; svc(0x4d); cpu.eax.value = 0x0000; svc(0x4d);   // the vector, pushed after the call
  svc(0x85);                                        // Resume_Exec
  assert.deepEqual(calls, [{ c: C, seg: 0x700, off: 0, before: [['w', 0x202]], after: [['w', 0x710], ['w', 0]] }], 'a real-mode call with the pushes in their places');
  assert.deepEqual([p.nest[0].target, p.nest[0].pushes, p.nest[0].after], [null, [], []], 'the block ready for the next call');
  // a protected-mode block's call goes as before, every push below the return
  svc(0x86); svc(0x83); cpu.eax.value = 1; svc(0x4d); cpu.ecx.value = 0x1234; cpu.edx.value = 0x10; svc(0x48); cpu.eax.value = 2; svc(0x4d); svc(0x85);
  assert.equal(calls[1], 'pm');
}

// the real-mode run itself, on a V86 machine whose first megabyte is at linear 0 (as the system VM's is): the stub's
// retf takes the vector pushed after the call, the vector's IRET the flags and return pushed before it
{
  const m = V.machine({}); m.v86 = 0;   // (the machine's own addresses are linear ones, as reflected real-mode code's are)
  let top = 0x30000; Object.assign(m, { dosTop: 0x20000, alloc: n => { const a = top; top += (n + 15) & ~15; return a; } });
  m.u8.set([0xfa, 0xcb], 0x7000);                       // 0700:0000  cli; retf
  m.u8.set([0xfe, 0x06, 0x00, 0x06, 0xcf], 0x7100);     // 0710:0000  inc byte [0600h]; iret
  const C = 0x9000; const dv = new DataView(m.mem.buffer);
  dv.setUint32(C + 0x1c, 0x1234, true); dv.setUint32(C + 0x10, 0x5678, true); dv.setUint32(C + 0x2c, 0x0202, true);   // Client_EAX, Client_EBX, Client_EFlags
  P.rmFarCall.call(m, C, 0x700, 0, [['w', 0x0202]], [['w', 0x0710], ['w', 0x0000]]);
  assert.equal(m.u8[0x600], 1, 'the vector ran once');
  assert.equal(dv.getUint32(C + 0x1c, true), 0x1234, 'the registers back in the client'); assert.equal(dv.getUint32(C + 0x10, true), 0x5678);
  assert.ok(!m.rmode, 'the translator back out of real mode'); assert.equal(m.v86, 0);
}

// VNETBIOS's post as it is: the INT 5Ch vector read from the table in memory at 170h (not asked of the VMM), its own
// IRET set there at its init (Set_V86_Int_Vector, as the vector was 0), the far call through it. The table at linear
// 0 is the system VM's (ne16.js rmIvtInit): INT 21h's entry a stub that enters the host, INT 5Ch's 0 as DOS leaves
// it. Without the table in memory the vector read was 0000:0000, and the retf ran the zeros of the null page
{
  const m = V.machine({}); m.v86 = 0;
  let top = 0x30000; Object.assign(m, { dosTop: 0x20000, alloc: n => { const a = top; top += (n + 15) & ~15; return a; }, r0Out: fn => fn(), tick16() {} });
  const C = 0x9000; m.vmClient = () => C; const dv = new DataView(m.mem.buffer); dv.setUint32(C + 0x2c, 0x0202, true);
  m.u8.fill(0, 0, 0x400);
  P.rmIvtInit.call(m);
  assert.equal(dv.getUint32(0x170, true), 0, 'INT 5Ch: nothing installed');
  const v21 = dv.getUint32(0x84, true); assert.notEqual(v21, 0, 'INT 21h: the personality\'s');
  assert.deepEqual([...m.u8.subarray((v21 >>> 16) * 16 + (v21 & 0xffff), (v21 >>> 16) * 16 + (v21 & 0xffff) + 4)], [0x0f, 0xff, 0x21, 0xcf], 'its stub enters the host, then IRET');
  const svc = n => { dv.setUint32(0x10002, 0x00010000 | n, true); return INTS[0x20].call(m, 0x10006); };
  // VNETBIOS's init: Get_V86_Int_Vector 5Ch is 0, so an IRET of its own in a V86 data area becomes the vector
  m.cpu.eax.value = 0x5c; svc(0x42); assert.equal(((m.cpu.ecx.value & 0xffff) << 16 | (m.cpu.edx.value & 0xffff)) >>> 0, 0);
  m.u8[0x7200] = 0xcf; m.cpu.eax.value = 0x5c; m.cpu.ecx.value = 0x0720; m.cpu.edx.value = 0; svc(0x43);
  assert.equal(dv.getUint32(0x170, true), 0x07200000, 'the vector in the table in memory, where the post reads it');
  // the post: flags pushed, the `cli; retf` stub called, the vector from [170h] pushed after, resumed
  m.u8.set([0xfa, 0xcb], 0x7000);
  svc(0x82); m.cpu.eax.value = 0x0202; svc(0x4d); m.cpu.ecx.value = 0x0700; m.cpu.edx.value = 0; svc(0x48);
  const vec = dv.getUint32(0x170, true); m.cpu.eax.value = vec >>> 16; svc(0x4d); m.cpu.eax.value = vec & 0xffff; svc(0x4d);
  svc(0x85);
  assert.ok(!m.trapped && !m.rmode, 'the post came back: the IRET took the flags and the return pushed first');
  svc(0x86);
}
console.log('nestv86: ok');
