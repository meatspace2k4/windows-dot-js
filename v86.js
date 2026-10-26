'use strict';
// A virtual-8086 machine: what Windows 95 runs MS-DOS programs in. Its first megabyte (and the 64K past it) lives at a
// linear address of its own (V86_BASE, as Windows keeps a VM's memory at its high linear address), and its code runs
// through the run-time translator in V86 mode (dyn.js): a segment's base is 16 times its value, INT goes through the
// machine's own vectors at 0:0. What runs there is the CD's own: the boot sector SYS.COM writes, IO.SYS (WINBOOT.SYS),
// COMMAND.COM and the programs. The PC under them is the host's (as sound.js and parallel.js are): the BIOS, whose ROM
// calls the host (0F FF n, then IRET), the timer and keyboard interrupts, the text screen at B800h and a hard disk.
(() => {
const { Process } = window.W95Win32;
const P = Object.create(Process.prototype);   // (a V86 machine's own methods, over the processor's: Process itself unchanged)
const u32 = v => v >>> 0;
const V86_BASE = 0x00400000, ROM = 0xf0000, STUB = 0x1000;   // the vectors' stubs at F000:1000 + 4n
const CPU = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
  'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if'];
const SEGS = [['es', 'esb'], ['cs', 'csb'], ['ss', 'ssb'], ['ds', 'dsb'], ['fsel', 'fs'], ['gsel', 'gsb']];

/** a machine: its memory (a WebAssembly.Memory, 128 MB), its disk (a Uint8Array of 512-byte sectors, the boot
 *  partition from sector 0) and what it does with its screen and keyboard (o.screen(), o.idle()) */
function machine(o = {}) {
  const p = Object.create(P);
  p.mem = o.mem || new WebAssembly.Memory({ initial: 2048, maximum: 2048 });
  Object.defineProperty(p, 'u8', { value: new Uint8Array(p.mem.buffer) });
  Object.defineProperty(p, 'dv', { value: new DataView(p.mem.buffer) });
  p.cpu = {}; for (const n of CPU) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
  p.v86 = V86_BASE; p.disk = o.disk; p.geom = { heads: 16, spt: 63 }; p.o = o;
  p.keys = []; p.port60 = 0; p.irq = 0; p.ticksAt = Date.now(); p.halted = false; p.polls = 0; p.v86Hooks = new Set([0x21]);
  p.trap = function (next, code) { this.v86Trap(next, code); };
  p.portIO = function (port, size, isIn) { this.v86Port(port, size, isIn); };
  p.v86Reset();
  return p;
}
const M = { machine, V86_BASE };

// ---------------------------------------------------------------- memory, in the machine's own addresses
P.lin = function (seg, off) { return this.v86 + (((seg & 0xffff) << 4) + (off & 0xffff)); };
P.m8 = function (a) { return this.u8[this.v86 + a]; };
P.m16 = function (a) { return this.dv.getUint16(this.v86 + a, true); };
P.s8 = function (a, v) { this.u8[this.v86 + a] = v; };
P.s16 = function (a, v) { this.dv.setUint16(this.v86 + a, v & 0xffff, true); };
P.s32 = function (a, v) { this.dv.setUint32(this.v86 + a, v >>> 0, true); };
const R16 = { ax: 'eax', bx: 'ebx', cx: 'ecx', dx: 'edx', si: 'esi', di: 'edi', bp: 'ebp', sp: 'esp' };
P.r = function (n) { return this.cpu[R16[n]].value & 0xffff; };
P.w = function (n, v) { const c = this.cpu[R16[n]]; c.value = (c.value & 0xffff0000) | (v & 0xffff); };
P.ah = function () { return (this.cpu.eax.value >> 8) & 0xff; };
P.al = function () { return this.cpu.eax.value & 0xff; };
P.setAH = function (v) { this.cpu.eax.value = (this.cpu.eax.value & ~0xff00) | ((v & 0xff) << 8); };
P.setAL = function (v) { this.cpu.eax.value = (this.cpu.eax.value & ~0xff) | (v & 0xff); };
P.sreg = function (s, v) { const b = SEGS.find(x => x[0] === s)[1]; this.cpu[s].value = v & 0xffff; this.cpu[b].value = this.v86 + ((v & 0xffff) << 4); };
// the FLAGS word an interrupt pushed (at SS:SP+4 inside the BIOS's handler): what IRET gives back, so CF and ZF the
// handler answers with are set there
P.stackFlags = function () { return this.lin(this.cpu.ss.value, (this.cpu.esp.value + 4) & 0xffff) - this.v86; };
P.retCF = function (on) { const a = this.stackFlags(); this.s16(a, (this.m16(a) & ~1) | (on ? 1 : 0)); };
P.retZF = function (on) { const a = this.stackFlags(); this.s16(a, (this.m16(a) & ~0x40) | (on ? 0x40 : 0)); };

// ---------------------------------------------------------------- the PC at power-on
P.v86Reset = function () {
  this.u8.fill(0, this.v86, this.v86 + 0x110000);
  // the vectors: each to its stub in the ROM (0F FF n: the host's service, then IRET)
  for (let n = 0; n < 256; n++) {
    this.s16(n * 4, STUB + n * 4); this.s16(n * 4 + 2, ROM >> 4);
    const at = ROM + STUB + n * 4; this.s8(at, 0x0f); this.s8(at + 1, 0xff); this.s8(at + 2, n); this.s8(at + 3, 0xcf);
  }
  // INT 08h, the timer: the tick counted, INT 1Ch (a program's), the interrupt controller told it is done
  const t8 = [0x0f, 0xff, 0x08, 0xcd, 0x1c, 0x50, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf];
  t8.forEach((b, i) => this.s8(ROM + 0x2000 + i, b)); this.s16(8 * 4, 0x2000);
  // the BIOS data area
  this.s16(0x410, 0x0021); this.s16(0x413, 640);                        // equipment: 80x25 colour; 640K
  this.s16(0x41a, 0x1e); this.s16(0x41c, 0x1e); this.s16(0x480, 0x1e); this.s16(0x482, 0x3e);   // the keyboard buffer
  this.s8(0x449, 3); this.s16(0x44a, 80); this.s16(0x44c, 4096); this.s16(0x463, 0x3d4); this.s8(0x484, 24); this.s16(0x485, 16);
  this.s8(0x475, 1);                                                      // one hard disk
  this.s8(0x465, 0x29); this.s16(0x460, 0x0607);                          // the cursor's shape
  this.s8(ROM + 0xfffe, 0xfc);                                            // the model: an AT
  for (let i = 0; i < 4000; i += 2) { this.s8(0xb8000 + i, 0x20); this.s8(0xb8001 + i, 0x07); }
  this.cpu.if.value = 1;
};
/** INT 19h and the master boot record's work, as the BIOS's last step: the active partition's first sector at 0:7C00h,
 *  and on there with DL the drive and DS:SI its entry in the partition table (kept at 0:0600h, where the MBR moves itself) */
P.v86Boot = function () {
  this.u8.set(this.disk.subarray(0, 512), this.v86 + 0x600);
  let e = 0x7be; for (let i = 0; i < 4; i++) if (this.m8(0x7be + i * 16) === 0x80) { e = 0x7be + i * 16; break; }
  const lba = this.dv.getUint32(this.v86 + e + 8, true);
  this.u8.set(this.disk.subarray(lba * 512, lba * 512 + 512), this.v86 + 0x7c00);
  this.sreg('cs', 0); this.sreg('ds', 0); this.sreg('es', 0); this.sreg('ss', 0); this.cpu.esp.value = 0x7c00;
  this.cpu.edx.value = 0x80; this.cpu.esi.value = e; this.cpu.eip.value = this.v86 + 0x7c00;
};

// ---------------------------------------------------------------- running
/** run up to `n` blocks; 'idle' when the machine waits (HLT, a key), 'trap' with this.trapped set when it faulted */
P.v86Run = function (n = 20000) {
  let eip = u32(this.cpu.eip.value);
  for (let k = 0; k < n; k++) {
    this.cpu.eip.value = eip; this.v86Interrupts();   // (an interrupt pushes where the code is now)
    if (this.halted) { this.cpu.eip.value = eip; return 'idle'; }
    if (this.irqTaken) { this.irqTaken = false; eip = u32(this.cpu.eip.value); }
    const blk = this.dynBlock(eip);
    if (!blk) { this.cpu.eip.value = eip; return 'trap'; }
    try { eip = u32(blk.run()); }
    catch (e) { if (!(e instanceof WebAssembly.RuntimeError)) throw e; this.trapped = `${e.message} at ${(eip - this.v86).toString(16)}`; return 'trap'; }
    if (this.halted) { this.cpu.eip.value = eip; return 'idle'; }
    if (eip === this.boxReturn) { this.cpu.eip.value = eip; this.exited = true; return 'exit'; }   // (the box's program has ended)
  }
  this.cpu.eip.value = eip; return 'run';
};
// the hardware's interrupts, between blocks while IF is set: the timer's (IRQ 0, INT 08h, 18.2 a second) and the
// keyboard's (IRQ 1, INT 09h)
P.v86Interrupts = function () {
  const now = Date.now();
  if (now - this.ticksAt >= 55) { this.ticksAt = now; this.irq |= 1; }
  if (this.keys.length && !(this.irq & 2) && !this.kbdBusy) { const k = this.keys.shift(); this.port60Key = k; this.port60 = k >> 8; this.irq |= 2; this.kbdBusy = true; }   // (a key: its scan code << 8 | its character)
  if (!this.irq || !this.cpu.if.value) return;
  const n = this.irq & 1 ? 0 : 1; this.irq &= ~(1 << n);
  this.halted = false;
  this.v86Int(8 + n);
};
/** a real-mode interrupt delivered by the host: FLAGS, CS, IP pushed, IF cleared, on at the vector */
P.v86Int = function (n) {
  const c = this.cpu, push = v => { c.esp.value = (c.esp.value & 0xffff0000) | ((c.esp.value - 2) & 0xffff); this.dv.setUint16(this.lin(c.ss.value, c.esp.value), v, true); };
  const flags = (c.cf.value & 1) | ((c.pf.value & 1) << 2) | ((c.zf.value & 1) << 6) | ((c.sf.value & 1) << 7) | ((c.if.value & 1) << 9) | ((c.df.value & 1) << 10) | ((c.of.value & 1) << 11) | 2 | (this.m16(0x110000) & 0x7000);
  push(flags); push(c.cs.value); push(u32(c.eip.value) - u32(c.csb.value));
  c.if.value = 0;
  this.sreg('cs', this.m16(n * 4 + 2)); c.eip.value = u32(c.csb.value) + this.m16(n * 4);
  this.irqTaken = true;
};
// a call from the ROM (0F FF n) or HLT: the BIOS's service n, then on at `next` (the IRET after it)
P.v86Trap = function (next, code) {
  this.cpu.eip.value = next;
  if (code === 0x300) { if (!this.irq && !this.keys.length) this.halted = true; return; }
  if (code >= 0x400) { const h = HOOK[code - 0x400]; if (h && h.call(this, next)) this.s16(0x110002, 1); return; }   // (taken: the code goes on at eip)
  const n = code - 0x200, f = BIOS[n];
  if (f) f.call(this, next); else if (n >= 0x08 && n <= 0x0f || n >= 0x70 && n <= 0x77) this.v86Port(0x20, 1, false, 0x20);
};

// ---------------------------------------------------------------- what the VMM sees first (Hook_V86_Int_Chain)
const HOOK = {};
// INT 21h: the boot's shell running C:\WINDOWS\WIN.COM is Windows starting, where the VMM takes the machine over: the
// box's program (COMMAND.COM, or what it was asked to run) is run in its place, from the DOS the machine booted, as
// Windows runs a DOS box's program in a VM made from the DOS it started from; its return there ends the box
HOOK[0x21] = function (next) {
  if (this.ah() !== 0x4b || this.al() !== 0 || this.boxReturn) return false;
  const s = this.lin(this.cpu.ds.value, this.r('dx')) - this.v86; let name = '';
  for (let i = 0; i < 128 && this.m8(s + i); i++) name += String.fromCharCode(this.m8(s + i));
  if (!/(^|\\)WIN\.COM$/i.test(name)) return false;
  const prog = this.o.program || 'C:\\COMMAND.COM', tail = this.o.args ? ` ${this.o.args}` : '';
  [...prog].forEach((c, i) => this.s8(ROM + 0x3000 + i, c.charCodeAt(0))); this.s8(ROM + 0x3000 + prog.length, 0);
  this.s8(ROM + 0x3100, tail.length); [...tail].forEach((c, i) => this.s8(ROM + 0x3101 + i, c.charCodeAt(0))); this.s8(ROM + 0x3101 + tail.length, 13);
  this.sreg('ds', ROM >> 4); this.w('dx', 0x3000);
  const pb = this.lin(this.cpu.es.value, this.r('bx')) - this.v86; this.s16(pb + 2, 0x3100); this.s16(pb + 4, ROM >> 4);
  this.boxReturn = next;
  return false;
};

// ---------------------------------------------------------------- the ports
P.v86Port = function (port, size, isIn, val) {
  const c = this.cpu;
  if (!isIn) return;   // (the interrupt controller's EOI, the timer's programming, the CRTC's cursor: the host keeps its own)
  let v = 0xff;
  if (port === 0x60) { v = this.port60; this.kbdBusy = false; }
  else if (port === 0x64) v = this.kbdBusy ? 0x1d : 0x1c;
  else if (port === 0x3da) v = (this.retrace = (this.retrace || 0) ^ 9);
  else if (port === 0x21 || port === 0xa1) v = 0;
  else if (port === 0x61) v = (this.p61 = (this.p61 || 0) ^ 0x10);
  else if (port === 0x71) v = 0;
  const m = size === 1 ? 0xff : size === 2 ? 0xffff : -1;
  c.eax.value = (c.eax.value & ~m) | (v & m);
  void val;
};

// ---------------------------------------------------------------- the BIOS
const bcd = v => ((v / 10) | 0) << 4 | (v % 10);
const BIOS = {};
BIOS[0x08] = function () { this.s32(0x46c, this.dv.getUint32(this.v86 + 0x46c, true) + 1); };   // the tick (INT 1Ch and the EOI follow in the ROM)
BIOS[0x09] = function () {   // the keyboard: the key read from port 60h into the buffer (a scan code and its character)
  const k = this.port60Key; this.kbdBusy = false;
  if (k) { const t = this.m16(0x41c), nt = t + 2 >= this.m16(0x482) ? this.m16(0x480) : t + 2; if (nt !== this.m16(0x41a)) { this.s16(0x400 + t, k); this.s16(0x41c, nt); } }
};
BIOS[0x11] = function () { this.w('ax', this.m16(0x410)); };
BIOS[0x12] = function () { this.w('ax', this.m16(0x413)); };
BIOS[0x10] = function () { video.call(this); };
BIOS[0x13] = function () { disk.call(this); };
BIOS[0x14] = function () { this.w('ax', 0); };
BIOS[0x15] = function () {
  const ah = this.ah();
  if (ah === 0x88) { this.w('ax', 0); this.retCF(false); return; }            // no extended memory
  if (ah === 0x4f) { this.retCF(true); return; }                              // the keyboard intercept: the key kept
  if (ah === 0xc0) { this.sreg('es', ROM >> 4); this.w('bx', 0xe6f5); this.setAH(0); this.retCF(false); return; }
  this.setAH(0x86); this.retCF(true);
};
BIOS[0x16] = function (next) {   // the keyboard: read (waiting), status, shift state
  const ah = this.ah() & 0xef, h = this.m16(0x41a), t = this.m16(0x41c);
  if (ah === 0x00) {
    if (h === t) { this.cpu.eip.value = next - 3; this.cpu.if.value = 1; this.halted = true; return; }   // (the call again once a key comes)
    this.w('ax', this.m16(0x400 + h)); this.s16(0x41a, h + 2 >= this.m16(0x482) ? this.m16(0x480) : h + 2); return;
  }
  // (a program polling an empty buffer is idle, as the VMM takes keyboard polling: the machine waits for the next
  // interrupt instead of spinning)
  if (ah === 0x01) { this.retZF(h === t); if (h !== t) { this.polls = 0; this.w('ax', this.m16(0x400 + h)); } else if (++this.polls >= 20) { this.polls = 0; this.halted = true; } return; }
  if (ah === 0x02) { this.setAL(this.m8(0x417)); return; }
  if (ah === 0x05) { const nt = t + 2 >= this.m16(0x482) ? this.m16(0x480) : t + 2; if (nt === h) { this.setAL(1); return; } this.s16(0x400 + t, this.r('cx')); this.s16(0x41c, nt); this.setAL(0); return; }
};
BIOS[0x17] = function () { this.setAH(0x90); };
BIOS[0x28] = function () { if (++this.polls >= 20) { this.polls = 0; this.halted = true; } };   // DOS idle (its default handler, kept as an IRET)
BIOS[0x18] = function () { this.trapped = 'no system to boot (INT 18h)'; this.halted = true; };
BIOS[0x19] = function () { this.v86Boot(); };
BIOS[0x1a] = function () {
  const ah = this.ah(), d = new Date();
  if (ah === 0x00) { const t = this.dv.getUint32(this.v86 + 0x46c, true); this.w('cx', t >>> 16); this.w('dx', t); this.setAL(0); return; }
  if (ah === 0x02) { this.w('cx', (bcd(d.getHours()) << 8) | bcd(d.getMinutes())); this.w('dx', bcd(d.getSeconds()) << 8); this.retCF(false); return; }
  if (ah === 0x04) { const y = d.getFullYear(); this.w('cx', (bcd((y / 100) | 0) << 8) | bcd(y % 100)); this.w('dx', (bcd(d.getMonth() + 1) << 8) | bcd(d.getDate())); this.retCF(false); return; }
  this.retCF(true);
};
// the clock's ticks since midnight, as the BIOS counts them, set at power-on
P.v86Clock = function () { const d = new Date(), s = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); this.s32(0x46c, Math.floor(s * 18.2065)); };

