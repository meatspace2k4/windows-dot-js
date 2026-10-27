// worker.js netBatch: a host's calls made on a thread of their own, in order; one with `ifWindow` asks USER32's IsWindow
// first and is made only while the window is one, its result 0 otherwise (the world's read of a dialog's controls
// after the dialog closed: USER's parameter error 6040 for a message to a window that is gone)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const wk = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const i = wk.indexOf('  netBatch(calls, remote = false) {'), j = wk.indexOf('\n  }\n', i) + 4;
const M = new Function(`return class { kick() {}\n${wk.slice(i, j)} }`)();

// a machine whose thread runs the code: decoded as written (push imm32; call [m32]; test eax, eax; jz rel32; mov [m32], eax; ret 4)
function machine(live) {
  const mem = new Uint8Array(1 << 16), dv = new DataView(mem.buffer); let top = 0x1000;
  const exports = new Map([['IsWindow', 0x9001], ['SendMessageA', 0x9002]]), made = [];
  const fns = { 0x9001: ([h]) => (live.has(h) ? 1 : 0), 0x9002: a => { made.push(a); return 7; } };
  const p = {
    u8: mem, alloc(n) { const a = top; top += (n + 15) & ~15; return a; }, free() {}, writeA() {},
    w32: (a, v) => dv.setUint32(a, v >>> 0, true), r32: a => dv.getUint32(a, true),
    byName: new Map([['USER32', { exports }]]), thunkFor: () => 0,
    newThread(at) {
      const t = {}; let pc = at, eax = 0; const stack = [];
      for (;;) {
        const op = mem[pc];
        if (op === 0x68) { stack.push(dv.getUint32(pc + 1, true)); pc += 5; }
        else if (op === 0xff && mem[pc + 1] === 0x15) { const f = dv.getUint32(dv.getUint32(pc + 2, true), true), n = f === 0x9001 ? 1 : 4; eax = fns[f](stack.splice(-n).reverse()); pc += 6; }
        else if (op === 0x85 && mem[pc + 1] === 0xc0) pc += 2;
        else if (op === 0x0f && mem[pc + 1] === 0x84) { pc += 6; if (!eax) pc += dv.getInt32(pc - 4, true); }
        else if (op === 0xa3) { dv.setUint32(dv.getUint32(pc + 1, true), eax, true); pc += 5; }
        else if (op === 0xc2) break;
        else throw new Error(`byte ${op.toString(16)} at ${pc.toString(16)}`);
      }
      setTimeout(() => t.onDone(), 0); return t;
    },
  };
  const m = new M(); m.proc = p; return { m, made };
}
{
  const { m, made } = machine(new Set([0x194]));
  const r = await m.netBatch([
    { dll: 'USER32', name: 'SendMessageA', args: [0x194, 0x0d, 0x400, 0x2000], ifWindow: 0x194 },
    { dll: 'USER32', name: 'SendMessageA', args: [0x198, 0xf0, 0, 0], ifWindow: 0x198 },   // (gone)
    { dll: 'USER32', name: 'SendMessageA', args: [0x198, 0xf0, 0, 0] },                    // (no check: made)
  ]);
  assert.deepEqual(r, [7, 0, 7]);
  assert.deepEqual(made, [[0x194, 0x0d, 0x400, 0x2000], [0x198, 0xf0, 0, 0]]);
}
console.log('netbatch: ok');
