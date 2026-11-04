// A second instance of a MULTIPLEDATA program (WinOldAp, one per MS-DOS program) gets a DGROUP of its own, as KERNEL
// gives each instance one: the data as the file has it, a local heap at InitTask, its handle the module's, and freed
// with its task. InitTask hands it the instance already running (SI, hPrevInstance), so it does not register its
// window classes again. Sharing the first's DGROUP, its LocalAlloc failed ("no local heap ... called from WINOLDAP");
// given SI 0, it registered its classes again, USER refused, and it stopped with "not enough system resources"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'osclass.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, { K16 } = window.W95NE16;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(LAYOUT.HEAP_END + 0x100000) }; Object.defineProperty(p, 'u8', { value: new Uint8Array(p.mem.buffer) });
p.heapTop = LAYOUT.HEAP; p.allocs = new Map(); p.freeList = new Map(); p.init16();
const reg = v => ({ value: v });
p.cpu = Object.assign(p.cpu || {}, { eax: reg(0), ebx: reg(0), ecx: reg(0), edx: reg(0), esi: reg(0x7777), edi: reg(0), esp: reg(0x100), ss: reg(0), ssb: reg(0), es: reg(0), esb: reg(0), ds: reg(0), dsb: reg(0), cs: reg(0), csb: reg(0) });

// WINOLDAP: MULTIPLEDATA, a code segment and a 0x400-byte DGROUP whose data the file holds
const file = new Uint8Array(0x2000), hdr = 0x40, dv = new DataView(file.buffer);
dv.setUint32(0x3c, hdr, true); file[hdr] = 0x4e; file[hdr + 1] = 0x45; dv.setUint16(hdr + 0x0c, 0x0002, true);
dv.setUint16(hdr + 0x10, 0x800, true); dv.setUint16(hdr + 0x12, 0x800, true);   // (heap, stack)
for (let i = 0; i < 0x100; i++) file[0x1000 + i] = i;
const code = p.alloc(0x100), data = p.alloc(0x10000);
const dg = { base: data, len: 0x100, alloc: 0x400, minalloc: 0x400, fileoff: 0x1000, flags: 1 };
const rec = { name: 'WINOLDAP', file, meta: { segs: [{ base: code, sel: p.allocSels(code, 0x100), flags: 0 }, dg], entry: [1, 0], autodata: 2, fixups: [] } };
rec.segs = rec.meta.segs; rec.dgroup = dg.sel = p.allocSels(data, 0x10000); p.ghandles.set(rec.dgroup, { lin: data, size: 0x10000, n: 1, flags: 0, lock: 0 });
rec.hInstance = rec.dgroup; rec.hModule = p.allocSels(p.alloc(0x40), 0x40); p.ne = new Map([['WINOLDAP', rec]]);
p.u8.set(file.subarray(0x1000, 0x1100), data); p.u8[data + 5] = 0xee;   // (the first instance's data as it ran: changed)
p.loadLibrary16 = () => rec; p.effect = () => {}; p.startClock = () => ({});
const load = () => { const r = K16['KERNEL.#45'][2].call(p, 'WINOA386.MOD', 0); return [...p.threadsById.values()].find(t => t.tdb === r >>> 16); };

const t1 = load(); t1.state = 'waiting';
assert.equal(t1.task.dgroup, rec.dgroup, 'the first instance: the module\'s DGROUP'); assert.ok(!t1.task.prev, 'no previous instance');
const t2 = load();
assert.notEqual(t2.task.dgroup, rec.dgroup, 'the second: a DGROUP of its own'); assert.equal(t2.task.hInst, t2.task.dgroup, 'its handle');
const b2 = p.gblock(t2.task.dgroup); assert.ok(b2, 'a global block');
assert.equal(p.u8[b2.lin + 5], 5, 'its data as the file has it, not the first instance\'s');
assert.equal(t2.task.prev, rec.hInstance, 'the first instance its previous');
assert.equal(p.neByHandle(t2.task.hInst), rec, 'its handle is the module\'s');

// InitTask as the second: SI the previous instance, and a local heap in its own DGROUP that LocalAlloc takes from
p.thread16 = t2; p.retf16 = () => 0;
K16['KERNEL.#91'][2].call(p);
assert.equal(p.cpu.esi.value & 0xffff, rec.hInstance, 'hPrevInstance');
assert.ok(p.lheaps.has(t2.task.dgroup | 1), 'its local heap');
assert.ok(p.localAlloc(0x40, 0x20, t2.task.dgroup), 'LocalAlloc takes from it');

// its task ends: its DGROUP goes with it
p.thread16 = null; t2.state = 'done'; p.ne.get = () => null;
const g = t2.task.dgroup; p.taskModuleEnded(t2);
assert.ok(!p.gblock(g), 'freed'); assert.ok(!rec.instances.has(g), 'no longer the module\'s');
console.log('multidata: ok');
