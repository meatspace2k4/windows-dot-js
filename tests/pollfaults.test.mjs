// What runs at the machine's interrupts (the VMM's due time-outs, VKD's hot keys: REBOOT's Ctrl+Alt+Del among them)
// and what the system loads at boot (the network's router, MPR) answer to the machine: a fault there is the fault
// (a blue screen at ring 0), an error the machine's end. Each was a console line, and the machine went on.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const method = name => { const i = src.indexOf(`  ${name}() {`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n  }\n', i) + 4); };
const M = new Function('B', 'W', 'fs', `return class {\n${method('poll')}\n${method('loadMpr')}\n}`);
const ring = [];
const B = { KEY: 1, MOUSE: 2, ringTake: () => ring.shift() };
let reg;
const W = { WM: { KEYDOWN: 0x100, KEYUP: 0x101 }, regGet: () => reg };
class Fault extends Error {}
const mk = proc => { const m = new (M(B, W, { exists: () => false }))(); Object.assign(m, { proc, ring: [], queueKey() {}, stopFullSavers() {} }); return m; };

{ // a time-out that faults
  const p = { depth: 1, r0Depth: 0, vxdCrit: 0, vxdTimeOuts: new Set([1]), vxdRunTimeOuts() { throw new Fault('page fault in REBOOT at ring 0'); }, dispatchInput() {} };
  const m = mk(p);
  assert.throws(() => m.poll(), /page fault in REBOOT/, 'a VMM time-out\'s fault reaches the machine');
  assert.equal(p.depth, 1, 'its nesting as it was'); assert.equal(m.inTimer, false);
}
{ // a hot key whose handler faults
  const p = { depth: 0, vkdKey() { throw new Fault('page fault in VKD at ring 0'); }, dispatchInput() {} };
  ring.push([B.KEY, 0x53, 6, 0x2e]);
  assert.throws(() => mk(p).poll(), /page fault in VKD/, 'a VKD hot key\'s fault reaches the machine');
}
{ // the router that fails to load
  reg = 'MSNP32'; const p = { init16() {}, loadDll() { throw new Error('MPR at 7f0000 lies over SHELL32.DLL\'s image'); } };
  assert.throws(() => mk(p).loadMpr(), /MPR at 7f0000 lies over/, 'MPR\'s load that fails stops the boot, naming why');
}
console.log('pollfaults: ok');
