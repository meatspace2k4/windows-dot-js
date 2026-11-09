// Windows 98's logon programs on the KERNEL32 stand-ins:
// - a VMM service called by VxDCallN takes its N arguments off the stack, as the VMM's Win32 service dispatcher does:
//   ScanRegW calls service 1Ch with VxDCall1 and leaves the stack to it; left on, its thread returned into its CRT block
// - QueryPerformanceCounter never answers the same count twice: WELCOME times a short loop between two reads and
//   divided by the difference
// - a file opened with FILE_FLAG_DELETE_ON_CLOSE goes with its handle (ADVPACK's TMP4352$.TMP, left in StartUp)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API, LAYOUT } = window.W95Win32, P = Process.prototype, K = API.KERNEL32;

{ // VxDCall1 of a VMM service: the service id and its one argument both gone, the return address kept
  const p = Object.create(P); p.mem = { buffer: new ArrayBuffer(0x10000) };
  const regs = { esp: 0x8000, eax: 0 }; p.reg = (n, v) => { if (v === undefined) return regs[n] >>> 0; regs[n] = v >>> 0; };
  p.w32(0x8000, 0x402437); p.w32(0x8004, 0x1001c); p.w32(0x8008, 0x5342574d);
  const next = K['#2'][1].call(p);
  assert.equal(next, 0x402437, 'back to the caller');
  assert.equal(regs.esp, 0x800c, 'return address, service and its argument popped');
  assert.equal(regs.eax, 0);
  // (a device with no Win32 services: the arguments stay, as Windows' dispatcher leaves them)
  regs.esp = 0x8000; p.w32(0x8004, 0x4420000); p.vxdById = () => null;
  K['#2'][1].call(p); assert.equal(regs.esp, 0x8008); assert.equal(regs.eax, 1);
}

{ // the counter moves between two reads within one millisecond
  const p = Object.create(P); p.mem = { buffer: new ArrayBuffer(0x1000) }; p.progTime = () => 3600000 + 5;
  K.QueryPerformanceCounter[1].call(p, 0x100); const a = p.r32(0x100);
  K.QueryPerformanceCounter[1].call(p, 0x100); const b = p.r32(0x100);
  assert.ok(b > a, 'later read larger');
}

{ // delete on close
  const p = Object.create(P); p.mem = { buffer: new ArrayBuffer(0x1000) }; p.handles = new Map(); p.nextHandle = 0x100;
  p.fs = new window.W95FS.FileSystem(); p.fs.mount('C', { total: 1 << 24, kind: 'fixed' }); p.fs.mkdir('C:\\TEMP');
  const name = 0x200; 'C:\\TEMP\\TMP4352$.TMP'.split('').forEach((c, i) => { p.u8[name + i] = c.charCodeAt(0); });
  const h = K.CreateFileA[1].call(p, name, 0x40000000, 0, 0, 1, 0x4000080);
  assert.ok(p.fs.exists('C:\\TEMP\\TMP4352$.TMP'), 'made');
  K.CloseHandle[1].call(p, h);
  assert.ok(!p.fs.exists('C:\\TEMP\\TMP4352$.TMP'), 'gone with its handle');
}
console.log('vxdcallvmm: ok');
