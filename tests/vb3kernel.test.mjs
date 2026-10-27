// The KERNEL services Visual Basic 3 programs, their controls and Video for Windows rely on (MSBDEMOS, SOLARDEM):
// GetModuleUsage counting a program's live instances (the chooser polls it for 0 to leave its black screen after a
// video); InitTask making the local heap at the end of the DGROUP as it is then (VB3's startup copied its runtime's data
// to the bottom); global blocks in 32-byte multiples (VB3's sub-heap walks to GlobalSize in even steps); SetHandleCount,
// GetCurrentPDB, AccessResource; LoadLibrary("MMSYSTEM."); INT 3Dh (the x87 emulator's FWAIT); IOCTL 4400h telling a
// file from a device; Yield receiving another task's sent message through UserYield; and a 16 -> 32 thunk's first call
// running its 32-bit half's DllMain, whose ThunkConnect32 gives the call its target table
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT, YIELD } = window.W95Win32, { K16, INTS } = window.W95NE16;
const k = (ord, ...a) => K16[`KERNEL.#${ord}`][2].call(...a);
const proc = () => {
  const p = Object.create(Process.prototype);
  p.mem = { buffer: new ArrayBuffer(LAYOUT.HEAP_END + (1 << 20)) };
  p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fsb', 'gsb', 'cf', 'pf', 'zf', 'sf', 'of', 'df']) p.cpu[r] = { value: 0 };
  Object.assign(p, { selUsed: new Uint8Array(0x2000), th16: [], depth: 0, ne: new Map(), modules: [], byName: new Map(), ghandles: new Map(), lheaps: new Map(),
    heapTop: LAYOUT.HEAP, freeList: new Map(), allocs: new Map(), init16() {}, exitCode: null });
  return p;
};

