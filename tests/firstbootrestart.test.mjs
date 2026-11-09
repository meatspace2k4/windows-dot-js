// Windows 98 Setup's first boot, through its restart:
// - each process has its own top-level exception filter: one for the machine gave the second REGSVR32 to load MSVCRT
//   MSVCRT's own filter as the one before it, and the filter called itself until the stack ran out
// - RegisterServiceProcess marks the process a service (fServiceProcess, 100h, in GetProcessDword's -4), as USER's
//   ExitWindows asks: unmarked, MPREXE was ended with the programs, and the restart waited for good on its event
// - a machine that has ended takes no more messages: its worker's last frames put its windows back on the screen
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, P = Process.prototype;

{ // the filter, per process
  const p = Object.create(P), set = API.KERNEL32.SetUnhandledExceptionFilter[1];
  const A = { pid: 1 }, B = { pid: 2 };
  p.thread16 = { pc: A }; assert.equal(set.call(p, 0x401000), 0, 'the first process had none');
  p.thread16 = { pc: B }; assert.equal(set.call(p, 0x401000), 0, 'nor has the second: not the first one\'s');
  assert.equal(set.call(p, 0x402000) >>> 0, 0x401000, 'its own, set before');
  p.thread16 = { pc: A }; assert.equal(set.call(p, 0) >>> 0, 0x401000, 'the first keeps its own');
}

{ // a service process
  const p = Object.create(P), reg = API.KERNEL32.RegisterServiceProcess[1], gpd = null;
  p.thread16 = { pc: { pid: 0x77 } }; p.procs = new Map(); p.inSystem = () => false; p.hinst16 = () => 0;
  assert.equal(reg.call(p, 0x77, 1), 1);
  const flags = pid => (gpd ? gpd[2].call(p, pid, -4) : p.procDword.get(pid)['-4']) >>> 0;
  assert.equal(flags(0x77) & 0x100, 0x100, 'fServiceProcess set');
  reg.call(p, 0, 0); assert.equal(flags(0x77) & 0x100, 0, 'taken off again (0: the caller\'s own)');
}

{ // a TLS slot is the thread's own, flat or not
  const p = Object.create(P), K = API.KERNEL32;
  p.cpu = { fs: { value: 0 } };
  const i = K.TlsAlloc[1].call(p);
  p.cpu.fs.value = 0x1000; K.TlsSetValue[1].call(p, i, 0x1234);
  p.cpu.fs.value = 0x2000; K.TlsSetValue[1].call(p, i, 0);
  p.thread16 = { id: 9 };   // (the record of the current thread another's: FS still says which thread runs)
  p.cpu.fs.value = 0x1000; assert.equal(K.TlsGetValue[1].call(p, i), 0x1234, 'another thread\'s set leaves this one\'s');
}

{ // a DLL's image in the room an ended process's VirtualAlloc gave back, the top of the address space reached
  const p = Object.create(P); p.mem = { buffer: new ArrayBuffer(0x3000000) }; p.modules = [{ base: 0x400000, size: 0x1c00000 }]; p.standins = [];   // (the arena full)
  p.vmTop = 0x3000000; p.vspare = [{ base: 0x2210000, size: 0x30000 }];
  assert.equal(P.imageRoom.call(p, 0x76120000, 0xc000, true), 0x2210000, 'the spare region');
  assert.deepEqual(p.vspare, [{ base: 0x2220000, size: 0x20000 }], 'its rest kept spare');
  assert.equal(P.imageRoom.call(p, 0x76120000, 0x30000, true), 0, 'none big enough: no room');
  // VirtualAlloc from a larger spare region keeps its rest
  p.vspare = [{ base: 0x2400000, size: 0x400000 }]; p.reg = () => 0x100; p.thread16 = null;
  assert.equal(API.KERNEL32.VirtualAlloc[1].call(p, 0, 0x10000, 0x2000) >>> 0, 0x2400000);
  assert.deepEqual(p.vspare, [{ base: 0x2410000, size: 0x3f0000 }], 'the rest still spare');
}

{ // an ended machine's messages
  const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
  const i = src.indexOf('\n  message(m) {'), j = src.indexOf('switch (m.t)', i);
  const head = src.slice(i, j);
  assert.match(head, /if \(!this\.alive && m\.t === 'frame'\) return;/, 'message() takes no frame from a machine that has ended');
}

{ // a DLL loaded now attaches after the DLLs it imports, one loaded long ago by another process among them
  const p = Object.create(P), order = [];
  const K = { name: 'KERNEL32', deps: [] }, O = { name: 'OLEAUT32', deps: [K] }, M = { name: 'NEW', deps: [K, O] };
  p.inits = [M];
  assert.deepEqual(p.pendingInits().map(m => m.name), ['KERNEL32', 'OLEAUT32', 'NEW']); assert.deepEqual(p.inits, []);
}
console.log('firstbootrestart: ok');
