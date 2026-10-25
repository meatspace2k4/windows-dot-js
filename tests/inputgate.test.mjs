// the host feeds the next keys and mouse events only when USER has taken the earlier ones: asked of the task in the
// foreground, whose queue hardware input wakes, not of the system thread's queue
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;

function machine(fg, pending) {
  const p = Object.create(P), main = { id: 9, state: 'running' }, asked = [];
  Object.assign(p, {
    thread16: null, procs: new Map([[0x120, { pid: 0x120, tdb: 0x1234, main }]]),
    user16(ord, args) {
      if (ord === 608) return { ax: fg };                                       // GetForegroundWindow
      if (ord === 224) return { ax: args[0][1] && args[0][1] === fg ? 0x1234 : 0 };   // GetWindowTask
      if (ord === 335) { asked.push(this.thread16 ? this.thread16.id : 0); return { ax: pending(this.thread16) ? 1 : 0 }; }   // GetInputState
      throw new Error('USER.' + ord);
    },
  });
  return { p, main, asked };
}
// asked as the foreground program's thread: its keys still to take hold the host's feed
{
  const { p, main, asked } = machine(0x33c, t => t === main);
  assert.equal(p.inputPending(), true); assert.deepEqual(asked, [9]); assert.equal(p.thread16, null);
}
// the same program with its queue drained: the host feeds on
{
  const { p } = machine(0x33c, () => false);
  assert.equal(p.inputPending(), false);
}
// no foreground window (none of a started program): asked as the system
{
  const { p, asked } = machine(0, () => false);
  assert.equal(p.inputPending(), false); assert.deepEqual(asked, [0]);
}
