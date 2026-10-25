// The processor's interrupt flag: the sound card's interrupt is held at the controller while the code running has
// interrupts disabled (CLI), and delivered once it enables them again (STI, POPF, IRET: the host's next pass). The
// handler runs with interrupts disabled and the flags it interrupted come back after it
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
window.AudioContext = class { constructor() { this.state = 'running'; } close() {} };
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'sound.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype;

function machine() {
  const p = Object.create(P), calls = [];
  p.cpu = Object.fromEntries(W.LAYOUT ? ['cf', 'pf', 'zf', 'sf', 'of', 'df', 'if'].map(n => [n, { value: n === 'if' ? 1 : 0 }]) : []);
  Object.assign(p, {
    dosVec: { [8 + 7]: 0x12340056 }, now: () => 0, tick16() {},
    call16(sel, off, args) { calls.push({ sel, off, args, ifDuring: p.cpu.if ? p.cpu.if.value : null }); },
  });
  return { p, calls };
}
// interrupts enabled: the handler runs at once, with interrupts disabled inside it, enabled again after
{
  const { p, calls } = machine();
  p.cpu.cf.value = 1;
  assert.equal(p.raiseIRQ(7), true);
  assert.equal(calls.length, 1); assert.equal(calls[0].ifDuring, 0); assert.deepEqual(calls[0].args, [['w', 0x202]]);
  assert.equal(p.cpu.if.value, 1); assert.equal(p.cpu.cf.value, 1);
}
// interrupts disabled (CLI): the request waits at the controller; nothing runs until they are enabled
{
  const { p, calls } = machine();
  p.cpu.if.value = 0;
  assert.equal(p.raiseIRQ(7), false); assert.equal(calls.length, 0);
  assert.equal(p.irqPending(), false); assert.equal(calls.length, 0);
  p.cpu.if.value = 1;                                     // STI
  assert.equal(p.irqPending(), true); assert.equal(calls.length, 1);
  assert.equal(p.irqPending(), false, 'delivered once');
}
// the held request is in the controller's state, and sound16's pass delivers it
{
  const { p, calls } = machine();
  p.cpu.if.value = 0; p.raiseIRQ(7);
  assert.equal(p.picState().irr & 0x80, 0x80);
  p.cpu.if.value = 1; p.sound16();
  assert.equal(calls.length, 1); assert.equal(p.picState().irr & 0x80, 0);
}
// a machine without the flag (tests that build a partial processor) delivers as before
{
  const { p, calls } = machine();
  delete p.cpu.if;
  assert.equal(p.raiseIRQ(7), true); assert.equal(calls.length, 1);
}