// ---- INT 10h: the text screen (mode 3, 80 x 25 at B800h; one page)
function video() {
  const ah = this.ah(), cols = 80, rows = 25;
  const cur = () => [this.m8(0x451), this.m8(0x450)];   // row, column
  const setCur = (r, c) => { this.s8(0x450, c); this.s8(0x451, r); };
  const cell = (r, c) => 0xb8000 + (r * cols + c) * 2;
  const scroll = (n, top, left, bot, right, attr, up) => {
    const h = bot - top + 1;
    if (!n || n >= h) { for (let r = top; r <= bot; r++) for (let c = left; c <= right; c++) { this.s8(cell(r, c), 0x20); this.s8(cell(r, c) + 1, attr); } return; }
    for (let i = 0; i < h - n; i++) { const dst = up ? top + i : bot - i, src = up ? top + i + n : bot - i - n; for (let c = left; c <= right; c++) this.s16(cell(dst, c), this.m16(cell(src, c))); }
    for (let i = 0; i < n; i++) { const r = up ? bot - i : top + i; for (let c = left; c <= right; c++) { this.s8(cell(r, c), 0x20); this.s8(cell(r, c) + 1, attr); } }
  };
  const tty = ch => {
    let [r, c] = cur();
    if (ch === 13) c = 0; else if (ch === 10) r++; else if (ch === 8) { if (c) c--; } else if (ch === 7) { /* the bell */ }
    else { this.s8(cell(r, c), ch); if (++c >= cols) { c = 0; r++; } }
    if (r >= rows) { scroll(1, 0, 0, rows - 1, cols - 1, this.m8(cell(rows - 1, cols - 1) + 1) || 7, true); r = rows - 1; }
    setCur(r, c);
  };
  this.dirty = true;
  switch (ah) {
    case 0x00: scroll(0, 0, 0, rows - 1, cols - 1, 7, true); setCur(0, 0); this.s8(0x449, 3); return;
    case 0x01: this.s16(0x460, this.r('cx')); return;
    case 0x02: setCur((this.cpu.edx.value >> 8) & 0xff, this.cpu.edx.value & 0xff); return;
    case 0x03: { const [r, c] = cur(); this.w('dx', (r << 8) | c); this.w('cx', this.m16(0x460)); return; }
    case 0x05: return;
    case 0x06: case 0x07: { const cx = this.r('cx'), dx = this.r('dx'); scroll(this.al(), cx >> 8, cx & 0xff, Math.min(dx >> 8, rows - 1), Math.min(dx & 0xff, cols - 1), this.cpu.ebx.value >> 8 & 0xff, ah === 6); return; }
    case 0x08: { const [r, c] = cur(); this.w('ax', this.m16(cell(r, c))); return; }
    case 0x09: case 0x0a: { const [r, c] = cur(); let n = this.r('cx'); for (let i = 0; i < n && c + i < cols * rows; i++) { const a = cell(r, c) + i * 2; this.s8(a, this.al()); if (ah === 9) this.s8(a + 1, this.cpu.ebx.value & 0xff); } return; }
    case 0x0e: tty(this.al()); return;
    case 0x0f: this.w('ax', (cols << 8) | 3); this.cpu.ebx.value &= ~0xff00; return;
    case 0x12: if ((this.cpu.ebx.value & 0xff) === 0x10) this.w('bx', 0x0003); return;   // EGA information: colour, 256K
    case 0x1a: if (this.al() === 0) { this.setAL(0x1a); this.w('bx', 0x0008); } return;   // the display: VGA with a colour monitor
    case 0x13: { const s = this.lin(this.cpu.es.value, this.r('bp')) - this.v86, n = this.r('cx'), dx = this.r('dx'); setCur(dx >> 8, dx & 0xff); for (let i = 0; i < n; i++) tty(this.m8(s + i)); return; }
    default:
  }
}

