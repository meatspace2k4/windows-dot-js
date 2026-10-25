// What Device Manager and System Properties ask of the machine through the 16-bit side: CONFIGMG's protected-mode
// API walks the devnode tree vmm.js keeps (the root first, Locate_DevNode with no ID), reads a device's flags in the
// hardware profile and its logical configurations (16:16 pointers, the ring-0 services' answers); INT 21h 440Dh's
// Get Drive Map Info says a local drive runs under a protected-mode driver and a network drive has no block device;
// GetDriveType calls a network drive remote.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype;
const mem = new Uint8Array(16 << 20), dv = new DataView(mem.buffer);
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: mem });
let top = 0x600000;
Object.assign(p, {
  selUsed: new Uint8Array(8192), alloc(n) { const a = top; top += (n + 15) & ~15; return a; }, free() {},
  r16: a => dv.getUint16(a, true), r32: a => dv.getUint32(a, true), w16: (a, v) => dv.setUint16(a, v, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true),
  retf16: () => 0,
  cards: () => [{ devnode: 'ROOT\\*PNP0400\\0000', io: [[0x378, 3]], irq: [7], dma: [] }],
});
p.cpu = Object.fromEntries(['eax', 'ebx', 'ecx', 'edx', 'ebp', 'esp', 'ssb', 'ds', 'cf'].map(n => [n, { value: 0 }]));
const SEL = 0x1007, BASE = 0x100000; p.setDesc(SEL, BASE, 0xffff);
const far = o => (SEL << 16) | o;
for (const id of ['*PNP0400\\0000', '*PNPB003\\0000']) W.regSet(`hklm\\enum\\root\\${id}`, 'Class', 'x');
W.regSet('hklm\\config\\0001\\enum\\root\\*pnpb003\\0000', 'CSConfigFlags', 1);

// a CONFIGMG API call as SETUPX makes it: the function in AX, the arguments as dwords above the frame at SS:BP
const cm = (fn, ...args) => {
  p.cpu.eax.value = fn; p.cpu.ssb.value = 0x200000; p.cpu.ebp.value = 0;
  args.forEach((v, i) => p.w32(0x200004 + 4 * i, v));
  p.thunk16Def('VXD.#51').def[2].call(p);
  return p.cpu.eax.value & 0xffff;
};
const OUT = 0x10, str = (o, s) => { mem.set([...s].map(c => c.charCodeAt(0)), BASE + o); mem[BASE + o + s.length] = 0; };

assert.equal(cm(2, far(OUT), 0, 0), 0, 'Locate_DevNode(NULL): the root');
const root = p.r32(BASE + OUT);
assert.equal(cm(6, far(OUT), root, 0), 0); assert.equal(p.r32(BASE + OUT), 'HTREE\\ROOT\\0'.length, 'the root\'s ID');
assert.equal(cm(4, far(OUT), root, 0), 0, 'Get_Child of the root'); const first = p.r32(BASE + OUT);
assert.equal(cm(5, far(OUT), first, 0), 0, 'Get_Sibling'); const second = p.r32(BASE + OUT);
assert.equal(cm(5, far(OUT), second, 0), 0x0d, 'the last child has no sibling (CR_NO_SUCH_DEVNODE)');
assert.equal(cm(3, far(OUT), second, 0), 0); assert.equal(p.r32(BASE + OUT), root, 'Get_Parent: the root');
assert.equal(cm(7, first, far(0x40), 64, 0), 0); assert.equal(p.readA(BASE + 0x40), 'ROOT\\*PNP0400\\0000');

// Get_HW_Prof_Flags(far ID, config, far *flags): the profile's CSConfigFlags, 0 when it has none
str(0x80, 'ROOT\\*PNPB003\\0000'); assert.equal(cm(0x4a, far(0x80), 0, far(OUT), 0), 0); assert.equal(p.r32(BASE + OUT), 1, 'disabled in profile 0001');
str(0x80, 'ROOT\\*PNP0400\\0000'); cm(0x4a, far(0x80), 0, far(OUT), 0); assert.equal(p.r32(BASE + OUT), 0);

// Get_Hardware_Profile_Info(index, far HWPROFILEINFO, flags): the current profile (FFFFFFFFh) and the first by index,
// 0001 "Original Configuration"; past the last, CR_NO_MORE_HW_PROFILES
W.regSet('hklm\\system\\currentcontrolset\\control\\idconfigdb', 'CurrentConfig', '0001');
W.regSet('hklm\\system\\currentcontrolset\\control\\idconfigdb', 'FriendlyName0001', 'Original Configuration');
for (const i of [0xffffffff, 0]) {
  assert.equal(cm(0x52, i, far(0x400), 0), 0);
  assert.equal(p.r32(BASE + 0x400), 1); assert.equal(p.readA(BASE + 0x404), 'Original Configuration');
}
assert.equal(cm(0x52, 1, far(0x400), 0), 0x35);

