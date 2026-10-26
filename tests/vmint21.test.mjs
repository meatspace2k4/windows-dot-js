// The system's machine reaching a network drive for the page and the other machines (worker.js ownNet, netfs.js):
// INT 21h through IFSMGR, waited on at ring 0 while the redirector talks to the server
// - the call runs on a stack of its own: on the VM's locked stack, where nested execution starts at the top, VTDAPI's
//   timer event (SYSTEM.DRV's callback at SS:3FECh) wrote over the call's return frame and it came back at 0:28h
// - a ring-0 wait takes the interrupts held at the controller: r0Pump polls the card as an interrupt (interrupts off),
//   so the card's interrupt for the server's reply was held for good and the redirector timed out
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;

const mk = () => {
  const p = Object.create(Process.prototype);
  p.mem = { buffer: new ArrayBuffer(64 << 20) };
  p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fsb', 'gsb', 'cf', 'zf', 'if']) p.cpu[r] = { value: 0 };
  p.selUsed = new Uint8Array(0x2000); p.th16 = []; p.depth = 0;
  let top = 0x1000000; p.alloc = n => { const a = top; top += (n + 15) & ~15; return a; };   // (a bump allocator)
  return p;
};

// INT 21h's stack is not the locked stack nested execution uses
{
  const p = mk(); let ss = null;
  p.vxdVecs = { pm: new Map([[0x21, 0xfff70540]]), v86: new Map(), hooks: new Map() };
  p.tick16 = () => {}; p.r0Out = fn => fn(); p.vmFarCall = c => { ss = p.r16(c + 0x34); };
  p.vmInt21({ eax: 0x7303 });
  assert.ok(ss, 'a stack selector');
  assert.notEqual(ss, p.vmLockedStack().sel, 'not the locked stack');
}

// a ring-0 wait takes a held interrupt with interrupts enabled, and leaves the flag as it was
{
  const p = mk(); let seen = null, got = false;
  p.cpu.if.value = 0; p.r0Pump = () => false; p.r0Skip = () => true;
  p.irqPending = function () { seen = this.cpu.if.value; got = true; return true; };
  p.r0Wait(() => got, 'the reply');
  assert.equal(seen, 1, 'taken with interrupts enabled');
  assert.equal(p.cpu.if.value, 0, 'the flag as it was');
}
console.log('vmint21: ok');
