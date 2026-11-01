// VDD's grabber functions for an MS-DOS VM's window (ne16.js vddGrab, the VDD API), and VKD's key for it, against what
// VGAFULL.3GR reads from them and what Windows 95's VDD gives:
// - the function in AX: EAX's high word is whatever the grabber left there (3DF7h), and its calls went unanswered
// - 1: the screen copied to memory of VDD's own: the grabber clears rows in what it is given (REP STOSW), and given
//   the VM's screen it wiped MEM's output
// - 1: no shadow at +4: given one, a repaint after the window was erased drew nothing back (the text cleared)
// - 1: the colors at +24h (palette value -> DAC entry -> blue, green, red in the top bytes): left 0, black on black
// - 7: the whole screen changed for the next 3: after an erase the window is drawn again
// - VKD 1: the key typed into the window to that VM's keyboard, carry clear
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, LAYOUT } = window.W95Win32, { K16 } = window.W95NE16;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(LAYOUT.HEAP_END + 0x100000) }; Object.defineProperty(p, 'u8', { value: new Uint8Array(p.mem.buffer) });
p.heapTop = LAYOUT.HEAP; p.allocs = new Map(); p.freeList = new Map(); p.init16();
const reg = v => ({ value: v });
p.cpu = { eax: reg(0), ebx: reg(0), ecx: reg(0), edx: reg(0), esi: reg(0), edi: reg(0), es: reg(0), cf: reg(0) };
p.lin = a => a & 0xffff;   // (ES 0: the caller's buffer at DI)

// an MS-DOS VM whose machine shows MEM's last screen: text mode, 80x25, white on black
const v86 = p.alloc(0x110000), vram = v86 + 0xb8000;
const m = { u8: p.u8, v86, keys: [], m8: a => p.u8[v86 + a], m16: a => p.u8[v86 + a] | p.u8[v86 + a + 1] << 8 };
p.u8[v86 + 0x449] = 3; p.u8[v86 + 0x44a] = 80; p.u8[v86 + 0x484] = 24;
const line = 'Press any key to continue . . .';
for (let i = 0; i < 2000; i++) { p.u8[vram + 2 * i] = 0x20; p.u8[vram + 2 * i + 1] = 7; }
[...line].forEach((c, i) => { p.u8[vram + 24 * 160 + 2 * i] = c.charCodeAt(0); });
const vm = { cb: 0x5000, m, id: 2 };
p.vmOf = h => (h === vm.cb ? vm : h === 1 ? { cb: 1, sys: true } : null);

// the grabber's call: AX the function, EAX's high word left as it was (3DF7h), EBX the VM, ES:DI its buffer
const buf = 0x8000, vdd = (fn, hi = 0x3df7) => {
  p.cpu.eax.value = (hi << 16 | fn) >>> 0; p.cpu.ebx.value = vm.cb; p.cpu.es.value = 0; p.cpu.edi.value = buf; p.cpu.cf.value = 0;
  p.cpu.ssb = reg(0); p.cpu.esp = reg(0x7000); p.w16(0x7000, 0); p.w16(0x7002, 0);   // (the far return)
  p.retf16 = () => 0; K16['VDD.#0'][2].call(p);
};

// 2: the video state, answered though EAX's high word is not 0
p.u8.fill(0xee, buf, buf + 0x28); vdd(2);
assert.equal(p.u8[buf], 3, 'mode 3'); assert.equal(p.u8[buf + 3], 25, '25 rows'); assert.equal(p.r16(buf + 0x1c), 80, '80 columns');

