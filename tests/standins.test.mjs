// The VxD service stand-ins' results their callers read, as tools/staticmap.py finds them from the call sites (a flag
// tested after the call, a register a C service's caller reads besides EAX): _lstrcpyn's EDX (the copy's terminating
// null) and ECX (the room left), which SHELL appends a file name at; Get_Exec_Path's ECX; End_Crit_And_Suspend's CF;
// Get_PM_Int_Vector's ZF (the default handler); _SHELL_CallDll's ECX (0 once called); VWIN32 19h's ZF. And the run-time
// translator's invalid opcodes it threw on: mov to or from segment register 6 or 7, mov to CS, lea of a register.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'dyn.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const W = window.W95Win32, N = window.W95NE16, P = W.Process.prototype;
const mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 }), u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer);
const p = Object.create(P);
p.mem = mem; Object.defineProperty(p, 'u8', { value: u8 });
let top = 0x600000;
Object.assign(p, { selUsed: new Uint8Array(8192), alloc(n) { const a = top; top += (n + 15) & ~15; return a; }, free() {} });
p.cpu = Object.fromEntries(['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if'].map(n => [n, new WebAssembly.Global({ value: 'i32', mutable: true }, 0)]));
const S = N.VXD_SVC, STK = 0x8000;
const call = (dev, svc, ...args) => { p.cpu.esp.value = STK; args.forEach((a, i) => dv.setUint32(STK + 4 * i, a >>> 0, true)); const r = S[dev << 16 | svc].call(p, i => dv.getUint32(STK + 4 * i, true)); if (r !== undefined) p.cpu.eax.value = r; };

// SHELL's path: the Windows folder (Get_Exec_Path), then the file name appended at EDX in ECX characters
call(1, 0xb7); const dir = p.cpu.edx.value >>> 0, n = p.cpu.ecx.value;
assert.equal(p.readA(dir).length, n, 'ECX: the characters up to the last backslash');
const buf = 0x700000, name = 0x700200; p.writeA(name, 'SYSTEM.INI');
call(1, 0x17b, buf, dir, 0x104);
assert.equal(p.cpu.edx.value >>> 0, buf + n, 'EDX: the terminating null'); assert.equal(p.cpu.ecx.value, 0x104 - n, 'ECX: the room left');
call(1, 0x17b, p.cpu.edx.value >>> 0, name, p.cpu.ecx.value);
assert.equal(p.readA(buf), p.readA(dir) + 'SYSTEM.INI');

p.cpu.cf.value = 0; call(1, 0x21); assert.equal(p.cpu.cf.value, 1, 'End_Crit_And_Suspend: CF, the system VM not suspended');
p.thunk16For = () => 0x12340000;
p.cpu.eax.value = 0x24; p.cpu.zf.value = 0; call(1, 0x44); assert.equal(p.cpu.zf.value, 1, 'Get_PM_Int_Vector: ZF, the default handler');
p.cpu.ecx.value = 0x1f; p.cpu.edx.value = 0x100; call(1, 0x45); p.cpu.eax.value = 0x24; call(1, 0x44); assert.equal(p.cpu.zf.value, 0, 'a hooked one: ZF clear');
p.cpu.zf.value = 1; call(0x2a, 0x19, 0x1000, 0, 0xffffffff, 4); assert.equal(p.cpu.zf.value, 0, 'VWIN32 19h: ZF from its result');
p.loadLibrary16 = () => null; p.writeA(name, 'NONE.DLL'); call(0x17, 0x18, name, 1, 0, 0); assert.notEqual(p.cpu.ecx.value, 0, '_SHELL_CallDll: ECX nonzero, not called');

