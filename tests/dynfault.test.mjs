// An access past the end of memory in code translated at run time (DIBENG's compiled blits) is the page fault the
// processor raises at that instruction, as it is in a module's translated block. It was raised as an invalid opcode
// (#UD) at the start of the run, so the guest's handler saw an exception the code never caused, at the wrong address:
// Explorer opening a .wav went on to fault in USER32 later instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 16) };
p.cpu = { eip: { value: 0 } }; p.modules = [];
p.dynBlock = () => ({ run() { p.cpu.eip.value = 0x1e3db61; throw new WebAssembly.RuntimeError('memory access out of bounds'); } });
const raised = []; p.raise = (v, at, cr2) => { raised.push([v, at >>> 0, cr2 === undefined ? undefined : cr2 >>> 0]); return 0x1234; };
const warn = console.warn; console.warn = () => {};
try {
  assert.equal(p.dynRun(0x1e3db56), null);
  assert.equal(p.noCode(0x1e3db56), 0x1234);
} finally { console.warn = warn; }
assert.deepEqual(raised, [[14, 0x1e3db61, 0xffffffff]], '#PF at the instruction that made the access');

// an instruction run-time translation cannot take is still #UD at it
const q = Object.create(Process.prototype); q.trapped = 'run-time code at 5000: unsupported opcode 0f 0b'; q.raise = (v, at) => [v, at];
console.warn = () => {}; try { assert.deepEqual(q.noCode(0x5000), [6, 0x5000]); } finally { console.warn = warn; }
console.log('dynfault: ok');