// ---- INT 13h: the hard disk (80h; the boot partition from its first sector), in 16 heads of 63 sectors
function disk() {
  const ah = this.ah(), dl = this.cpu.edx.value & 0xff, d = this.disk, nsec = d ? d.length >> 9 : 0, { heads, spt } = this.geom;
  const ok = () => { this.setAH(0); this.retCF(false); }, bad = (e = 1) => { this.setAH(e); this.retCF(true); };
  if (dl !== 0x80 || !d) { bad(dl < 0x80 ? 0x80 : 1); return; }
  const xfer = (lba, n, buf, write) => {
    if (lba + n > nsec) return false;
    const mem = this.v86 + buf;
    if (write) d.set(this.u8.subarray(mem, mem + n * 512), lba * 512); else this.u8.set(d.subarray(lba * 512, (lba + n) * 512), mem);
    return true;
  };
  switch (ah) {
    case 0x00: ok(); return;
    case 0x02: case 0x03: {
      const cx = this.r('cx'), cyl = ((cx & 0xc0) << 2) | (cx >> 8), sec = cx & 0x3f, head = (this.cpu.edx.value >> 8) & 0xff, n = this.al();
      const lba = (cyl * heads + head) * spt + sec - 1;
      if (xfer(lba, n, this.lin(this.cpu.es.value, this.r('bx')) - this.v86, ah === 3)) ok(); else bad(4);
      return;
    }
    case 0x08: { const cyls = Math.ceil(nsec / (heads * spt)) - 1; this.w('cx', ((cyls & 0xff) << 8) | ((cyls >> 2) & 0xc0) | spt); this.w('dx', ((heads - 1) << 8) | 1); ok(); return; }
    case 0x15: this.setAH(3); this.w('cx', nsec >>> 16); this.w('dx', nsec); this.retCF(false); return;
    case 0x41: if (this.r('bx') === 0x55aa) { this.w('bx', 0xaa55); this.setAH(0x21); this.w('cx', 1); this.retCF(false); } else bad(); return;
    case 0x42: case 0x43: {   // the extended read and write: a packet at DS:SI (its count, its buffer, its sector)
      const pk = this.lin(this.cpu.ds.value, this.r('si')) - this.v86, n = this.m16(pk + 2), buf = this.lin(this.m16(pk + 6), this.m16(pk + 4)) - this.v86, lba = this.dv.getUint32(this.v86 + pk + 8, true);
      if (xfer(lba, n, buf, ah === 0x43)) ok(); else bad(4);
      return;
    }
    case 0x48: { const pk = this.lin(this.cpu.ds.value, this.r('si')) - this.v86; this.s16(pk + 2, 0); this.s32(pk + 4, Math.ceil(nsec / (heads * spt))); this.s32(pk + 8, heads); this.s32(pk + 12, spt); this.s32(pk + 16, nsec); this.s32(pk + 20, 0); this.s16(pk + 24, 512); ok(); return; }
    default: bad();
  }
}

