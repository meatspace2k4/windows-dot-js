// A VxD call gives its caller back its interrupt flag, as the VMM's return to a VM restores its flags: a VxD that
// returns with interrupts disabled (CLI, no STI) left them disabled for the VM, the sound card's interrupt was held for
// good, and a wait on a wave's end (SystemStart at the first start) never ended
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype;

function machine(body) {
  const p = Object.create(P), regs = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'cf', 'zf', 'if',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'fs'];
  p.cpu = Object.fromEntries(regs.map(n => [n, { value: n === 'if' ? 1 : n === 'esp' ? 0x9000 : 0 }]));
  Object.assign(p, {
    depth: 0, r0Depth: 0, trapped: null,
    r0Free: () => 0x8000, push() {}, reg: n => p.cpu[n].value, vmIrqDeliver() {},
    runAt() { body(p); return 0; },
  });
  return p;
}
// the VxD disables interrupts and returns: the caller's flag comes back
{
  const p = machine(q => { q.cpu.if.value = 0; });
  p.vxdCall(0x1000);
  assert.equal(p.cpu.if.value, 1);
}
// a caller running with interrupts disabled gets them disabled back, whatever the VxD left
{
  const p = machine(q => { q.cpu.if.value = 1; });
  p.cpu.if.value = 0;
  p.vxdCall(0x1000);
  assert.equal(p.cpu.if.value, 0);
}
console.log('vxdintflag: ok');
