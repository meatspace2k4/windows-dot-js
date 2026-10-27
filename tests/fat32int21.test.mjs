// MS-DOS 7's FAT32 functions (INT 21h AH=73h, ne16.js INTS[0x21]), answered from the volume's numbers for Disk
// Defragmenter and ScanDisk: 7302h the extended DPB (the size word, then the DPB with its FAT32 extension), 7303h the
// extended free space (the structure's size, sectors a cluster, bytes a sector, the free and total clusters and
// sectors), 7304h done, 7305h extended absolute read (sector 0 the boot sector) and write (nothing written: no
// drive's sectors are ever written here). An unknown drive fails with CF and error 0Fh
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32, { INTS } = window.W95NE16;
const mem = new Uint8Array(0x200000), dv = new DataView(mem.buffer);
const p = Object.create(Process.prototype);
Object.defineProperty(p, 'u8', { value: mem });
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'ds', 'es', 'ss', 'cs', 'ssb', 'cf', 'zf']) p.cpu[r] = { value: 0 };
Object.assign(p, {
  rmode: true, thread16: null, depth: 0,
  r16: a => dv.getUint16(a, true), r32: a => dv.getUint32(a, true), w16: (a, v) => dv.setUint16(a, v, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true),
  readA(a) { let s = ''; for (let i = 0; mem[a + i]; i++) s += String.fromCharCode(mem[a + i]); return s; },
  ax(v) { if (v === undefined) return p.cpu.eax.value & 0xffff; p.cpu.eax.value = (p.cpu.eax.value & ~0xffff) | (v & 0xffff); },
  fs: { cwd: 'C:\\', statvfs: d => { if (d[0] !== 'C') throw new Error('no drive'); return { total: 2 * 1024 * 1024 * 1024, free: 1536 * 1024 * 1024, cluster: 4096, serial: 0x1234abcd, label: 'WIN95' }; } },
});
// real mode: DS:DX the name at 1000:0, ES:DI the buffer at 2000:0
mem.set([...'C:\\\0'].map(c => c.charCodeAt(0)), 0x10000);
const call = (ax, { bx = 0, cx = 0, si = 0, di = 0, dx = 0 } = {}) => { p.cpu.eax.value = ax; p.cpu.ebx.value = bx; p.cpu.ecx.value = cx; p.cpu.esi.value = si; p.cpu.edi.value = di; p.cpu.ds.value = 0x1000; p.cpu.edx.value = dx; p.cpu.es.value = 0x2000; p.cpu.cf.value = 1; p.trapped = null; INTS[0x21].call(p); return { cf: p.cpu.cf.value, ax: p.ax(), trapped: p.trapped }; };

// the extended free space
mem.fill(0, 0x20000, 0x20100);
let r = call(0x7303, { cx: 0x2c });
assert.deepEqual([r.cf, r.ax, r.trapped], [0, 0, null]);
assert.equal(dv.getUint16(0x20000, true), 0x2c);
const spc = dv.getUint32(0x20004, true), bps = dv.getUint32(0x20008, true), freeCl = dv.getUint32(0x2000c, true), totalCl = dv.getUint32(0x20010, true);
assert.equal(spc, 8); assert.equal(bps, 512);
assert.ok(totalCl > 65525 && totalCl < 2 * 1024 * 1024 * 1024 / 4096, 'a FAT32 volume: its clusters');
assert.ok(freeCl > 0 && freeCl < totalCl, 'some free');
assert.equal(dv.getUint32(0x20014, true), freeCl * spc); assert.equal(dv.getUint32(0x20018, true), totalCl * spc);
assert.equal(call(0x7303, { cx: 0x10 }).cf, 1, 'a buffer too small');
// the extended DPB
mem.fill(0, 0x20000, 0x20100);
r = call(0x7302, { cx: 0x3f });
assert.deepEqual([r.cf, r.ax], [0, 0]);
assert.equal(dv.getUint16(0x20000, true), 0x3d, 'the DPB\'s size');
const d = 0x20002;
assert.equal(mem[d], 2, 'drive C'); assert.equal(dv.getUint16(d + 2, true), 512); assert.equal(mem[d + 4], 7, 'sectors a cluster minus one'); assert.equal(mem[d + 5], 3);
assert.equal(mem[d + 8], 2, 'two FATs'); assert.equal(dv.getUint16(d + 9, true), 0, 'no fixed root directory: FAT32');
assert.equal(dv.getUint32(d + 0x2b, true), totalCl + 1, 'the highest cluster number'); assert.equal(dv.getUint32(d + 0x37, true), freeCl);
assert.equal(dv.getUint32(d + 0x33, true), 2, 'the root directory\'s cluster');
// the unknown drive
mem.set([...'Q:\\\0'].map(c => c.charCodeAt(0)), 0x10000);
r = call(0x7302, { cx: 0x3f }); assert.deepEqual([r.cf, r.ax], [1, 0x0f]);
mem.set([...'C:\\\0'].map(c => c.charCodeAt(0)), 0x10000);
// extended absolute read: a packet at DS:BX (sector, count, buffer offset, segment); sector 0 is the boot sector
dv.setUint32(0x10100, 0, true); dv.setUint16(0x10104, 2, true); dv.setUint16(0x10106, 0, true); dv.setUint16(0x10108, 0x3000, true);
mem.fill(0xee, 0x30000, 0x30400);
r = call(0x7305, { bx: 0x100, cx: 0xffff, si: 0, dx: 3 });   // (DL: drive C is 3)
assert.deepEqual([r.cf, r.ax], [0, 0]);
assert.deepEqual([mem[0x30000], mem[0x301fe], mem[0x301ff]], [0xeb, 0x55, 0xaa], 'the boot sector');
assert.equal(mem[0x30200], 0, 'the next sector: zeros');
// and a write: done, nothing changed anywhere
mem.fill(0xee, 0x30000, 0x30400);
r = call(0x7305, { bx: 0x100, cx: 0xffff, si: 1, dx: 3 });
assert.deepEqual([r.cf, r.ax], [0, 0]); assert.equal(mem[0x30000], 0xee, 'the buffer untouched');
assert.equal(call(0x7305, { bx: 0x100, cx: 1, dx: 3 }).cf, 1, 'CX must be FFFFh');
assert.deepEqual([call(0x7304).cf, call(0x7304).ax], [0, 0]);
console.log('fat32int21: ok');
