// Code translated at run time inside a module built with a device range (recomp.py --mmio, kept in its metadata) sends
// its stores there to the host as the module's own translated code does: TSENG.DRV's text callbacks, which DIBENG
// calls through far pointers the build does not find, write the accelerator's mix data that way.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const run = mmio => {
  const p = Object.create(P), mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 });   // (the layout's pages, as run-time code imports them)
  p.mem = mem;
  Object.defineProperty(p, 'u8', { value: new Uint8Array(mem.buffer) });
  p.cpu = {};
  for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
  p.ne = new Map([['DISPLAY', { meta: { base: 0x200000, size: 0x1000, ...(mmio ? { mmio: [0xb8000, 0x8000] } : {}) } }]]);
  const calls = []; p.trap = (e, c) => calls.push([e >>> 0, c]);
  // mov edi, 0BC000h; mov al, 7; stosb; mov byte [0BFF36h], 1; mov byte [100000h], 2; jmp 300000h
  p.u8.set([0xbf, 0x00, 0xc0, 0x0b, 0x00, 0xb0, 0x07, 0xaa, 0xc6, 0x05, 0x36, 0xff, 0x0b, 0x00, 0x01, 0xc6, 0x05, 0x00, 0x00, 0x10, 0x00, 0x02,
    0xe9, ...new Uint8Array(new Int32Array([0x300000 - (0x200000 + 27)]).buffer)], 0x200000);
  const next = p.dynBlock(0x200000).run() >>> 0;
  assert.equal(next, 0x300000);
  assert.deepEqual([p.u8[0xbc000], p.u8[0xbff36], p.u8[0x100000]], [7, 1, 2], 'the stores are made');
  return calls;
};
assert.deepEqual(run(true), [[0xbc000, 0x2000001], [0xbff36, 0x2000001]], 'the two in the device range go to the host, after they are made');
assert.deepEqual(run(false), [], 'a module without one: none');
console.log('dynmmio: ok');
