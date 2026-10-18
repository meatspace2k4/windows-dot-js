// a protected-mode API call leaves the calling thread's client registers where VxDs look for them (its TCB's client
// pointer, as CB_Client_Pointer), and gives back what was there once the call is over
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
{
  const mem = new DataView(new ArrayBuffer(0x10000)), p = Object.create(P), tcb = 0x3000, vm = 0x2000;
  let seen;
  Object.assign(p, {
    r32: a => mem.getUint32(a, true), w32: (a, v) => mem.setUint32(a, v >>> 0, true), cpu: {},
    sysVM: () => vm, vmClient: () => 0x4000, alloc: () => 0x5000, currentThreadId: () => 7, r0Thread: () => tcb,
    vxdPmApiOn() { seen = [p.r32(tcb + 0x10), p.r32(vm + 8)]; return 0; },
  });
  p.w32(tcb + 0x10, 0x4000);
  P.vxdPmApi.call(p, {});
  assert.deepEqual(seen, [0x5000, 0x5000]); assert.equal(p.r32(tcb + 0x10), 0x4000); assert.equal(p.r32(vm + 8), 0x4000);
}
console.log('appytime: ok');
// an appy-time call from the appy-time thread (MSGSRV32's) runs at once on it; from any other thread, or before Windows
// is up, it waits for the host's appy time
{
  const p = Object.create(P), ran = [], A = { id: 1 }, B = { id: 2 };
  p.vxdCdecl = (fn, args) => ran.push([fn, ...args]);
  p.user16Ready = true; p.appyThread = A; p.thread16 = B;
  assert.equal(p.appyCall(0x100, 7), false); assert.deepEqual(p.appyQueue, [{ fn: 0x100, ref: 7 }]); assert.deepEqual(ran, []);
  p.thread16 = A; assert.equal(p.appyCall(0x200, 8), true); assert.deepEqual(ran, [[0x200, 8]]); assert.equal(p.appyQueue.length, 1);
  p.user16Ready = false; assert.equal(p.appyCall(0x300, 9), false); assert.equal(p.appyQueue.length, 2);
}
// the system's first task's thread is the appy-time thread
{
  const p = Object.create(P), t = { id: 5, tdb: 0x1234 };
  p.init16 = () => {}; p.threadsById = new Map([[5, t]]);
  const k45 = window.W95NE16.K16['KERNEL.#45'][2]; window.W95NE16.K16['KERNEL.#45'][2] = () => 0x12340100;
  try { assert.equal(p.startTask16('MSGSRV32.EXE'), 0x1234); } finally { window.W95NE16.K16['KERNEL.#45'][2] = k45; }
  assert.equal(p.appyThread, t);
}
console.log('appytime: ok (appy call)');
