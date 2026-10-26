// Get_PM_Int_Vector for a vector no VxD has set: the personality's handler as the VM's previous one, and for one the
// personality has none for (NetBIOS's 5Ch) a handler that returns as an IRET, never 0:0. VNETBIOS chains the calls it
// passes on to the vector it got; with 0:0 the system's machine ran from linear 0 into exception 6 at 28h (EAX 5Ch) on
// every UNC path its redirector was given
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, { Process } = W, L = window.W95NE16.L;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(64 << 20) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip', 'cs', 'ds', 'es', 'ss', 'fs', 'gs', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'fsb', 'gsb', 'cf', 'zf']) p.cpu[r] = { value: 0 };
p.selUsed = new Uint8Array(0x2000); p.th16 = []; p.depth = 0; p.thunkByName = new Map(); p.thunks = [];

// the VMM service as a hook would call it: a return address on the stack, the vector in EAX, CX:EDX back
p.svcThunk(1 << 16 | 0x44);
const [, getVec] = W.API.VMMSVC.S10044;
const get = n => { p.cpu.esp.value = 0x100000; p.w32(0x100000, 0x1234); p.cpu.eax.value = n; getVec.call(p); return ((p.cpu.ecx.value & 0xffff) << 16 | (p.cpu.edx.value & 0xffff)) >>> 0; };

for (const n of [0x21, 0x2f, 0x5c]) {
  const v = get(n);
  assert.notEqual(v, 0, `INT ${n.toString(16)}h: a handler, not 0:0`);
  assert.equal(v >>> 16, L.THSEL, `INT ${n.toString(16)}h: the personality's thunk`);
  assert.equal(p.th16[(v & 0xffff) >> 2].key, `PMINT.#${n}`);
}
assert.equal(get(0x60), 0, 'a vector outside the personality\'s set: none');

// the 5Ch handler, entered on an interrupt frame, returns to the caller's CS:IP with the frame gone
{
  const v = get(0x5c), [, , fn] = W95NE16.K16 ? W95NE16.K16['PMINT.#92'] : [];
  if (fn) {
    const SS = 0x1407; p.setDesc(SS, 0x200000, 0xffff, 0xf300); p.seg('ss', SS); p.cpu.esp.value = 0xff00;
    const CS = 0x140f; p.setDesc(CS, 0x300000, 0xffff, 0xfb00);
    p.w16(0x200000 + 0xff00, 0x0042); p.w16(0x200000 + 0xff02, CS); p.w16(0x200000 + 0xff04, 0x202);
    assert.equal(fn.call(p), 0x300000 + 0x42, 'back at the caller');
    assert.equal(p.cpu.esp.value & 0xffff, 0xff06, 'the frame popped');
  }
  assert.ok(v);
}
console.log('pmint: ok');
