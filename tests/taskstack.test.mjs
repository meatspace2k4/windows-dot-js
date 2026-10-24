// A Win16 task's 16 -> 32 -> 16 round trip (MSGSRV32's message loop: USER's GetMessage calls into 32-bit code on
// the flat address of the task's stack, which calls back into 16-bit USER, which calls the task's window procedure):
// the callback runs with SS the task's DGROUP, as Windows keeps a Win16 task's stack, not an alias selector of the
// same memory. MSGSRV32's window procedure has no prolog and takes DS from SS; on an alias its globals read as 0
// (its SHELL VxD entry point) and it calls 0000:0000.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32, L = window.W95NE16.L;

function machine() {
  const p = Object.create(Process.prototype);
  p.mem = { buffer: new ArrayBuffer(4 << 20) };
  p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fsb', 'gsb']) p.cpu[r] = { value: 0 };
  p.selUsed = new Uint8Array(0x2000); p.th16 = []; p.depth = 1; p.stackLevel = 0;
  return p;
}
const DG = 0x1cf7, DGB = 0x200000;
{ // a task thread whose flat stack is in its DGROUP: SS is the DGROUP, SP the same memory's offset
  const p = machine(); p.setDesc(DG, DGB, 0xffff);
  p.thread16 = { id: 86, task: { dgroup: DG, dgStack: true } };
  const src = DGB + 0xe000;
  p.enter16from32(0x11a305b2, src, 8, 0, false, () => 0);
  assert.equal(p.cpu.ss.value & 0xffff, DG);
  assert.equal(p.cpu.esp.value & 0xffff, 0xe000 - 4);   // (the far return to the way back)
  const k = p.retRecs.findIndex(r => r); assert.equal(p.retRecs[k].ssel, 0);   // (no alias to give back)
}
{ // a Win32 thread (no task), or a flat stack outside the DGROUP: a stack alias as before
  const p = machine(); p.setDesc(DG, DGB, 0xffff);
  p.thread16 = { id: 90, task: { dgroup: DG, dgStack: true } };
  p.enter16from32(0x11a305b2, 0x300000, 8, 0, false, () => 0);
  assert.notEqual(p.cpu.ss.value & 0xffff, DG);
  const q = machine(); q.thread16 = null;
  q.enter16from32(0x11a305b2, 0x300000, 8, 0, false, () => 0);
  assert.ok((q.cpu.ss.value & 0xffff) >= L.DYN * 8);
}
console.log('taskstack: ok');