// ---------------------------------------------------------------- the boot disk: FAT16, as FORMAT and SYS leave it
/** a FAT16 volume of `mb` megabytes holding `files` ([{ name: '8.3', data, attr }], in the root, in that order: IO.SYS
 *  and MSDOS.SYS first, as the boot sector looks for them), with the boot sector `boot` (512 bytes, SYS.COM's), its BPB
 *  filled in */
M.fat16 = function (boot, files, mb = 16) {
  // the disk: its partition table (one FAT16 partition, active, from sector 63, as FDISK leaves it), then the volume
  const HID = 63, total = mb * 2048, disk = new Uint8Array((HID + total) * 512), pt = 0x1be, ddv = new DataView(disk.buffer);
  disk[pt] = 0x80; disk[pt + 4] = total < 65536 ? 0x04 : 0x06; ddv.setUint32(pt + 8, HID, true); ddv.setUint32(pt + 12, total, true);
  disk[pt + 1] = 1; disk[pt + 2] = 1; disk[pt + 3] = 0; disk[pt + 5] = 15; disk[pt + 6] = 0xff; disk[pt + 7] = 0xff;   // (CHS: 0/1/1 to the last, as large)
  disk[510] = 0x55; disk[511] = 0xaa;
  const img = disk.subarray(HID * 512);
  const SPC = 4, RES = 1, NFAT = 2, ROOT = 512, dv = new DataView(img.buffer, img.byteOffset);
  const clusters = Math.ceil(total / SPC), fatSecs = Math.ceil((clusters + 2) * 2 / 512), rootSecs = ROOT * 32 / 512;
  const fat0 = RES, root0 = fat0 + NFAT * fatSecs, data0 = root0 + rootSecs;
  img.set(boot.subarray(0, 512), 0);
  dv.setUint16(11, 512, true); img[13] = SPC; dv.setUint16(14, RES, true); img[16] = NFAT; dv.setUint16(17, ROOT, true);
  dv.setUint16(19, total < 65536 ? total : 0, true); img[21] = 0xf8; dv.setUint16(22, fatSecs, true); dv.setUint16(24, 63, true); dv.setUint16(26, 16, true);
  dv.setUint32(28, HID, true); dv.setUint32(32, total < 65536 ? 0 : total, true); img[36] = 0x80; img[38] = 0x29; dv.setUint32(39, 0x19951995, true);
  img.set([...'NO NAME    FAT16   '].map(c => c.charCodeAt(0)), 43);
  const fat = (n, v) => { for (let k = 0; k < NFAT; k++) dv.setUint16((fat0 + k * fatSecs) * 512 + n * 2, v, true); };
  fat(0, 0xfff8); fat(1, 0xffff);
  let next = 2;
  const now = new Date(), dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const name83 = s => { if (s === '.' || s === '..') return s.padEnd(11); const [b, e = ''] = s.toUpperCase().split('.'); return (b.padEnd(8) + e.padEnd(3)).slice(0, 11); };
  const alloc = bytes => { const n = Math.max(1, Math.ceil(bytes / (SPC * 512))), first = next; for (let i = 0; i < n; i++) fat(next + i, i === n - 1 ? 0xffff : next + i + 1); next += n; return first; };
  const at = cl => (data0 + (cl - 2) * SPC) * 512;
  // a folder: its entries at `base` (the root's sectors, or a cluster of its own), each file's clusters after
  const dirs = new Map([['', { base: root0 * 512, n: 0, cl: 0 }]]);
  const entry = (dir, n83, attr, cl, size) => {
    const d = dirs.get(dir), de = d.base + d.n++ * 32;
    img.set([...n83].map(c => c.charCodeAt(0)), de); img[de + 11] = attr;
    dv.setUint16(de + 22, dtime, true); dv.setUint16(de + 24, ddate, true); dv.setUint16(de + 26, cl, true); dv.setUint32(de + 28, size, true);
  };
  const folder = path => {
    if (dirs.has(path)) return;
    const up = path.includes('\\') ? path.slice(0, path.lastIndexOf('\\')) : ''; folder(up);
    const cl = alloc(SPC * 512); dirs.set(path, { base: at(cl), n: 0, cl });
    entry(up, name83(path.slice(path.lastIndexOf('\\') + 1)), 0x10, cl, 0);
    entry(path, name83('.'), 0x10, cl, 0); entry(path, name83('..'), 0x10, dirs.get(up).cl, 0);
  };
  for (const f of files) {
    const path = (f.path || f.name).toUpperCase(), up = path.includes('\\') ? path.slice(0, path.lastIndexOf('\\')) : '';
    folder(up);
    const cl = f.data.length ? alloc(f.data.length) : 0;
    if (cl) img.set(f.data, at(cl));
    entry(up, name83(path.slice(path.lastIndexOf('\\') + 1)), f.attr || 0x20, cl, f.data.length);
  }
  return disk;
};

window.W95V86 = M;
})();