// the printer port's resources: its first allocated configuration, an I/O descriptor 378h-37Ah, then its IRQ
assert.equal(cm(0x1a, far(OUT), first, 2), 0, 'Get_First_Log_Conf'); const lc = p.r32(BASE + OUT);
assert.equal(cm(0x1f, far(OUT), lc, 0, far(OUT + 4), 0), 0, 'Get_Next_Res_Des'); const rd = p.r32(BASE + OUT);
assert.equal(p.r32(BASE + OUT + 4), 2, 'ResType_IO');
assert.equal(cm(0x21, far(OUT), rd, 0), 0); const n = p.r32(BASE + OUT);
assert.equal(cm(0x22, rd, far(0x100), n, 0), 0); assert.deepEqual([p.r16(BASE + 0x104), p.r16(BASE + 0x106)], [0x378, 0x37a]);
assert.equal(cm(0x1f, far(OUT), rd, 0, far(OUT + 4), 0), 0); assert.equal(p.r32(BASE + OUT + 4), 4, 'then ResType_IRQ');
assert.equal(cm(0x1b, far(OUT), lc, 0), 0x0e, 'one configuration (CR_NO_MORE_LOG_CONF)');

// INT 21h 440Dh CX 086Fh, Get Drive Map Info: C: under the protected-mode driver on INT 13h unit 80h; a network
// drive is not a block device (15); another request is not one there is (1)
p.fs = { cwd: 'C:\\', vols: new Map([['C', { letter: 'C', kind: 'fixed' }], ['E', { letter: 'E', kind: 'remote' }]]) };
const ioctl = (bl, cx) => { p.cpu.ebx.value = bl; p.cpu.ecx.value = cx; p.cpu.ds.value = SEL; p.cpu.edx.value = 0x200; p.cpu.cf.value = 0; mem[BASE + 0x200] = 16; p.cpu.eax.value = 0x440d; p.blockIoctl(); return p.cpu.cf.value ? p.cpu.eax.value & 0xffff : 0; };
assert.equal(ioctl(3, 0x086f), 0);
assert.deepEqual([...mem.subarray(BASE + 0x200, BASE + 0x204)], [16, 16, 3, 0x80], 'C:: protected-mode logical and physical drive, unit 80h');
assert.equal(p.r32(BASE + 0x204), 1 << 2, 'its drive map: C:');
assert.equal(ioctl(5, 0x086f), 15, 'E:, a network drive');
assert.equal(ioctl(3, 0x0860), 1, 'Get Device Parameters is not answered here');

// the display adapter (ne16.js's card: VGA.LogConfig's windows and ports) under the Display class, and the monitor it
// enumerates as its child: its memory descriptors come first, A0000h-AFFFFh
{
  const q = Object.create(P);
  Object.defineProperty(q, 'u8', { value: mem });
  Object.assign(q, { alloc: p.alloc, free() {}, r16: p.r16, r32: p.r32, w16: p.w16, w32: p.w32, host: {} });
  W.regSet('hklm\\enum\\root\\*pnp0912\\0000', 'Class', 'Display');
  W.regSet('hklm\\enum\\monitor\\default_monitor\\0001', 'Class', 'Monitor'); W.regSet('hklm\\enum\\monitor\\default_monitor\\0001', 'Driver', 'Monitor\\0000');
  const disp = q.devnodes().find(d => d.id === 'ROOT\\*PNP0912\\0000'), monitor = q.devnodes().find(d => d.id === 'MONITOR\\DEFAULT_MONITOR\\0001');
  assert.ok(disp && monitor && monitor.parent === disp && disp.children.includes(monitor), 'the monitor is the adapter\'s child');
  assert.equal(q.cmTree().children.includes(monitor), false, 'and not the root\'s');
  const lc0 = q.cmLogConfs(disp, 2)[0], rd0 = lc0.res[0];
  assert.equal(rd0.rid, 1, 'ResType_Mem first');
  assert.deepEqual([q.r32(rd0.handle + 4), q.r32(rd0.handle + 8)], [0xa0000, 0xaffff]);
  assert.deepEqual(lc0.res.map(r => r.rid), [1, 1, 1, 2, 2], 'three windows, then the VGA\'s two port ranges');
}

// GetDriveType: a network drive is DRIVE_REMOTE
str(0x300, 'E:\\'); assert.equal(W.API.KERNEL32.GetDriveTypeA[1].call(p, BASE + 0x300), 4);
str(0x300, 'C:\\'); assert.equal(W.API.KERNEL32.GetDriveTypeA[1].call(p, BASE + 0x300), 3);
console.log('configmg16: ok');