// services the gap map found called that nothing provided: VWIN32's EnterCrstR0 / LeaveCrstR0 (SPOOLER's), CONFIGMG's
// Write_Registry_Value (VCOMM's port settings), read back by Read_Registry_Value
assert.ok(S[0x2a << 16 | 9] && S[0x2a << 16 | 0xa]);
const dn = { id: 'ROOT\\*PNP0500\\0000' }; p.cmNode = () => dn; p.cmKey = () => 'enum\\root\\*pnp0500\\0000';
p.writeA(0x700300, 'Settings'); p.writeA(0x700400, '9600,n,8,1'); dv.setUint32(0x700500, 0x100, true);
call(0x33, 0x3f, 1, 0, 0x700300, 1, 0x700400, 0x100, 0); assert.equal(p.cpu.eax.value, 0);
u8.fill(0, 0x700600, 0x700700); call(0x33, 0x3e, 1, 0, 0x700300, 1, 0x700600, 0x700500, 0);
assert.equal(p.readA(0x700600), '9600,n,8,1', 'to its terminating null');

// and the ones read from Windows 95's own VMM32 components (WIN95_02.CAB): VMM's _GetCurrentContext (one context,
// _PageAttach's), VDMAD's Scatter_Lock, CONFIGMG's Set_DevNode_PowerState, VSD's and VMD's
call(1, 0x157); const ctx = p.cpu.eax.value; assert.ok(ctx); call(1, 0x157); assert.equal(p.cpu.eax.value, ctx);
call(1, 0x125, 0x100, ctx, 0x200, 1); assert.equal(p.cpu.eax.value, 0, '_PageAttach: no second mapping of a page');
const dds = 0x700800; u8.fill(0, dds, dds + 0x40); dv.setUint32(dds, 0x2345, true); dv.setUint32(dds + 4, 0x123456, true); dv.setUint16(dds + 0xc, 4, true);
p.cpu.eax.value = 0; p.cpu.edi.value = dds; S[4 << 16 | 0xb].call(p);
assert.deepEqual([p.cpu.cf.value, p.cpu.zf.value, p.cpu.edx.value, dv.getUint16(dds + 0xe, true), dv.getUint32(dds + 0x10, true), dv.getUint32(dds + 0x14, true)], [0, 1, 1, 1, 0x123456, 0x2345], 'Scatter_Lock: one piece');
p.cpu.eax.value = 1; S[4 << 16 | 0xb].call(p);
assert.deepEqual([p.cpu.zf.value, p.cpu.esi.value, dv.getUint16(dds + 0xe, true), dv.getUint32(dds + 0x10, true), dv.getUint32(dds + 0x18, true), dv.getUint32(dds, true)], [1, 0x456, 3, 0x123007, 0x125007, 0x2345], 'page table entries');
dv.setUint16(dds + 0xc, 2, true); S[4 << 16 | 0xb].call(p);
assert.deepEqual([p.cpu.zf.value, p.cpu.edx.value, dv.getUint32(dds, true)], [0, 2, 0x2000 - 0x456], 'more pages than entries: the size the table holds');
p.cmNode = h => (h === 7 ? dn : null);
for (const [st, fl, cr] of [[1, 0, 0], [3, 0, 0x1f], [0x10, 0, 4], [8, 2, 4], [8, 0, 0]]) { call(0x33, 0x64, 7, st, fl); assert.equal(p.cpu.eax.value, cr, `power state ${st} ${fl}`); }
call(0x33, 0x64, 9, 1, 0); assert.equal(p.cpu.eax.value, 5); assert.equal(dn.power, 8);
p.sysVM = () => 0xc0001000;
for (const d of [0xb, 0xc]) { p.cpu.cf.value = 1; S[d << 16].call(p); assert.deepEqual([p.cpu.eax.value, p.cpu.cf.value], [0x300, 0]); }
S[0xc << 16 | 2].call(p); assert.equal(p.cpu.ebx.value >>> 0, 0xc0001000, 'VMD: the system VM owns the mouse');

// run-time translation: invalid opcodes, not the translator's own error
p.selLimit = () => 0xffff; p.trap = () => {};
for (const [bytes, what] of [[[0x8e, 0xf0], 'mov to segment register 6'], [[0x8c, 0xf8], 'mov from segment register 7'], [[0x8e, 0xc8], 'mov to segment register 1'], [[0x8d, 0xc0], 'lea with a register operand']]) {
  u8.set([...bytes, 0xc3], 0x200000); assert.equal(p.dynCheck(0x200000).unsupported, what);
}
console.log('standins: ok');