// 1: plane 0 is a copy of the screen, not the VM's own; no shadow at +4
vdd(1);
const plane0 = p.r32(buf);
assert.notEqual(plane0, vram, 'not the VM\'s screen');
assert.equal(String.fromCharCode(...p.u8.subarray(plane0 + 24 * 160, plane0 + 24 * 160 + 2 * line.length).filter((_, i) => !(i & 1))), line, 'the screen as it is');
p.u8.fill(0, plane0, plane0 + 0x8000);   // (what the grabber's row clearing does to what it is given)
assert.equal(p.u8[vram + 24 * 160], 'P'.charCodeAt(0), 'the VM\'s own screen kept');
assert.equal(p.r32(buf + 4), 0, 'no shadow: every cell drawn');

// 1: the colors, as VGAFULL 1:1913 reads them, a COLORREF for each attribute nibble through the palette registers
const pal = p.r32(buf + 0x24); assert.ok(pal, 'a color table');
vdd(2); const palRegs = [...p.u8.subarray(buf + 0xc, buf + 0x1c)];
const color = nibble => { const e = p.r32(pal + 4 * palRegs[nibble]) & 0xff; return ((p.r32(pal + 4 * e) >>> 6) & 0xfcfcfc) >>> 0; };
assert.equal(color(7), 0xa8a8a8, 'attribute 7: light gray'); assert.equal(color(0), 0, '0: black');
assert.equal(color(1), 0xa80000, '1: blue (COLORREF 00BBGGRR)'); assert.equal(color(4), 0x0000a8, '4: red');
assert.equal(color(15), 0xfcfcfc, '15: white');

// 3: the whole screen each time, also after 4 took the changes: a repaint of the erased window draws it all again
vdd(3); assert.equal(p.r16(buf), 8, 'first look: the whole screen');
vdd(4); vdd(3); assert.equal(p.r16(buf), 8, 'after 4, a repaint: the whole screen again');
// the wake for a change (41Ah) still only when the screen changed since 4
let posted = 0; p.vxdService = () => 1; p.vxdCall = () => { posted++; return { eax: 0 }; }; p.vmClientIdle = () => 0;
vm.dispPosted = 0; p.vmDisplayEvent(vm); assert.equal(posted, 0, 'unchanged: no wake');
p.u8[vram] = 0x41; vm.dispPosted = 0; p.vmDisplayEvent(vm); assert.equal(posted, 1, 'changed: woken');

// VKD 1: the key typed into the window to that VM's keyboard (scan code in CH, character in CL), carry clear
p.cpu.eax.value = 1; p.cpu.ebx.value = vm.cb; p.cpu.ecx.value = 0x1c0d; p.cpu.cf.value = 1;
p.cpu.ssb = reg(0); p.cpu.esp = reg(0x7000); p.retf16 = () => 0; p.vxdApiRoute = null;
K16['VXD.#13'][2].call(p);
assert.deepEqual(m.keys, [0x1c0d], 'Enter queued for the VM'); assert.equal(p.cpu.cf.value, 0, 'taken');
// the VM's program ends (the key pressed at "Press any key"): its machine is gone, and the grabber's last repaints get
// the last screen, its colors and its state, every field written (left as they were, the grabber took the stack's
// garbage for the memory's address and wrote out of bounds)
vdd(1); vdd(2);   // (the last grab before the end)
vm.m = null; vm.gone = true;
p.u8.fill(0xcc, buf, buf + 0x28); vdd(1);
assert.equal(p.r32(buf), plane0, 'the last screen'); assert.equal(p.r32(buf + 4), 0, 'no shadow'); assert.equal(p.r32(buf + 0x24), pal, 'its colors');
assert.equal(String.fromCharCode(p.u8[plane0 + 24 * 160]), 'P', 'as it was');
p.u8.fill(0xcc, buf, buf + 0x20); vdd(2);
assert.equal(p.u8[buf], 3, 'mode 3'); assert.equal(p.u8[buf + 3], 25, '25 rows'); assert.equal(p.r16(buf + 0x1c), 80, '80 columns');
p.u8.fill(0xcc, buf, buf + 4); vdd(3); assert.equal(p.r16(buf), 8, 'the whole screen to draw');
console.log('vddgrab: ok');
