// KERNEL's task list for TOOLHELP (ne16.js newTdb, thhook): THHOOK (KERNEL's export 332, a data pointer GetProcAddress
// answers) holds HeadTDB at 0Eh and CurTDB at 10h; each TDB is a Windows 3.1 TDB (the next task at 0, SS:SP at 2 and
// 4, hInstance 1Ch, hModule 1Eh, the module name at F2h, 'TD' at FAh), linked as its task starts and out of the list
// as it ends. TaskFirst and TaskNext walk exactly that chain, so the walk here is theirs: every running task, each
// once, and no ended one. FatalExitHook and ToolHelpHook answer the hook before; HasGPHandler answers 0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'osclass.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { K16 } = window.W95NE16, P = window.W95Win32.Process.prototype;
const mem = new Uint8Array(0x40000), dv = new DataView(mem.buffer);
let top = 0x10000, nextSel = 0x1007; const sels = new Map();
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
Object.assign(p, {
  alloc: n => { const a = top; top += (n + 15) & ~15; return a; }, free() {},
  r16: a => dv.getUint16(a, true), w16: (a, v) => dv.setUint16(a, v, true), r32: a => dv.getUint32(a, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true),
  writeA(a, s, n) { for (let i = 0; i < s.length && (n === undefined || i < n); i++) mem[a + i] = s.charCodeAt(i); if (n === undefined) mem[a + s.length] = 0; return s.length; },
  readA(a, n) { let s = ''; for (let i = 0; (n === undefined || i < n) && mem[a + i]; i++) s += String.fromCharCode(mem[a + i]); return s; },
  allocSels(lin) { const s = nextSel; nextSel += 8; sels.set(s & 0xfff8, lin); return s; },
  selBase(s) { return sels.get(s & 0xfff8); }, selValid(s) { return sels.has(s & 0xfff8); },
  kernelModule: () => ({ hModule: 0x0107 }), masterSel: 0x2007,
  threadsById: new Map(), procs: new Map(), thread16: null,
});
// the walk TOOLHELP's TaskFirst and TaskNext make: HeadTDB, then each TDB's next, each with 'TD' at FAh
const walk = () => { const out = []; for (let s = p.r16(p.thhookLin + 0xe), n = 0; s && n < 32; s = p.r16(p.selBase(s)), n++) { const b = p.selBase(s); assert.equal(p.r16(b + 0xfa), 0x4454, 'TD'); out.push({ sel: s, name: p.readA(b + 0xf2, 8).trim(), hInst: p.r16(b + 0x1c), hModule: p.r16(b + 0x1e) }); } return out; };

const th = (p.thhook() >>> 16); assert.equal(th & 0xfff8, p.thhookSel & 0xfff8);
assert.equal(p.r16(p.thhookLin + 4), 0x0107, 'hExeHead: KERNEL');
assert.deepEqual(walk(), []);
// the system's task, a Win16 task and a Win32 process start
const sys = p.currentTask(); assert.equal(p.tdb16, sys);
const task = { id: 7, state: 'waiting', task: { hInst: 0x1a2e, mod: { hModule: 0x1a26, name: 'MMTASK' } }, ctx: { ss: 0x1a37, esp: 0x1234 } };
p.threadsById.set(7, task); p.thread16 = task; task.tdb = p.currentTask(); p.thread16 = null;
// a Win32 process (newTdb is module-private: its TDB made as a task's is, through currentTask, named as spawn names it)
const pc = { pid: 0x60, path: 'C:\\WINDOWS\\NOTEPAD.EXE', exitCode: null }; p.procs.set(0x60, pc);
const t32 = { id: 8, state: 'running', pc, flat: true, ctx: { ss: 0, esp: 0x100000 } }; p.threadsById.set(8, t32);
p.thread16 = { task: { hInst: 0x1b2e, mod: { hModule: 0x1b26, name: 'NOTEPAD' } } }; pc.tdb = p.currentTask(); p.thread16 = null;
assert.deepEqual(walk().map(x => x.name), ['NOTEPAD', 'MMTASK', 'KERNEL'], 'the newest first, as KERNEL links a task at the head');
assert.deepEqual(walk().map(x => [x.hInst, x.hModule])[1], [0x1a2e, 0x1a26]);
// the running task: CurTDB and its TDB's SS:SP
p.tdbCurrent(task); assert.equal(p.r16(p.thhookLin + 0x10), task.tdb); assert.equal(p.r16(p.selBase(task.tdb) + 2), 0x1234); assert.equal(p.r16(p.selBase(task.tdb) + 4), 0x1a37);
// the Win16 task ends: out of the list; the process ends: out too; the system's task stays
task.state = 'done'; p.tdbPrune(); assert.deepEqual(walk().map(x => x.name), ['NOTEPAD', 'KERNEL']);
pc.exitCode = 0; t32.state = 'done'; p.tdbPrune(); assert.deepEqual(walk().map(x => x.name), ['KERNEL']);
// the hooks
assert.equal(K16['KERNEL.#318'][2].call(p, 0x11110001), 0); assert.equal(K16['KERNEL.#318'][2].call(p, 0x22220002), 0x11110001);
assert.equal(K16['KERNEL.#341'][2].call(p, 0x33330003), 0); assert.equal(K16['KERNEL.#341'][2].call(p, 0), 0x33330003);
assert.equal(K16['KERNEL.#338'][2].call(p, 0x1234), 0);
console.log('toolhelp: ok');