// GetModuleUsage: a task module's live tasks, 0 once they are done; a library 1; a Win32 program's live processes; no module 0
{
  const p = proc(), m = { name: 'SOLARDEM', hModule: 0x100, hInstance: 0x107, segs: [], taskModule: true }, lib = { name: 'MCI', hModule: 0x200, hInstance: 0x207, segs: [] };
  p.ne.set('SOLARDEM', m); p.ne.set('MCI', lib);
  const t = { task: { mod: m }, state: 'waiting' }; p.threadsById = new Map([[1, t]]);
  assert.equal(k(48, p, 0x107), 1); t.state = 'done'; assert.equal(k(48, p, 0x107), 0, 'its task ended');
  assert.equal(k(48, p, 0x207), 1); assert.equal(k(48, p, 0x777), 0);
  const pc = { exe: { base: 0x400000 }, exitCode: null }; p.procs = new Map([[0x70, pc]]); p.h32of = new Map([[0x300, 0x400000]]);
  assert.equal(k(48, p, 0x301), 1); pc.exitCode = 0; assert.equal(k(48, p, 0x301), 0, 'the process ended');
}
// SetHandleCount: up to 255; GetCurrentPDB: the task's PSP
{
  const p = proc();
  assert.equal(k(199, p, 20), 20); assert.equal(k(199, p, 400), 255);
  p.thread16 = { task: { psp: 0x1237 } }; assert.equal(k(37, p), 0x1237);
}
// GlobalAlloc / GlobalReAlloc: sizes in 32-byte multiples, as GlobalSize then answers
{
  const p = proc(), h = k(15, p, 0x42, 0x2cd);
  assert.equal(k(20, p, h), 0x2e0); k(16, p, h, 0x2f1, 0); assert.equal(k(20, p, h), 0x300);
  assert.equal(p.selLimit(p.gsel(h)), 0x2ff, 'the selector covers the rounded size');
}
// AccessResource: the module's file opened for reading at the resource
{
  const p = proc(), opened = [];
  p.resHandles = [{ m: { path: 'D:\\X\\MCI.VBX' }, r: { off: 0x1234 } }];
  p.dosFiles = new Map(); p.dosOpen = (path, mode) => { opened.push([path, mode]); p.dosFiles.set(9, { fd: 5 }); return 9; };
  p.fs = { seek: (fd, off, how) => opened.push([fd, off, how]) };
  assert.equal(k(64, p, 0x207, 4), 9); assert.deepEqual(opened, [['D:\\X\\MCI.VBX', 'r'], [5, 0x1234, 0]]);
  assert.equal(k(64, p, 0x207, 8), 0xffff, 'no such resource');
}
// LoadLibrary("MMSYSTEM."): the loaded MMSYSTEM
{
  const p = proc(), mm = { name: 'MMSYSTEM', meta: {}, hInstance: 0x1837, segs: [] };
  window.W95SYSTEM = { ne: { MMSYSTEM: { fileName: 'MMSYSTEM.DLL', meta: { name: 'MMSYSTEM' } } } };
  p.ne.set('MMSYSTEM', mm);
  assert.equal(p.loadLibrary16('MMSYSTEM.'), mm); assert.equal(k(95, p, 'MMSYSTEM.'), 0x1837);
  delete window.W95SYSTEM;
}
// INT 3Dh: the emulator's FWAIT, nothing to do with a coprocessor; on to the next instruction
{
  const p = proc(); assert.ok(INTS[0x3d]); assert.equal(p.interrupt(0x3d, 0x123456), 0x123456); assert.equal(p.trapped, undefined);
}
// IOCTL 4400h: a file's handle answers its drive with bit 7 clear (VB3 refuses a name that opens a device), another
// handle a character device
{
  const p = proc(); p.dosFiles = new Map([[9, { fd: 1, path: 'D:\\DEMOS\\MSB\\PICCLIP.VBX' }]]);
  p.cpu.eax.value = 0x4400; p.cpu.ebx.value = 9; p.interrupt(0x21, 0); assert.equal(p.cpu.edx.value & 0xffff, 3);
  p.cpu.eax.value = 0x4400; p.cpu.ebx.value = 1; p.interrupt(0x21, 0); assert.equal(p.cpu.edx.value & 0x80, 0x80);
}
// Yield: a task whose queue has a sent message waiting (wake bits at 4Ah: QS_SENDMESSAGE) yields through USER's
// UserYield (USER.332); otherwise as OldYield
{
  const p = proc(), q = p.allocSels(p.alloc(0x100), 0x100), calls = [];
  p.ne.set('USER', { meta: {}, segs: [] }); p.neExport = (m, o) => (o === 332 ? 0x12340000 : 0); p.user16 = o => calls.push(o);
  p.thread16 = { id: 9, depth: 0, task: {}, queue: q }; p.threadsById = new Map([[9, p.thread16]]);
  p.w16(p.selBase(q) + 0x4a, 0x40); assert.equal(k(29, p), undefined); assert.deepEqual(calls, [332]);
  p.w16(p.selBase(q) + 0x4a, 0); assert.equal(k(29, p), YIELD); assert.deepEqual(calls, [332], 'no sent message: no UserYield');
}
// InitTask: the local heap LocalInit(DS, 0, heap) at the DGROUP's end; the stack's bounds from the caller's SP
{
  const p = proc(), dg = p.allocSels(p.alloc(0x9000), 0x9000), inits = [];
  p.localInit = (...a) => inits.push(a);
  const task = { dgStack: true, dgroup: dg, heap: 0x1000, stack: 0x5000, psp: 0x77, show: 1, hInst: dg };
  p.thread16 = { task }; p.cpu.ssb.value = p.selBase(dg); p.cpu.esp.value = 0x3290; p.retf16 = () => 0;
  k(91, p);
  assert.deepEqual(inits, [[dg, 0, 0x1000]]);
  assert.deepEqual([p.r16(p.selBase(dg) + 0x0c), p.r16(p.selBase(dg) + 0x0e)], [0x3294, 0x3294]);
}
// C16ThkSL01: the first call loads the 32-bit half and runs its DllMain (ThunkConnect32 records module and table)
// before it looks for the target
{
  const p = proc(), td = 0x2000, mod = { meta: { textLo: 0x7d641000, textHi: 0x7d660000 }, exports: new Map([['sl_ThunkData32', 0x7d6550d4]]) };
  const rec = { dll32: 'MSVFW32.DLL', name32: 'sl_ThunkData32' }; p.sl01 = new Map([[td, rec]]);
  const order = []; let entered = 0;
  p.loadDll = n => { order.push('load ' + n); return mod; };
  p.runPendingInits = () => { order.push('DllMain'); Object.assign(rec, { mod, table: 0x3000 }); };
  p.importClosure = () => []; p.attach = () => {}; p.lin = a => a;
  p.w32(0x3000 + 4, 0x7d645425); p.enter32from16 = t => { entered = t; return 1; };
  p.cpu.edx.value = td; p.cpu.ecx.value = 4;
  k(631, p);
  assert.deepEqual(order, ['load MSVFW32', 'DllMain']); assert.equal(entered, 0x7d645425, 'the table ThunkConnect32 gave');
}
console.log('vb3kernel: ok');
