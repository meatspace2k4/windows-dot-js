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
// (the prototype under a name of its own: a moment arrived at in another page makes its VMs' machines anew by the
// name their prototype's constructor has (braid.js rebind, worker.js 'import' protos); as Process's they got Process's
// methods and none of these, and the VM ran nothing)
function V86Machine() {}
V86Machine.prototype = P; P.constructor = V86Machine;
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
  // (o.base: where its first megabyte is, in a memory shared with Windows' VMM: a VM's at its CB_High_Linear; o.xmsKB
  // the extended memory it has past 120000h)
  p.v86 = o.base || V86_BASE; p.xmsKB = o.xmsKB || XMS.kb; p.disk = o.disk; p.geom = { heads: 16, spt: 63 }; p.o = o;
  p.keys = []; p.port60 = 0; p.irq = 0; p.ticksAt = Date.now(); p.halted = false; p.polls = 0; p.v86Hooks = new Set([0x21, 0x2f]);
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
P.m32 = function (a) { return this.dv.getUint32(this.v86 + a, true); };
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
  [0x0f, 0xff, 0xfe].forEach((b, i) => this.s8(ROM + 0xfff0 + i, b));     // the reset vector, FFFF:0000 (the host's reset)
  // the diskette parameter table (a 1.44 MB drive's: step rate, head times, 512-byte sectors, 18 a track, gaps, fill,
  // settle and motor times), INT 1Eh's vector its address
  [0xaf, 0x02, 0x25, 0x02, 0x12, 0x1b, 0xff, 0x6c, 0xf6, 0x0f, 0x08].forEach((b, i) => this.s8(ROM + DPT + i, b));
  this.s16(0x1e * 4, DPT); this.s16(0x1e * 4 + 2, ROM >> 4);
  [0x0f, 0xff, 0xf8, 0xcb].forEach((b, i) => this.s8(ROM + XMS.entry + i, b));   // the XMS driver's entry: the host, then RETF
  this.xms = null;
  for (let i = 0; i < 4000; i += 2) { this.s8(0xb8000 + i, 0x20); this.s8(0xb8001 + i, 0x07); }
  this.cpu.if.value = 1;
};
/** INT 19h and the master boot record's work, as the BIOS's last step: the active partition's first sector at 0:7C00h,
 *  and on there with DL the drive and DS:SI its entry in the partition table (kept at 0:0600h, where the MBR moves itself) */
P.v86Boot = function () {
  // (a disk in drive A: first, as the BIOS's boot order has it: its boot sector at 0:7C00h, DL 00h)
  const fl = this.o.floppy && this.o.floppy.image;
  if (fl && fl[510] === 0x55 && fl[511] === 0xaa) {
    this.u8.set(fl.subarray(0, 512), this.v86 + 0x7c00); this.o.floppy.changed = false;
    this.sreg('cs', 0); this.sreg('ds', 0); this.sreg('es', 0); this.sreg('ss', 0); this.cpu.esp.value = 0x7c00;
    this.cpu.edx.value = 0x00; this.cpu.eip.value = this.v86 + 0x7c00; return;
  }
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
  if (this.conWait || this.winWait) return 'idle';   // (its EXEC waits for the Windows console program it started, conDone, or for Windows, winDone)
  let eip = u32(this.cpu.eip.value);
  for (let k = 0; k < n; k++) {
    this.cpu.eip.value = eip; this.v86Interrupts();   // (an interrupt pushes where the code is now)
    if (this.halted) { this.cpu.eip.value = eip; return 'idle'; }
    if (this.irqTaken) { this.irqTaken = false; eip = u32(this.cpu.eip.value); }
    if (this.conWait) { this.cpu.eip.value = eip; return 'idle'; }
    const blk = this.dynBlock(eip);
    if (!blk) { if (this.o.pc && this.vmm && this.vmmEnter(eip)) { this.trapped = null; return 'idle'; } this.cpu.eip.value = eip; return 'trap'; }
    try { eip = u32(blk.run()); }
    catch (e) { if (!(e instanceof WebAssembly.RuntimeError)) throw e; this.trapped = `${e.message} at ${(eip - this.v86).toString(16)}`; return 'trap'; }
    if (this.halted) { this.cpu.eip.value = eip; return 'idle'; }
    if (eip === this.nestReturn) { this.cpu.eip.value = eip; return 'nest'; }   // (an interrupt the VMM ran in it has returned: vmm.js vmIntV86)
    if (eip === this.boxReturn) { this.cpu.eip.value = eip; this.exited = true; return 'exit'; }   // (the box's program has ended)
    if (eip === this.want52) { this.want52 = 0; this.lol = this.lin(this.cpu.es.value, this.r('bx')) - this.v86; }   // (DOS's List of Lists, as INT 21h AH=52h answers)
  }
  this.cpu.eip.value = eip; return 'run';
};
// the hardware's interrupts, between blocks while IF is set: the timer's (IRQ 0, INT 08h, 18.2 a second) and the
// keyboard's (IRQ 1, INT 09h)
P.v86Interrupts = function () {
  const now = Date.now();
  if (now - this.ticksAt >= 55) { this.ticksAt = now; this.irq |= 1; }
  const queued = ((this.m16(0x41c) - this.m16(0x41a) + 32) % 32) >> 1;   // (the BIOS's buffer: keys wait in the host's while it is nearly full, none lost)
  if (this.keys.length && !(this.irq & 2) && !this.kbdBusy && queued < 12) { const k = this.keys.shift(); this.port60Key = k; this.port60 = k >> 8; this.irq |= 2; this.kbdBusy = true; }   // (a key: its scan code << 8 | its character)
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
  // the PC's own MS-DOS runs WIN.COM as it is; WIN.COM runs the VMM's file (Windows 95's VMM32.VXD, Windows 3.1's
  // WIN386.EXE), whose real-mode loader the host takes over from where it enters protected mode (vmmEnter). What it
  // will have changed by then is noted: the vectors as they were, the extended memory already given out
  if (this.o.pc) {
    if (/(^|\\)(VMM32\.VXD|WIN386\.EXE)$/i.test(name)) this.vmm = { path: name, ivt: this.u8.slice(this.v86, this.v86 + 1024), xms: new Set(this.xms ? this.xms.blocks.keys() : []) };
    return false;
  }
  if (!/(^|\\)WIN\.COM$/i.test(name)) return false;
  const prog = this.o.program || 'C:\\COMMAND.COM', tail = this.o.args ? ` ${this.o.args}` : '';
  [...prog].forEach((c, i) => this.s8(ROM + 0x3000 + i, c.charCodeAt(0))); this.s8(ROM + 0x3000 + prog.length, 0);
  this.s8(ROM + 0x3100, tail.length); [...tail].forEach((c, i) => this.s8(ROM + 0x3101 + i, c.charCodeAt(0))); this.s8(ROM + 0x3101 + tail.length, 13);
  this.sreg('ds', ROM >> 4); this.w('dx', 0x3000);
  const pb = this.lin(this.cpu.es.value, this.r('bx')) - this.v86; this.s16(pb + 2, 0x3100); this.s16(pb + 4, ROM >> 4);
  this.boxReturn = next;
  // (the box's window shows its program from a clear screen, as a DOS box opens: the boot's lines gone)
  for (let i = 0; i < 4000; i += 2) { this.s8(0xb8000 + i, 0x20); this.s8(0xb8001 + i, 0x07); }
  this.s8(0x450, 0); this.s8(0x451, 0); this.dirty = true;
  return false;
};

// ---------------------------------------------------------------- the drives Windows has: IFSMgr's part
// As IFSMgr takes the VM's drives over, the machine's C: and D: (and each drive Windows has) are DOS network drives
// whose calls come to the redirector interface (INT 2Fh AH=11h) and are answered from Windows' own file system
// (o.fs, fs.js): DOS routes every file call on them there, its own EXEC's reads among them. DOS's tables are found as
// DOS gives them: the List of Lists from INT 21h AH=52h (IO.SYS asks for it as it starts), its Swappable Data Area at
// 320h in the same segment (MS-DOS 5 and later); the drives are taken at the first EXEC, the shell's
/** DOS's List of Lists, by its NUL device (the header at 22h: the next driver's far pointer, attribute 8004h, the
 *  strategy and interrupt offsets, the name NUL padded to 8) in the first 64 KB of memory, as DOS 2 and later keep it */
const findLol = p => {
  const name = [0x4e, 0x55, 0x4c, 0x20, 0x20, 0x20, 0x20, 0x20];
  for (let a = 0x600; a < 0x10000; a++) {
    if (p.m8(a) !== 0x4e || name.some((c, i) => p.m8(a + i) !== c) || p.m16(a - 6) !== 0x8004) continue;
    const lol = a - 0x0a - 0x22; if (lol > 0x400 && (lol & 0xf) === 0x6) return lol;   // (DOS's data segment:0026h)
  }
  return 0;
};
const SDA = { DTA: 0x0c, FN1: 0x9e, FN2: 0x11e, SDB: 0x19e, DIRENT: 0x1b3, SATTR: 0x24d, XACTION: 0x2dd, XATTR: 0x2df, XMODE: 0x2e1 };
const HOOK21 = HOOK[0x21];
HOOK[0x21] = function (next) {
  if (this.ah() === 0x52 && !this.lol) this.want52 = next;   // (its answer, ES:BX, read as the call returns: v86Run)
  if (this.o.capture && this.boxReturn) this.captureOut();
  // (the drives taken as the shell is run, once DOS has its drive table from CONFIG.SYS: IO.SYS's own EXECs of
  // WINBOOT.SYS and IO.SYS come before it; the shell COMMAND.COM, or WIN.COM when there is no AUTOEXEC.BAT to run;
  // and again should DOS make the table anew). A DOS whose IO.SYS has not asked for the List of Lists by then (MS-DOS
  // 6's does not) has it found where DOS keeps it: its NUL device's header is part of it, at 22h
  if (!this.lol && this.o.fs && this.ah() === 0x4b && this.al() === 0) this.lol = findLol(this);
  if (this.lol && this.o.fs) {
    if (!this.drivesTaken && this.ah() === 0x4b && this.al() === 0 && /(COMMAND|WIN)\.COM$/i.test(ascii(this, this.lin(this.cpu.ds.value, this.r('dx')) - this.v86))) this.takeDrives();
    else if (this.drivesTaken && this.m32(this.lol + 0x16) !== this.cdsAt) this.takeDrives();
  }
  return HOOK21.call(this, next);
};
// A Windows program the box's DOS runs (EXEC of a PE or NE file) is Windows', as Windows 95 takes such an EXEC over:
// the host starts it (o.winExec), a console program with this machine as its console (its output written to the
// screen, the lines typed sent to it) and the EXEC waiting until it ends; a program with windows returns at once
const HOOK21W = HOOK[0x21];
HOOK[0x21] = function (next) {
  if (this.ah() === 0x4b && this.al() === 0 && this.boxReturn && this.o.winExec && this.o.fs) {
    const name = ascii(this, this.lin(this.cpu.ds.value, this.r('dx')) - this.v86); let f = null;
    try { f = this.o.fs.readFile(name); } catch (_) { /* DOS answers */ }
    const at = f && f.length > 0x40 && f[0] === 0x4d && f[1] === 0x5a ? (f[0x3c] | f[0x3d] << 8 | f[0x3e] << 16) : 0;   // (by the signature at the new header, as Windows' loader tells them)
    const kind = at && at + 0x5e < f.length ? (f[at] === 0x50 && f[at + 1] === 0x45 ? 'pe' : f[at] === 0x4e && f[at + 1] === 0x45 ? 'ne' : null) : null;
    if (kind) {
      const pb = this.lin(this.cpu.es.value, this.r('bx')) - this.v86, t = this.lin(this.m16(pb + 4), this.m16(pb + 2)) - this.v86;
      let tail = ''; for (let i = 0; i < this.m8(t); i++) tail += String.fromCharCode(this.m8(t + 1 + i));
      const cons = kind === 'pe' && (f[at + 24 + 68] | f[at + 24 + 69] << 8) === 3;   // (the CUI subsystem)
      const id = cons ? (this.conId = this.conId || `con${Math.random().toString(36).slice(2, 8)}`) : null;
      if (cons) { this.conWait = { id, line: '' }; this.halted = true; }
      this.o.winExec(this.o.fs.realpath(name), tail.trim(), id);
      this.cpu.cf.value = 0; this.w('ax', 0); return true;
    }
  }
  return HOOK21W.call(this, next);
};
/** what a console program writes, on the screen as the BIOS writes text (and kept, for a command run with no window) */
P.conWrite = function (s) {
  const ax = this.cpu.eax.value;
  for (const c of s) { this.cpu.eax.value = 0x0e00 | (c.charCodeAt(0) & 0xff); BIOS[0x10].call(this); }
  this.cpu.eax.value = ax;
  if (this.o.capture) { this.out = (this.out || '') + s; if (this.out.length > 200000) this.out = this.out.slice(-150000); }
};
/** a key typed while a console program has the box: the line edited as a console's line input does (echoed), and sent
 *  with Enter (o.conIn); false when no program has it */
P.conKey = function (k) {
  const w = this.conWait; if (!w) return false;
  const ch = k & 0xff, mode = w.mode === undefined ? 7 : w.mode, echo = mode & 4;
  if (!(mode & 2)) { if (ch) { if (echo) this.conWrite(ch === 13 ? '\r\n' : String.fromCharCode(ch)); this.o.conIn(w.id, ch === 13 ? '\r\n' : String.fromCharCode(ch)); } return true; }   // (raw: each key as it comes)
  if (ch === 13) { if (echo) this.conWrite('\r\n'); const l = w.line; w.line = ''; this.o.conIn(w.id, `${l}\n`); }
  else if (ch === 8) { if (w.line) { w.line = w.line.slice(0, -1); if (echo) this.conWrite('\b \b'); } }
  else if (ch >= 32) { w.line += String.fromCharCode(ch); if (echo) this.conWrite(String.fromCharCode(ch)); }
  return true;
};
/** the console program has ended: the EXEC that waited for it returns */
P.conDone = function () { this.conWait = null; this.halted = false; };
/** the VMM's loader entering protected mode (MOV to or from CR0 or CR3, LGDT, LIDT, LMSW at `eip`): Windows starts on
 *  the host (o.windows, the VMM's file), the machine waiting in the loader until Windows ends (winDone) */
P.vmmEnter = function (eip) {
  let a = eip; while ([0x66, 0x67, 0x2e, 0x26, 0x36, 0x3e, 0x64, 0x65].includes(this.u8[a])) a++;
  const b1 = this.u8[a + 1], reg = (this.u8[a + 2] >> 3) & 7;
  if (this.u8[a] !== 0x0f || !(b1 === 0x20 || b1 === 0x22 || (b1 === 0x01 && (reg === 2 || reg === 3 || reg === 6)))) return false;
  const psp = this.m16(this.sda + 0x10);
  this.winWait = { vmm: this.vmm, psp }; this.halted = true; this.cpu.eip.value = eip;
  this.o.windows(this.o.fs ? this.o.fs.realpath(this.vmm.path) : this.vmm.path);
  return true;
};
/** Windows has ended with `code` (ExitWindows': 0 shut down, 42h restart Windows, 43h restart the computer, 44h exit to
 *  MS-DOS and run its program): the VMM back in real mode returns to its loader, which ends as the loader does (INT 2Fh
 *  AX=1606h, Windows' end told to what is loaded, then INT 21h AH=4Ch with the code), and WIN.COM, which ran it, does
 *  what the code asks. What the VMM puts back on its way out is put back: the vectors its loader took into its own
 *  memory, the extended memory it was given; the screen in the text mode it leaves. For 44h, `exec` is the program
 *  ({ path, tail }, an MS-DOS mode program's PIF's) the VMM gives WIN.COM to run: written to the buffer WIN.COM's
 *  INT 2Fh AX=4B20h answers (DX:CX, its command tail 80h on) */
P.winDone = function (code = 0, exec = null) {
  const w = this.winWait; if (!w) return;
  this.winWait = null; this.halted = false;
  const lo = w.psp * 16, hi = lo + this.m16((w.psp - 1) * 16 + 3) * 16;
  for (let n = 0; n < 256; n++) {
    const at = (this.m16(n * 4 + 2) << 4) + this.m16(n * 4);
    if (at >= lo && at < hi) this.u8.set(w.vmm.ivt.subarray(n * 4, n * 4 + 4), this.v86 + n * 4);
  }
  if (this.xms) for (const h of [...this.xms.blocks.keys()]) if (!w.vmm.xms.has(h)) this.xms.blocks.delete(h);
  const ax = this.cpu.eax.value; this.cpu.eax.value = 0x0003; BIOS[0x10].call(this); this.cpu.eax.value = ax;
  const S = ROM + 0x3300, code86 = [];
  if (code === 0x44 && exec) {
    const path = [...exec.path].map(c => c.charCodeAt(0)).concat(0), t = exec.tail ? ` ${exec.tail}` : '', tail = [t.length, ...[...t].map(c => c.charCodeAt(0)), 13];
    const P0 = 0x200, T0 = P0 + path.length;   // (the strings after the code, in the stub's segment)
    path.forEach((b, i) => this.s8(S + P0 + i, b)); tail.forEach((b, i) => this.s8(S + T0 + i, b));
    const w16 = v => [v & 0xff, v >> 8], off = v => w16(0x3300 + v);
    code86.push(0xb8, 0x20, 0x4b, 0xcd, 0x2f,                 // mov ax,4B20h; int 2Fh: WIN.COM's buffer in DX:CX
      0x8e, 0xc2, 0x89, 0xcf, 0x89, 0xcb, 0x0e, 0x1f,           // mov es,dx; mov di,cx; mov bx,cx; push cs; pop ds
      0xbe, ...off(P0), 0xb9, ...w16(path.length), 0xf3, 0xa4,  // the program's path
      0x8d, 0xbf, 0x80, 0x00, 0xbe, ...off(T0), 0xb9, ...w16(tail.length), 0xf3, 0xa4);   // lea di,[bx+80h]: its command tail
  }
  code86.push(0xb8, 0x06, 0x16, 0x31, 0xd2, 0xcd, 0x2f, 0xb8, code & 0xff, 0x4c, 0xcd, 0x21);
  code86.forEach((b, i) => this.s8(S + i, b));
  this.sreg('cs', ROM >> 4); this.cpu.eip.value = this.v86 + ROM + 0x3300; this.vmm = null;
};
/** the DOS that booted, as the VMM's loader left it entering protected mode (the PC waiting for Windows): what Windows
 *  makes each MS-DOS VM from. Its first megabyte and HMA, the loader's PSP, the vectors as they were before the loader
 *  took any, DOS's tables, and the drives the redirector has */
P.dosState = function () {
  const w = this.winWait; if (!w) return null;
  return { mem: this.u8.slice(this.v86, this.v86 + 0x110000), psp: w.psp, ivt: w.vmm.ivt.slice(), lol: this.lol, sda: this.sda, cdsAt: this.cdsAt, drivesTaken: !!this.drivesTaken };
};
/** a VM Windows makes for an MS-DOS program (vmm.js), in memory of Windows' at o.base: the DOS that booted (`dos`,
 *  dosState) copied in, as V86MMGR makes a VM's memory from the system VM's, and the vectors the loader took put back
 *  (as winDone puts them back) */
M.vmMachine = function (o, dos) {
  const m = machine(o);
  m.u8.set(dos.mem, m.v86);
  m.lol = dos.lol; m.sda = dos.sda; m.cdsAt = dos.cdsAt; m.drivesTaken = dos.drivesTaken; m.dos = dos;
  m.redir = new Map(); m.nextRedir = 1; m.searches = new Map();
  const lo = dos.psp * 16, hi = lo + m.m16((dos.psp - 1) * 16 + 3) * 16;
  for (let n = 0; n < 256; n++) {
    const at = (m.m16(n * 4 + 2) << 4) + m.m16(n * 4);
    if (at >= lo && at < hi) m.u8.set(dos.ivt.subarray(n * 4, n * 4 + 4), m.v86 + n * 4);
  }
  if (m.drivesTaken) m.v86Hooks.add(0x2f);
  if (o.disks) m.v86Hooks.add(0x25);   // (its local disks' absolute reads)
  m.halted = true;   // (it runs once DOSMGR starts its program: vmExec)
  return m;
};
/** a VM's current folder (DOSMGR's, from the program's properties): its drive's entry in DOS's current-directory
 *  structures, in DOS's 8.3 form, and DOS's current drive (the swappable data area's 16h) */
P.vmCwd = function (dir) {
  let p = dir.toUpperCase().replace(/\\+$/, ''); try { p = this.o.fs.stat(dir).shortPath.toUpperCase().replace(/\\+$/, ''); } catch (_) { return; }
  if (p.length === 2) p += '\\';
  const d = p.charCodeAt(0) - 65, cds = this.lin(this.m16(this.lol + 0x18), this.m16(this.lol + 0x16)) - this.v86, e = cds + d * 0x58;
  if (d < 0 || d >= this.m8(this.lol + 0x21)) return;
  for (let i = 0; i < 67; i++) this.s8(e + i, i < p.length ? p.charCodeAt(i) : 0);
  this.s8(this.sda + 0x16, d);
};
/** DOSMGR's start of a VM's program: the loader's memory given back to DOS but for its PSP, and `program` EXECed from
 *  there with `tail` (DOS's form: a length, the text, CR); the EXEC's return ends the VM (v86Run 'exit') */
P.vmExec = function (program, tail) {
  const m = this, dos = this.dos;
  try { program = this.o.fs.stat(program).shortPath; } catch (_) { /* (DOS's own name for it, as given) */ }
  // (the stub, its strings and its stack in the ROM's segment, after winDone's: AH=4Ah the loader's block down to its
  // PSP, then AX=4B00h the program with a parameter block naming the tail and two empty FCBs)
  const S = 0x3600, PATH = 0x3700, TAIL = 0x3800, PB = 0x3900, FCB = 0x3920;
  [...program].forEach((c, i) => m.s8(ROM + PATH + i, c.charCodeAt(0))); m.s8(ROM + PATH + program.length, 0);
  tail.forEach((b, i) => m.s8(ROM + TAIL + i, b));
  for (let i = 0; i < 0x20; i++) m.s8(ROM + FCB + i, i >= 1 && i < 12 ? 0x20 : 0);
  m.s16(ROM + PB, 0); m.s16(ROM + PB + 2, TAIL); m.s16(ROM + PB + 4, ROM >> 4); m.s16(ROM + PB + 6, FCB); m.s16(ROM + PB + 8, ROM >> 4); m.s16(ROM + PB + 10, FCB); m.s16(ROM + PB + 12, ROM >> 4);
  const w16 = v => [v & 0xff, v >> 8];
  const code = [0xb8, ...w16(dos.psp), 0x8e, 0xc0, 0xbb, 0x10, 0x00, 0xb4, 0x4a, 0xcd, 0x21,   // mov ax,psp; mov es,ax; mov bx,10h; mov ah,4Ah; int 21h
    0x0e, 0x1f, 0xba, ...w16(PATH), 0x0e, 0x07, 0xbb, ...w16(PB), 0xb8, 0x00, 0x4b, 0xcd, 0x21];   // push cs; pop ds; mov dx,PATH; push cs; pop es; mov bx,PB; mov ax,4B00h; int 21h
  code.forEach((b, i) => m.s8(ROM + S + i, b));
  m.sreg('cs', ROM >> 4); m.cpu.eip.value = m.v86 + ROM + S; m.sreg('ss', ROM >> 4); m.cpu.esp.value = 0x5ffe; m.sreg('ds', ROM >> 4); m.sreg('es', ROM >> 4);
  m.boxReturn = m.v86 + ROM + S + code.length; m.halted = false;
};
// what the box's program writes to the console, kept for a command run with no window (dosRun): INT 21h's character
// and string output, and writes to a handle whose file is the console (a character device that is the standard
// output, by the process's handle table and DOS's file table: not what a command redirects to a file)
P.captureOut = function () {
  const ah = this.ah(), put = s => { this.out = (this.out || '') + s; if (this.out.length > 200000) this.out = this.out.slice(-150000); };
  if (ah === 0x02 || (ah === 0x06 && (this.cpu.edx.value & 0xff) !== 0xff)) { put(String.fromCharCode(this.cpu.edx.value & 0xff)); return; }
  if (ah === 0x09) { const a = this.lin(this.cpu.ds.value, this.r('dx')) - this.v86; let s = ''; for (let i = 0; i < 4096 && this.m8(a + i) !== 0x24; i++) s += String.fromCharCode(this.m8(a + i)); put(s); return; }
  if (ah !== 0x40 || !this.lol || !this.sda) return;
  const psp = this.m16(this.sda + 0x10), jft = this.lin(this.m16(psp * 16 + 0x36), this.m16(psp * 16 + 0x34)) - this.v86, h = this.r('bx');
  if (h >= this.m16(psp * 16 + 0x32)) return;
  let k = this.m8(jft + h); if (k === 0xff) return;
  for (let t = this.lin(this.m16(this.lol + 6), this.m16(this.lol + 4)) - this.v86, n = 0; t && n < 64; n++) {   // (the SFT blocks: next, count, entries of 3Bh)
    const cnt = this.m16(t + 4);
    if (k < cnt) { const dev = this.m16(t + 6 + k * 0x3b + 5); if ((dev & 0x82) === 0x82) { const a = this.lin(this.cpu.ds.value, this.r('dx')) - this.v86; let s = ''; for (let i = 0; i < this.r('cx'); i++) s += String.fromCharCode(this.m8(a + i)); put(s); } return; }
    k -= cnt; const nx = this.m32(t); if ((nx & 0xffff) === 0xffff) return; t = this.lin(nx >>> 16, nx & 0xffff) - this.v86;
  }
};
P.takeDrives = function () {
  this.drivesTaken = true; this.cdsAt = this.m32(this.lol + 0x16);
  const lol = this.lol, cds =this.lin(this.m16(lol + 0x18), this.m16(lol + 0x16)) - this.v86, last = this.m8(lol + 0x21);
  this.sda = lol - 0x26 + 0x320;   // (the List of Lists is at DOS's data segment:0026h, the SDA at :0320h)
  for (const v of this.o.fs.volumes()) {
    const d = v.letter.charCodeAt(0) - 65; if (d < 2 || d >= last || v.kind === 'remote') continue;
    const e = cds + d * 0x58;
    // (its current folder: the root, or the one the machine was started in, o.cwd, as CD leaves it in the CDS)
    let path = `${v.letter}:\\`; const cwd = this.o.cwd && this.o.cwd.toUpperCase().replace(/\\+$/, '');
    if (cwd && cwd[0] === v.letter && cwd.length > 2) { try { path = this.o.fs.stat(cwd).shortPath.toUpperCase(); } catch (_) { /* the root */ } }
    for (let i = 0; i < 67; i++) this.s8(e + i, i < path.length ? path.charCodeAt(i) : 0);
    this.s16(e + 0x43, 0xc000);   // (network, physical: a redirected drive)
    this.s16(e + 0x4f, 2);        // (the root's backslash)
  }
  this.redir = this.redir || new Map(); this.nextRedir = this.nextRedir || 1; this.searches = this.searches || new Map();
  this.v86Hooks.add(0x2f);
};
const ascii = (p, a, n = 128) => { let s = ''; for (let i = 0; i < n && p.m8(a + i); i++) s += String.fromCharCode(p.m8(a + i)); return s; };
const dosDate = t => { const d = new Date(t || 0); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: Math.max(0, d.getFullYear() - 1980) << 9 | ((d.getMonth() + 1) << 5) | d.getDate() }; };
const fcbName = n => { const [b, e = ''] = n.toUpperCase().split('.'); return (b.padEnd(8).slice(0, 8) + e.padEnd(3).slice(0, 3)); };
// a pattern in the 8.3 form DOS keeps (? for each position), matched against a short name
const match11 = (pat, name) => { const n = fcbName(name); for (let i = 0; i < 11; i++) if (pat[i] !== '?' && pat[i] !== n[i]) return false; return true; };
const toPat = s => { const [b, e = ''] = s.toUpperCase().split('.'), f = (x, w) => { let o = ''; for (const c of x) { if (c === '*') { o = o.padEnd(w, '?'); break; } o += c; } return o.padEnd(w).slice(0, w); }; return f(b, 8) + f(e, 3); };
HOOK[0x2f] = function (next) {
  if (this.r('ax') === 0x4300) { this.setAL(0x80); return true; }                                       // XMS: installed
  if (this.r('ax') === 0x4310) { this.sreg('es', ROM >> 4); this.w('bx', XMS.entry); return true; }       // its entry
  if (this.ah() === 0x17 && this.o.clip) {   // Windows' clipboard, in a VM of Windows' (vmm.js)
    const r = this.o.clip(this);
    if (r === 'wait') { this.cpu.eip.value = next - 2; this.halted = true; return true; }   // (the INT 2Fh again at the next tick: USER is busy)
    return r;
  }
  // in a VM of Windows' (o.vmId), what the VMM answers there: 1600h enhanced-mode Windows 4.00, 160Ah its version (BX
  // 0400h) and mode (CX 3, enhanced), 1680h the time slice given up (AL 0), 1683h the VM's id
  if (this.o.vmId) {
    const ax = this.r('ax');
    if (ax === 0x1600) { this.w('ax', 0x0004); return true; }
    if (ax === 0x160a) { this.w('ax', 0); this.w('bx', 0x0400); this.w('cx', 3); return true; }
    if (ax === 0x1680) { this.w('ax', 0); this.halted = true; return true; }
    if (ax === 0x1683) { this.w('bx', this.o.vmId); return true; }
  }
  if (this.ah() !== 0x11 || !this.redir) return false;
  const fs = this.o.fs, al = this.al(), sda = this.sda, fn1 = () => ascii(this, sda + SDA.FN1), fn2 = () => ascii(this, sda + SDA.FN2);
  // (taken before the INT: its answer in the flags and registers as they are, its caller's word argument at SS:SP)
  const note = s => { const l = this.rlog; if (l && l.length) l[l.length - 1] += ` -> ${s}`; };
  const ok = () => { this.cpu.cf.value = 0; note('ok'); return true; };
  const fail = code => { this.w('ax', code); this.cpu.cf.value = 1; note(`error ${code}`); return true; };
  const ours = p => /^[A-Z]:/i.test(p) && fs.vols && fs.vols.has(p[0].toUpperCase()) && !(fs.vols.get(p[0].toUpperCase()).remote);
  const err = e => fail(e && e.code && e.code < 0x100 ? e.code : 5);
  const sft = () => this.lin(this.cpu.es.value, this.r('di')) - this.v86;
  const stackArg = () => this.m16(this.lin(this.cpu.ss.value, this.r('sp')) - this.v86);
  const dta = () => this.lin(this.m16(sda + SDA.DTA + 2), this.m16(sda + SDA.DTA)) - this.v86;
  const fill = (s, path, mode, id) => {   // an SFT for a file opened: its mode, attributes, the drive (remote), times, size, position, name
    const st = fs.stat(path), { time, date } = dosDate(st.mtime);
    this.s16(s + 2, mode); this.s8(s + 4, st.attrs & 0x3f); this.s16(s + 5, 0x8040 | (path.charCodeAt(0) - 65));
    this.s32(s + 7, 0); this.s16(s + 0x0b, id); this.s16(s + 0x0d, time); this.s16(s + 0x0f, date); this.s32(s + 0x11, st.size); this.s32(s + 0x15, 0);
    [...fcbName(st.shortName || st.name)].forEach((c, i) => this.s8(s + 0x20 + i, c.charCodeAt(0)));
  };
  const open = (path, mode, how) => {
    const id = this.nextRedir++, fd = fs.open(path, how); this.redir.set(id, { fd, path }); fill(sft(), path, mode, id); return id;
  };
  const file = () => this.redir.get(this.m16(sft() + 0x0b));
  // (a diagnostic: the calls and how each was answered, the last 100)
  const log = this.rlog || (this.rlog = []); log.push(`11${al.toString(16).padStart(2, '0')} ${fn1().slice(0, 60)} cx=${this.r('cx').toString(16)}`); if (log.length > 100) log.shift();
  try {
    switch (al) {
      case 0x00: this.setAL(0xff); this.cpu.cf.value = 0; return true;                          // installed
      case 0x01: { const p = fn1(); if (!ours(p)) return false; fs.rmdir(p); return ok(); }      // rmdir
      case 0x03: { const p = fn1(); if (!ours(p)) return false; fs.mkdir(p); return ok(); }      // mkdir
      case 0x05: { const p = fn1(); if (!ours(p)) return false; if (!fs.exists(p) || !fs.stat(p).isDir) return fail(3); return ok(); }   // chdir
      case 0x06: { const f = file(), s = sft(); if (f) { const n = this.m16(s); if (n) this.s16(s, n - 1); if (n <= 1) { fs.close(f.fd); this.redir.delete(this.m16(s + 0x0b)); } } return ok(); }   // close
      case 0x07: return ok();                                                                // commit
      case 0x08: case 0x09: {                                                                 // read / write at the SFT's position
        const f = file(), s = sft(); if (!f) return fail(6);
        const n = this.r('cx'), at = dta(), pos = this.dv.getUint32(this.v86 + s + 0x15, true);
        fs.seek(f.fd, pos);
        if (al === 0x08) { const b = fs.read(f.fd, n); this.u8.set(b, this.v86 + at); this.w('cx', b.length); this.s32(s + 0x15, pos + b.length); }
        else if (!n) { fs.truncate(f.fd, pos); this.s32(s + 0x11, pos); }
        else { fs.write(f.fd, this.u8.slice(this.v86 + at, this.v86 + at + n)); this.s32(s + 0x15, pos + n); this.s32(s + 0x11, Math.max(this.dv.getUint32(this.v86 + s + 0x11, true), pos + n)); }
        return ok();
      }
      case 0x0a: case 0x0b: return ok();                                                      // lock / unlock
      case 0x0c: {                                                                            // disk space: 32K clusters of 512-byte sectors, as FAT16 counts them
        const v = fs.statvfs(`${String.fromCharCode(65 + (this.m8(this.lin(this.cpu.es.value, this.r('di')) - this.v86) - 65))}:\\`);
        const cl = 32768, tot = Math.min(0xffff, Math.floor((v.total || 0) / cl)), fr = Math.min(0xffff, Math.floor((v.free !== undefined ? v.free : (v.total || 0) - (v.used || 0)) / cl));
        this.w('ax', 64); this.w('bx', tot); this.w('cx', 512); this.w('dx', fr); return ok();
      }
      case 0x0e: { const p = fn1(); if (!ours(p)) return false; fs.setAttrs(p, stackArg() & 0x27); return ok(); }   // set attributes
      case 0x0f: {                                                                            // get attributes, size, time
        const p = fn1(); if (!ours(p)) return false; if (!fs.exists(p)) return fail(2);
        const st = fs.stat(p), { time, date } = dosDate(st.mtime);
        this.w('ax', (st.attrs & 0x3f) | (st.isDir ? 0x10 : 0)); this.w('bx', st.size >>> 16); this.w('di', st.size); this.w('cx', time); this.w('dx', date); return ok();
      }
      case 0x11: { const p = fn1(), q = fn2(); if (!ours(p)) return false; fs.rename(p, q); return ok(); }            // rename
      case 0x13: {                                                                            // delete (a pattern deletes each file it matches)
        const p = fn1(); if (!ours(p)) return false;
        const dir = p.slice(0, p.lastIndexOf('\\')) || p.slice(0, 3), pat = toPat(p.slice(p.lastIndexOf('\\') + 1));
        const hit = fs.readdir(dir.length === 2 ? dir + '\\' : dir).filter(e => !e.isDir && match11(pat, e.shortName || e.name));
        if (!hit.length) return fail(2); for (const e of hit) fs.unlink(e.path); return ok();
      }
      case 0x16: {                                                                            // open: the mode on the stack
        const p = fn1(); if (!ours(p)) return false; if (!fs.exists(p) || fs.stat(p).isDir) return fail(2);
        const mode = stackArg() & 0xff; open(p, mode, (mode & 3) === 0 ? 'r' : 'r+'); return ok();
      }
      case 0x17: { const p = fn1(); if (!ours(p)) return false; open(p, 2, 'w+'); if (stackArg() & 0x27) fs.setAttrs(p, stackArg() & 0x27); return ok(); }   // create
      case 0x2e: {                                                                            // extended open / create (21h AX=6C00h)
        const p = fn1(); if (!ours(p)) return false;
        const act = this.m16(sda + SDA.XACTION), mode = this.m16(sda + SDA.XMODE) & 0xff, had = fs.exists(p);
        if (had && fs.stat(p).isDir) return fail(5);
        if (had && (act & 0xf) === 0) return fail(80); if (!had && !(act & 0x10)) return fail(2);
        const how = !had ? 'w+' : (act & 0xf) === 2 ? 'w+' : (mode & 3) === 0 ? 'r' : 'r+';
        open(p, mode, how); this.w('cx', !had ? 2 : (act & 0xf) === 2 ? 3 : 1); return ok();
      }
      case 0x1b: case 0x1c: {                                                                 // find first / next: the SDA's search block and entry
        let st;
        if (al === 0x1b) {
          const p = fn1(); if (!ours(p)) return false;
          const dir = p.slice(0, p.lastIndexOf('\\')), want = this.m8(sda + SDA.SATTR), pat = toPat(p.slice(p.lastIndexOf('\\') + 1));
          if (!fs.exists(dir.length === 2 ? dir + '\\' : dir)) return fail(3);
          let list;
          if (want === 8) {   // (a search for the volume label alone, as DIR makes one: the label, the only entry)
            const lb = (fs.statvfs(p.slice(0, 3)).label || '').toUpperCase(); if (!lb) return fail(18);
            list = [{ name: lb, label: lb, attrs: 8, size: 0, mtime: Date.now() }];
          } else {
            list = fs.readdir(dir.length === 2 ? dir + '\\' : dir).filter(e => match11(pat, e.shortName || e.name) && (!(e.attrs & 0x16) || (e.attrs & 0x16 & want)) && (!e.isDir || (want & 0x10)));
            if (dir.length > 2) for (const dot of ['..', '.']) if (match11(pat, dot) && (want & 0x10)) list.unshift({ name: dot, shortName: dot, isDir: true, attrs: 0x10, size: 0, mtime: 0 });   // (. and .., as a FAT folder lists them)
          }
          const id = this.nextRedir++; st = { list, i: 0 }; this.searches.set(id, st);
          const sdb = sda + SDA.SDB; this.s8(sdb, 0x80 | (p.charCodeAt(0) - 65)); [...pat].forEach((c, k) => this.s8(sdb + 1 + k, c.charCodeAt(0))); this.s8(sdb + 0x0c, want); this.s16(sdb + 0x0d, id); this.s16(sdb + 0x0f, 0);
          if (this.searches.size > 64) this.searches.delete(this.searches.keys().next().value);
        } else {
          const sdb = this.lin(this.cpu.es.value, this.r('di')) - this.v86; st = this.searches.get(this.m16(sdb + 0x0d));
          if (!st) return fail(18);
        }
        const e = st.list[st.i++]; if (!e) return fail(18);
        const de = sda + SDA.DIRENT, { time, date } = dosDate(e.mtime), n = e.label ? e.label.padEnd(11).slice(0, 11) : e.name === '.' || e.name === '..' ? e.name.padEnd(11) : fcbName(e.shortName || e.name);
        [...n].forEach((c, k) => this.s8(de + k, c.charCodeAt(0))); this.s8(de + 11, (e.attrs & 0x3f) | (e.isDir ? 0x10 : 0));
        for (let k = 12; k < 22; k++) this.s8(de + k, 0); this.s16(de + 22, time); this.s16(de + 24, date); this.s16(de + 26, 0); this.s32(de + 28, e.size || 0);
        return ok();
      }
      case 0x1d: case 0x22: return ok();                                                      // close all, process ended
      case 0x21: {                                                                            // seek from the end
        const f = file(), s = sft(); if (!f) return fail(6);
        const size = fs.fstat(f.fd).size, p = Math.max(0, size + ((this.r('cx') << 16 | this.r('dx')) | 0));
        this.s32(s + 0x15, p); this.w('dx', p >>> 16); this.w('ax', p); return ok();
      }
      default: return false;
    }
  } catch (e) { note(String(e.message || e)); return err(e); }
};

// ---------------------------------------------------------------- the ports
P.v86Port = function (port, size, isIn, val) {
  const c = this.cpu;
  // the VGA's ports in a VM of Windows': the display's VxD (VDD) traps them and keeps the VM's video state, as it
  // does for every VM (o.vgaPort, vmm.js vmVgaIO); a port it does not trap is the machine's own
  if (port >= 0x3b0 && port <= 0x3df && this.o.vgaPort) {
    const r = this.o.vgaPort(port, size, isIn, c.eax.value >>> 0);
    if (r !== undefined) { if (isIn) { const m = size === 1 ? 0xff : size === 2 ? 0xffff : -1; c.eax.value = (c.eax.value & ~m) | (r & m); } return; }
  }
  if (!isIn) {
    if (port === 0x70) this.cmosAt = c.eax.value & 0x7f;
    // the reset line: the keyboard controller's pulse (command FEh) or port 92h's bit 0, as the PC starts again
    else if ((port === 0x64 && (c.eax.value & 0xff) === 0xfe) || (port === 0x92 && c.eax.value & 1)) BIOS[0xfe].call(this);
    return;
  }   // (the CMOS's index kept; the interrupt controller's EOI, the timer's programming, the CRTC's cursor: the host keeps its own)
  let v = 0xff;
  // the CMOS's extended memory (17h/18h and 30h/31h: the KB above 1 MB), what XMS gives out and the HMA
  const ext = this.xmsKB + (XMS.base - 0x100000) / 1024;
  if (port === 0x71 && [0x17, 0x30].includes(this.cmosAt)) v = ext & 0xff;
  else if (port === 0x71 && [0x18, 0x31].includes(this.cmosAt)) v = ext >> 8;
  // the real-time clock's registers (0 seconds, 2 minutes, 4 hours, 6 the day of the week, 7 the day, 8 the month, 9
  // the year, 32h the century, in BCD; 0Ah to 0Dh its status: not updating, 24-hour binary-coded, power good), from this
  // machine's wall clock in the session's time (wallSkew: the server's clock, shared.js)
  else if (port === 0x71 && this.cmosAt <= 9 || (port === 0x71 && (this.cmosAt === 0x32 || (this.cmosAt >= 0x0a && this.cmosAt <= 0x0d)))) {
    const d = new Date(Date.now() + (this.wallSkew || 0)), bcd = n => ((n / 10) | 0) << 4 | (n % 10);
    v = [bcd(d.getSeconds()), 0, bcd(d.getMinutes()), 0, bcd(d.getHours()), 0, d.getDay() + 1, bcd(d.getDate()), bcd(d.getMonth() + 1), bcd(d.getFullYear() % 100), 0x26, 0x02, 0x00, 0x80][this.cmosAt] ?? bcd((d.getFullYear() / 100) | 0);
  }
  else
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
  // Ctrl+Alt+Del: the warm boot (40:72h 1234h, the memory test skipped), the PC started again
  if (k >> 8 === 0x53 && (this.m8(0x417) & 0x0c) === 0x0c) { this.s16(0x472, 0x1234); if (this.o.reset) this.o.reset(); else { this.v86Reset(); this.v86Boot(); } return; }
  if (k) { const t = this.m16(0x41c), nt = t + 2 >= this.m16(0x482) ? this.m16(0x480) : t + 2; if (nt !== this.m16(0x41a)) { this.s16(0x400 + t, k); this.s16(0x41c, nt); } }
};
BIOS[0x11] = function () { this.w('ax', this.m16(0x410)); };
BIOS[0x12] = function () { this.w('ax', this.m16(0x413)); };
BIOS[0x10] = function () { video.call(this); };
BIOS[0x13] = function () { disk.call(this); };
BIOS[0x14] = function () { this.w('ax', 0); };
BIOS[0x15] = function () {
  const ah = this.ah();
  if (ah === 0x88) { this.w('ax', this.xmsKB + (XMS.base - 0x100000) / 1024); this.retCF(false); return; }   // the extended memory, in KB (XMS gives it out)
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
// the processor's reset (the vector at FFFF:0000, the reset line): the PC from its power-on, or the machine anew
BIOS[0xfe] = function () { this.halted = true; if (this.o.reset) this.o.reset(); else { this.v86Reset(); this.v86Boot(); this.halted = false; } };
BIOS[0x1a] = function () {
  const ah = this.ah(), d = new Date();
  if (ah === 0x00) { const t = this.dv.getUint32(this.v86 + 0x46c, true); this.w('cx', t >>> 16); this.w('dx', t); this.setAL(0); return; }
  if (ah === 0x02) { this.w('cx', (bcd(d.getHours()) << 8) | bcd(d.getMinutes())); this.w('dx', bcd(d.getSeconds()) << 8); this.retCF(false); return; }
  if (ah === 0x04) { const y = d.getFullYear(); this.w('cx', (bcd((y / 100) | 0) << 8) | bcd(y % 100)); this.w('dx', (bcd(d.getMonth() + 1) << 8) | bcd(d.getDate())); this.retCF(false); return; }
  this.retCF(true);
};
// ---- XMS, as V86MMGR gives a VM extended memory: INT 2Fh 4300h says a driver is there, 4310h its entry (F000:3200h,
// the host's service F8h, then RETF), whose functions (AH) manage blocks of the machine's extended memory (from
// 120000h, past the HMA and the translator's flags at 110000h) and move memory between them and the first megabyte.
// The HMA is DOS's (not given out), A20 always on, no upper memory blocks
const XMS = { entry: 0x3200, base: 0x120000, kb: 15 * 1024, handles: 64 };
const xmsOf = p => p.xms || (p.xms = { blocks: new Map(), next: 1 });
const xmsFree = p => {   // the free runs between the blocks, in KB: [largest, total]
  const used = [...xmsOf(p).blocks.values()].sort((a, b) => a.at - b.at); let at = 0, big = 0, all = 0;
  for (const b of used) { big = Math.max(big, b.at - at); all += b.at - at; at = b.at + b.kb; }
  big = Math.max(big, p.xmsKB - at); all += p.xmsKB - at; return [big, all];
};
const xmsPlace = (p, kb, skip) => {   // the first run of `kb` free KB (the block `skip` not counted), or -1
  const used = [...xmsOf(p).blocks.values()].filter(b => b !== skip).sort((a, b) => a.at - b.at); let at = 0;
  for (const b of used) { if (b.at - at >= kb) return at; at = b.at + b.kb; }
  return p.xmsKB - at >= kb ? at : -1;
};
BIOS[0xf8] = function (next) {
  if (next !== this.v86 + ROM + XMS.entry + 3) return;   // (INT F8h's own stub: nothing)
  const x = xmsOf(this), ah = this.ah(), c = this.cpu;
  const done = (ax, bl) => { this.w('ax', ax); if (bl !== undefined) this.cpu.ebx.value = (this.cpu.ebx.value & ~0xff) | bl; };
  const fail = bl => done(0, bl), blk = h => x.blocks.get(h & 0xffff);
  const big = ah >= 0x80, size = v => big ? v >>> 0 : v & 0xffff;
  switch (ah) {
    case 0x00: this.w('ax', 0x0300); this.w('bx', 0x0395); this.w('dx', 1); return;   // version 3.0; an HMA (DOS's)
    case 0x01: return fail(0x91); case 0x02: return fail(0x91);                        // the HMA: DOS's
    case 0x03: case 0x04: case 0x05: case 0x06: return done(1, 0);                     // A20: on
    case 0x07: return done(1, 0);
    case 0x08: case 0x88: {
      const [l, t] = xmsFree(this);
      if (big) { c.eax.value = l; c.edx.value = t; c.ecx.value = XMS.base + this.xmsKB * 1024 - 1; this.cpu.ebx.value &= ~0xff; return; }
      this.w('ax', Math.min(l, 0xffff)); this.w('dx', Math.min(t, 0xffff)); this.cpu.ebx.value &= ~0xff; return;
    }
    case 0x09: case 0x89: {
      if (x.blocks.size >= XMS.handles) return fail(0xa1);
      const kb = size(c.edx.value), at = xmsPlace(this, kb); if (at < 0) return fail(0xa0);
      const h = x.next++; x.blocks.set(h, { at, kb, lock: 0 }); this.w('dx', h); return done(1);
    }
    case 0x0a: { const b = blk(c.edx.value); if (!b) return fail(0xa2); if (b.lock) return fail(0xab); x.blocks.delete(c.edx.value & 0xffff); return done(1); }
    case 0x0b: {   // move: DS:SI the length, the source handle and offset, the destination's (handle 0: a real-mode segment:offset)
      const s = this.lin(c.ds.value, this.r('si')) - this.v86, n = this.m32(s);
      const where = (h, off, bad) => {
        if (!h) return { a: this.lin(off >>> 16, off & 0xffff) };
        const b = blk(h); if (!b) return { e: bad }; if (off + n > b.kb * 1024) return { e: bad + 1 };
        return { a: this.v86 + XMS.base + b.at * 1024 + off };
      };
      if (n & 1) return fail(0xa7);
      const from = where(this.m16(s + 4), this.m32(s + 6), 0xa3), to = where(this.m16(s + 10), this.m32(s + 12), 0xa5);
      if (from.e) return fail(from.e); if (to.e) return fail(to.e);
      this.u8.copyWithin(to.a, from.a, from.a + n); return done(1, 0);
    }
    case 0x0c: { const b = blk(c.edx.value); if (!b) return fail(0xa2); b.lock++; const a = XMS.base + b.at * 1024; this.w('dx', a >>> 16); this.w('bx', a); this.w('ax', 1); return; }
    case 0x0d: { const b = blk(c.edx.value); if (!b) return fail(0xa2); if (!b.lock) return fail(0xaa); b.lock--; return done(1); }
    case 0x0e: case 0x8e: {
      const b = blk(c.edx.value); if (!b) return fail(0xa2);
      const free = XMS.handles - x.blocks.size;
      if (big) { this.cpu.ebx.value = (this.cpu.ebx.value & ~0xff00) | (Math.min(b.lock, 255) << 8); this.w('cx', free); c.edx.value = b.kb; this.w('ax', 1); return; }
      this.w('bx', Math.min(b.lock, 255) << 8 | Math.min(free, 255)); this.w('dx', b.kb); this.w('ax', 1); return;
    }
    case 0x0f: case 0x8f: {
      const b = blk(c.edx.value); if (!b) return fail(0xa2); if (b.lock) return fail(0xab);
      const kb = size(c.ebx.value), at = xmsPlace(this, kb, b); if (at < 0) return fail(0xa0);
      if (at !== b.at) { const src = this.v86 + XMS.base + b.at * 1024; this.u8.copyWithin(this.v86 + XMS.base + at * 1024, src, src + Math.min(b.kb, kb) * 1024); }
      b.at = at; b.kb = kb; return done(1);
    }
    case 0x10: this.w('dx', 0); return fail(0xb1);   // no upper memory blocks
    case 0x11: case 0x12: return fail(0xb2);
    default: return fail(0x80);
  }
};
// the clock's ticks since midnight, as the BIOS counts them, set at power-on
P.v86Clock = function () { const d = new Date(), s = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); this.s32(0x46c, Math.floor(s * 18.2065)); };

// ---- INT 10h: the text screen (mode 3, 80 x 25 at B800h; one page)
// the VGA's registers for mode 3 (80x25 text, 16 colours), as the VGA BIOS programs them: the miscellaneous output
// register, the sequencer's, the CRT controller's, the attribute controller's (palette, mode control) and the
// graphics controller's. Programmed through the ports, so the display's VxD sees the mode a VM is in (it keeps each
// VM's registers from its traps): set in memory alone, VDD took the VM for one it could not show in a window
const VGA_MODE3 = {
  misc: 0x67, seq: [0x03, 0x00, 0x03, 0x00, 0x02],
  crtc: [0x5f, 0x4f, 0x50, 0x82, 0x55, 0x81, 0xbf, 0x1f, 0x00, 0x4f, 0x0d, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28, 0x1f, 0x96, 0xb9, 0xa3, 0xff],
  attr: [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x14, 0x07, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x0c, 0x00, 0x0f, 0x08, 0x00],
  gc: [0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x0e, 0x00, 0xff],
};
P.vgaOut = function (port, v) { const c = this.cpu, ax = c.eax.value; c.eax.value = (ax & ~0xff) | (v & 0xff); this.v86Port(port, 1, false); c.eax.value = ax; };
P.vgaIn = function (port) { const c = this.cpu, ax = c.eax.value; this.v86Port(port, 1, true); const v = c.eax.value & 0xff; c.eax.value = ax; return v; };
P.vgaMode3 = function () {
  const t = VGA_MODE3;
  this.vgaOut(0x3c2, t.misc);
  t.seq.forEach((v, i) => { this.vgaOut(0x3c4, i); this.vgaOut(0x3c5, v); });
  this.vgaOut(0x3d4, 0x11); this.vgaOut(0x3d5, t.crtc[0x11] & 0x7f);   // (the CRTC's registers 0-7 unprotected first)
  t.crtc.forEach((v, i) => { this.vgaOut(0x3d4, i); this.vgaOut(0x3d5, v); });
  t.gc.forEach((v, i) => { this.vgaOut(0x3ce, i); this.vgaOut(0x3cf, v); });
  this.vgaIn(0x3da); t.attr.forEach((v, i) => { this.vgaOut(0x3c0, i); this.vgaOut(0x3c0, v); }); this.vgaOut(0x3c0, 0x20);   // (the flip-flop reset; the screen on)
  // the DAC, as the VGA BIOS loads it at a mode set: its first 64 entries the EGA's colours (each 6-bit component
  // 2Ah for a primary bit and 15h for a secondary), the rest black; the mask all on. Left alone, VDD kept the VM's DAC
  // as all black, the grabber took every colour from it (VDD hands it the VM's register state), and MEM's text was
  // drawn black on black
  this.vgaOut(0x3c6, 0xff); this.vgaOut(0x3c8, 0);
  for (let i = 0; i < 256; i++) {
    const k = i & 63, c = (p, s) => (k >> p & 1) * 0x2a + (k >> s & 1) * 0x15;
    const [r, g, b] = i < 64 ? [c(2, 5), c(1, 4), c(0, 3)] : [0, 0, 0];
    this.vgaOut(0x3c9, r); this.vgaOut(0x3c9, g); this.vgaOut(0x3c9, b);
  }
};
/** the cursor's place (CRTC 0Eh, 0Fh: its offset in the screen's cells) and shape (0Ah, 0Bh), as the BIOS sets them */
P.vgaCursor = function (r, c) { const o = r * 80 + c; this.vgaOut(0x3d4, 0x0e); this.vgaOut(0x3d5, o >> 8); this.vgaOut(0x3d4, 0x0f); this.vgaOut(0x3d5, o & 0xff); };
function video() {
  const ah = this.ah(), cols = 80, rows = 25;
  const cur = () => [this.m8(0x451), this.m8(0x450)];   // row, column
  const setCur = (r, c) => { this.s8(0x450, c); this.s8(0x451, r); this.vgaCursor(r, c); };
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
    case 0x00: this.vgaMode3(); scroll(0, 0, 0, rows - 1, cols - 1, 7, true); setCur(0, 0); this.s8(0x449, 3); return;
    case 0x01: { const cx = this.r('cx'); this.s16(0x460, cx); this.vgaOut(0x3d4, 0x0a); this.vgaOut(0x3d5, cx >> 8); this.vgaOut(0x3d4, 0x0b); this.vgaOut(0x3d5, cx & 0xff); return; }
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

// ---- INT 13h's diskette drive A: (00h): a 1.44 MB disk, 80 cylinders of 2 heads of 18 sectors, its sectors the image in
// the drive (o.floppy: { image, changed }, a Uint8Array the disk's written sectors go back to); none in it, not ready.
// Its change line: set as a disk is put in, read and cleared by AH=16h, as DOS asks before trusting what it has read
function floppy(ah, dl, ok, bad) {
  const f = this.o.floppy, img = f && f.image, SPT = 18, HEADS = 2, CYLS = 80;
  if (dl !== 0) { bad(0x01); return; }
  switch (ah) {
    case 0x00: ok(); return;
    case 0x01: this.setAH(this.m8(0x441)); this.retCF(false); return;
    case 0x02: case 0x03: case 0x04: {
      if (!img) { this.s8(0x441, 0x80); bad(0x80); return; }   // (no disk: the drive times out)
      if (f.changed) { f.changed = false; this.s8(0x441, 0x06); bad(0x06); return; }   // (the disk was changed: told once)
      const cx = this.r('cx'), cyl = cx >> 8 | ((cx & 0xc0) << 2), sec = cx & 0x3f, head = (this.cpu.edx.value >> 8) & 0xff, n = this.al();
      const lba = (cyl * HEADS + head) * SPT + sec - 1, mem = this.lin(this.cpu.es.value, this.r('bx'));
      if (sec < 1 || sec > SPT || head >= HEADS || cyl >= CYLS || lba + n > img.length / 512) { this.s8(0x441, 0x04); bad(0x04); return; }
      if (ah === 0x02) this.u8.set(img.subarray(lba * 512, (lba + n) * 512), mem);
      else if (ah === 0x03) { if (f.readonly) { bad(0x03); return; } img.set(this.u8.subarray(mem, mem + n * 512), lba * 512); if (f.wrote) f.wrote(); }
      this.s8(0x441, 0); this.setAL(n); ok(); return;
    }
    case 0x05: if (!img) { bad(0x80); return; } ok(); return;   // (formatting a track: the image's track is the format)
    case 0x08: this.w('bx', 0x0004); this.w('cx', ((CYLS - 1) << 8) | SPT); this.w('dx', ((HEADS - 1) << 8) | 1); this.sreg('es', ROM >> 4); this.w('di', DPT); ok(); return;
    case 0x15: this.setAH(0x02); this.retCF(false); return;   // (a diskette drive with a change line)
    case 0x16: if (f && f.changed) { this.setAH(0x06); this.retCF(true); return; } this.setAH(0); this.retCF(false); return;
    case 0x17: case 0x18: ok(); return;   // (the media type to format: the drive's own)
    default: bad(0x01);
  }
}
const DPT = 0xefc7;   // the diskette parameter table, where the AT BIOS keeps it (INT 1Eh's vector points there)

// ---- INT 13h: the hard disk (80h; the boot partition from its first sector), in 16 heads of 63 sectors
function disk() {
  const ah = this.ah(), dl = this.cpu.edx.value & 0xff, d = this.disk, nsec = d ? d.length >> 9 : 0, { heads, spt } = this.geom;
  const ok = () => { this.setAH(0); this.retCF(false); }, bad = (e = 1) => { this.setAH(e); this.retCF(true); };
  if (dl < 0x80) { floppy.call(this, ah, dl, ok, bad); return; }
  if (dl !== 0x80 || !d) { bad(1); return; }
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

// ---------------------------------------------------------------- a drive of Windows' as a hard disk
// A hard disk whose sectors are made from one of fs.js's drives (fs.js keeps files, not sectors): an MBR with one
// active FAT16 partition at sector 63, its boot sector and BPB, two FATs, a root directory of 512 entries and the
// clusters, each folder's entries as VFAT writes them (a long name's entries before its 8.3 one, the checksum of the
// short name, the times and attributes fs.js keeps) and each file's data read from fs.js as asked. The layout follows
// fs.js (its version), as a disk does: a folder or file keeps the clusters it had, one that grew takes free ones onto
// its chain, one that shrank or went gives its back, a new one takes the lowest free. A write is taken by the sectors
// ahead of the FATs (the MBR, the hidden track, the boot sector), which read back as written from then on, as Windows 98
// Setup's check for a BIOS's boot-sector protection writes the MBR and boot sector back and reads them again; the FATs,
// folders and files are fs.js's, and a write to them is not taken
const dosTime = t => { const d = new Date(t || 0); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: Math.max(0, d.getFullYear() - 1980) << 9 | ((d.getMonth() + 1) << 5) | d.getDate() }; };
class FatView {
  constructor(fs, letter) { this.fs = fs; this.letter = letter; this.built = -1; this.chains = new Map(); this.written = new Map(); }
  /** the layout, for fs.js as it is now */
  layout() {
    if (this.built === this.fs.version && this.L) return this.L;
    const fs = this.fs, v = fs.vols.get(this.letter), hidden = 63, sectors = Math.floor((v.total || 0x20000000) / 512);
    let spc = 4; while (spc < 64 && sectors / spc > 65500) spc *= 2;
    const rootEntries = 512, rootSecs = rootEntries * 32 / 512, reserved = 1;
    const clusters0 = Math.floor((sectors - reserved - rootSecs) / spc), fatSecs = Math.ceil((clusters0 + 2) * 2 / 512);
    const dataStart = reserved + 2 * fatSecs + rootSecs, clusters = Math.min(Math.floor((sectors - dataStart) / spc), 65524), cb = spc * 512;
    const L = { hidden, sectors, spc, cb, reserved, fatSecs, rootSecs, rootEntries, dataStart, clusters, fat: new Uint16Array(clusters + 2), owner: new Array(clusters + 2), dirs: new Map(), serial: v.serial >>> 0 };
    // (what each folder and file needs, in the tree's order: a folder's entries counted with its long names)
    const items = [];
    const walk = (path, isRoot) => {
      let kids = []; try { kids = fs.readdir(path).filter(k => !k.absent); } catch (_) { /* none */ }
      const n = kids.reduce((s, k) => s + 1 + (k.name !== k.shortName ? Math.ceil(k.name.length / 13) : 0), isRoot ? 0 : 2);
      const d = { path, kids, entries: n, isRoot, chain: [] };
      if (!isRoot) items.push({ key: path.toUpperCase() + '\\', n: Math.max(1, Math.ceil(n * 32 / cb)), obj: d, dir: true });
      L.dirs.set(path.toUpperCase(), d);
      for (const k of kids) if (k.isDir) k.dir = walk(k.path, false); else if (k.size > 0) items.push({ key: k.path.toUpperCase(), n: Math.ceil(k.size / cb), obj: k });
      return d;
    };
    L.root = walk(`${this.letter}:\\`, true);
    // (the clusters kept: each item's old chain, cut to what it needs; the rest free)
    const used = new Uint8Array(clusters + 2); used[0] = used[1] = 1;
    const chains = new Map();
    for (const it of items) { const old = (this.chains.get(it.key) || []).filter(c => c < clusters + 2 && !used[c]).slice(0, it.n); for (const c of old) used[c] = 1; chains.set(it.key, old); }
    let free = 2;
    for (const it of items) {
      const ch = chains.get(it.key);
      while (ch.length < it.n) { while (free < clusters + 2 && used[free]) free++; if (free >= clusters + 2) break; used[free] = 1; ch.push(free); }
      it.obj.chain = ch; it.obj.start = ch[0] || 0;
      ch.forEach((c, i) => { L.fat[c] = i === ch.length - 1 ? 0xffff : ch[i + 1]; L.owner[c] = { obj: it.obj, i, dir: !!it.dir }; });
    }
    L.fat[0] = 0xfff8; L.fat[1] = 0xffff;
    L.used = used.reduce((s, x) => s + x, 0) - 2;
    this.chains = chains; this.L = L; this.built = fs.version; this.dirBytes = new Map(); this.fileCache = null;
    return L;
  }
  /** a folder's entries, as bytes */
  dirData(d, parent) {
    const L = this.L, out = new Uint8Array(Math.max(d.isRoot ? L.rootEntries : d.chain.length * L.cb / 32, 1) * 32); let o = 0;
    const ent = (name11, attr, start, size, t) => {
      for (let i = 0; i < 11; i++) out[o + i] = name11.charCodeAt(i) & 0xff;
      out[o + 11] = attr; const w = (at, x) => { out[o + at] = x & 0xff; out[o + at + 1] = (x >> 8) & 0xff; };
      const c = dosTime(t.c), m = dosTime(t.m), a = dosTime(t.a);
      w(14, c.time); w(16, c.date); w(18, a.date); w(22, m.time); w(24, m.date); w(26, start); w(28, size & 0xffff); w(30, size >>> 16); o += 32;
    };
    const short11 = s => { const [b, e = ''] = s.toUpperCase().split('.'); return b.padEnd(8).slice(0, 8) + e.padEnd(3).slice(0, 3); };
    if (!d.isRoot) { const t = { c: 0, m: 0, a: 0 }; ent('.          ', 0x10, d.start, 0, t); ent('..         ', 0x10, parent && !parent.isRoot ? parent.start : 0, 0, t); }
    for (const k of d.kids) {
      const s11 = short11(k.shortName);
      if (k.name !== k.shortName) {
        let sum = 0; for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) | (sum >> 1)) + s11.charCodeAt(i) & 0xff;
        const parts = Math.ceil(k.name.length / 13);
        for (let p = parts; p >= 1; p--) {
          const chunk = []; for (let i = 0; i < 13; i++) { const j = (p - 1) * 13 + i; chunk.push(j < k.name.length ? k.name.charCodeAt(j) : j === k.name.length ? 0 : 0xffff); }
          out.fill(0, o, o + 32); out[o] = p | (p === parts ? 0x40 : 0); out[o + 11] = 0x0f; out[o + 13] = sum;
          [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30].forEach((at, i) => { out[o + at] = chunk[i] & 0xff; out[o + at + 1] = chunk[i] >> 8; });
          o += 32;
        }
      }
      ent(s11, (k.attrs & 0x27) | (k.isDir ? 0x10 : 0), k.isDir ? k.dir.start : k.start || 0, k.isDir ? 0 : k.size, { c: k.ctime, m: k.mtime, a: k.atime });
    }
    return out;
  }
  /** `n` sectors from `lba` of the disk */
  read(lba, n = 1) {
    const L = this.layout(), out = new Uint8Array(n * 512);
    for (let i = 0; i < n; i++) out.set(this.sector(lba + i), i * 512);
    return out;
  }
  /** `data`'s sectors written from `lba`: false (none taken) if one is past the boot sector's area */
  write(lba, data) {
    const L = this.layout(), n = data.length >> 9;
    if (lba + n > L.hidden + L.reserved) return false;
    for (let i = 0; i < n; i++) this.written.set(lba + i, data.slice(i * 512, i * 512 + 512));
    return true;
  }
  sector(lba) {
    const L = this.L, s = new Uint8Array(512), dv = new DataView(s.buffer);
    if (this.written.has(lba)) return this.written.get(lba).slice();
    if (lba === 0) {   // the MBR: one active FAT16 (over 32 MB) partition
      const e = 0x1be; s[e] = 0x80; s[e + 1] = 1; s[e + 2] = 1; s[e + 4] = 0x06; s[e + 5] = 0xfe; s[e + 6] = 0xff; s[e + 7] = 0xff;
      dv.setUint32(e + 8, L.hidden, true); dv.setUint32(e + 12, L.sectors, true); s[510] = 0x55; s[511] = 0xaa; return s;
    }
    if (lba < L.hidden) return s;
    const p = lba - L.hidden;
    if (p === 0) {   // the boot sector: its BPB and extended BPB, as SYS writes one (MSWIN4.1)
      s.set([0xeb, 0x3c, 0x90]); [...'MSWIN4.1'].forEach((c, i) => { s[3 + i] = c.charCodeAt(0); });
      dv.setUint16(11, 512, true); s[13] = L.spc; dv.setUint16(14, L.reserved, true); s[16] = 2; dv.setUint16(17, L.rootEntries, true);
      dv.setUint16(19, 0, true); s[21] = 0xf8; dv.setUint16(22, L.fatSecs, true); dv.setUint16(24, 63, true); dv.setUint16(26, 255, true);
      dv.setUint32(28, L.hidden, true); dv.setUint32(32, L.sectors, true); s[36] = 0x80; s[38] = 0x29; dv.setUint32(39, L.serial, true);
      [...'NO NAME    FAT16   '].forEach((c, i) => { s[43 + i] = c.charCodeAt(0); }); s[510] = 0x55; s[511] = 0xaa; return s;
    }
    if (p >= L.sectors) return s;
    const fat0 = L.reserved, root0 = fat0 + 2 * L.fatSecs;
    if (p >= fat0 && p < root0) { const f = (p - fat0) % L.fatSecs; for (let i = 0; i < 256; i++) { const c = f * 256 + i; if (c < L.fat.length) dv.setUint16(i * 2, L.fat[c], true); } return s; }
    if (p >= root0 && p < L.dataStart) { const b = this.dirOf(L.root, null); s.set(b.subarray((p - root0) * 512, (p - root0) * 512 + 512)); return s; }
    const rel = p - L.dataStart, c = 2 + Math.floor(rel / L.spc), own = c < L.owner.length ? L.owner[c] : null;
    if (!own) return s;
    const off = own.i * L.cb + (rel % L.spc) * 512;
    if (own.dir) { const parent = this.parentOf(own.obj); const b = this.dirOf(own.obj, parent); s.set(b.subarray(off, off + 512)); return s; }
    const f = own.obj; if (!this.fileCache || this.fileCache.path !== f.path) { let data = new Uint8Array(0); try { data = this.fs.readFile(f.path); } catch (_) { /* gone meanwhile */ } this.fileCache = { path: f.path, data }; }
    s.set(this.fileCache.data.subarray(off, Math.min(off + 512, this.fileCache.data.length)));
    return s;
  }
  dirOf(d, parent) { let b = this.dirBytes.get(d); if (!b) { b = this.dirData(d, parent); this.dirBytes.set(d, b); } return b; }
  parentOf(d) { const i = d.path.lastIndexOf('\\'), up = d.path.slice(0, i); return this.L.dirs.get((up.length === 2 ? up + '\\' : up).toUpperCase()) || this.L.root; }
  /** the BPB's numbers, for DOS's device parameters and drive parameter block */
  bpb() { const L = this.layout(); return L; }
}
M.FatView = FatView; M.V86Machine = V86Machine;
// A VM's local disks (o.disks: a letter's FatView), as IFSMgr answers for Windows' own drives in a VM: the drive is
// local and fixed to the IOCTLs that ask (4408h, 4409h), its device parameters, locks and media ID are the generic
// IOCTL's (440Dh), its drive parameter block is 7302h's, and its sectors are read by INT 25h and 7305h, from the view;
// its files go on through the redirector as before
const diskOf = (p, bl) => {
  const d = (bl & 0xff) || (p.m8(p.sda + 0x16) + 1), l = String.fromCharCode(64 + d);
  return p.o.disks && p.o.disks[l] ? { l, view: p.o.disks[l] } : null;
};
const segLin = (p, seg, off) => p.lin(seg, off) - p.v86;
/** DOS's extended DPB of a view (3Dh bytes, MS-DOS 7.1's, as INT 21h AX=7302h gives it) at `a`: the DPB's fields, then
 *  the free count's high word, the FAT mirroring, no FSINFO or backup boot sector, and the dword copies of the first
 *  data sector, the highest cluster, the FAT's size, the root's cluster (0: FAT16's fixed root) and where a search for
 *  a free cluster starts */
const dpbOf = (p, a, l, view) => {
  const L = view.layout(), d = l.charCodeAt(0) - 65, free = L.clusters - L.used;
  for (let i = 0; i < 0x3d; i++) p.s8(a + i, 0);
  p.s8(a, d); p.s8(a + 1, d); p.s16(a + 2, 512); p.s8(a + 4, L.spc - 1); p.s8(a + 5, Math.log2(L.spc)); p.s16(a + 6, L.reserved); p.s8(a + 8, 2);
  p.s16(a + 9, L.rootEntries); p.s16(a + 0x0b, L.dataStart); p.s16(a + 0x0d, L.clusters + 1); p.s16(a + 0x0f, L.fatSecs); p.s16(a + 0x11, L.reserved + 2 * L.fatSecs);
  p.s8(a + 0x17, 0xf8); p.s8(a + 0x18, 0); p.s32(a + 0x19, 0xffffffff); p.s16(a + 0x1d, 2); p.s16(a + 0x1f, free & 0xffff);
  p.s16(a + 0x21, free >>> 16); p.s16(a + 0x23, 0); p.s16(a + 0x25, 0xffff); p.s16(a + 0x27, 0xffff);
  p.s32(a + 0x29, L.dataStart); p.s32(a + 0x2d, L.clusters + 1); p.s32(a + 0x31, L.fatSecs); p.s32(a + 0x35, 0); p.s32(a + 0x39, 2);
};
/** the BPB as the generic IOCTL's device parameters give it, at `a` (31 bytes: FAT16's, the large sector count) */
const bpbOf = (p, a, view) => {
  const L = view.layout();
  p.s16(a, 512); p.s8(a + 2, L.spc); p.s16(a + 3, L.reserved); p.s8(a + 5, 2); p.s16(a + 6, L.rootEntries); p.s16(a + 8, 0); p.s8(a + 10, 0xf8);
  p.s16(a + 11, L.fatSecs); p.s16(a + 13, 63); p.s16(a + 15, 255); p.s32(a + 17, L.hidden); p.s32(a + 21, L.sectors);
};
const HOOK21D = HOOK[0x21];
HOOK[0x21] = function (next) {
  if (!this.o.disks) return HOOK21D.call(this, next);
  const ax = this.r('ax'), ah = ax >> 8, al = ax & 0xff, ok = () => { this.cpu.cf.value = 0; return true; }, fail = e => { this.w('ax', e); this.cpu.cf.value = 1; return true; };
  if (ah === 0x44 && (al === 0x08 || al === 0x09 || al === 0x0d || al === 0x11)) {
    const k = diskOf(this, this.r('bx')); if (!k) return HOOK21D.call(this, next);
    if (al === 0x08) { this.w('ax', 1); return ok(); }                                  // fixed
    if (al === 0x09) { this.w('dx', 0x0840); return ok(); }                             // local, not substituted (a block device's attributes)
    if (al === 0x11) { this.w('ax', 0); return ok(); }                                  // the generic IOCTL's functions: all of them
    const ch = this.r('cx') >> 8, cl = this.r('cx') & 0xff, a = segLin(this, this.cpu.ds.value, this.r('dx'));
    if (cl === 0x60 || cl === 0x40) {                                                   // device parameters (get, or set: kept as they are)
      if (cl === 0x60) { this.s8(a + 1, 5); this.s16(a + 2, 1); this.s16(a + 4, Math.ceil(k.view.layout().sectors / (255 * 63))); this.s8(a + 6, 0); bpbOf(this, a + 7, k.view); }
      return ok();
    }
    if (cl === 0x4a || cl === 0x4b || cl === 0x6a || cl === 0x6b || cl === 0x6c || cl === 0x6d) { if (cl === 0x6c) this.w('ax', 0); if (cl === 0x6d) this.w('cx', 0); return ok(); }   // locks: granted
    if (cl === 0x66) {                                                                  // media ID: the serial, no label, FAT16
      const L = k.view.layout(); this.s16(a, 0); this.s32(a + 2, L.serial); [...'NO NAME    FAT16   '].forEach((c, i) => this.s8(a + 6 + i, c.charCodeAt(0))); return ok();
    }
    if (cl === 0x61 || cl === 0x41) {                                                   // read (or write) track: head, cylinder, first sector, count, buffer
      const L = k.view.layout(), head = this.m16(a + 1), cyl = this.m16(a + 3), first = this.m16(a + 5), n = this.m16(a + 7);
      if (cl === 0x41) return fail(0x13);                                               // (write protected: the view is read)
      const lba = (cyl * 255 + head) * 63 + first, buf = segLin(this, this.m16(a + 11), this.m16(a + 9));
      this.u8.set(k.view.read(L.hidden + lba, n), this.v86 + buf); return ok();
    }
    return fail(1);                                                                     // (any other: invalid function)
  }
  if (ax === 0x7302) {                                                                  // the extended DPB: its size, then the DPB
    const k = diskOf(this, this.r('dx')); if (!k) return HOOK21D.call(this, next);
    const a = segLin(this, this.cpu.es.value, this.r('di')); this.s16(a, 0x3d); dpbOf(this, a + 2, k.l, k.view); return ok();
  }
  if (ah === 0x36) {                                                                    // free space: sectors a cluster, free clusters, bytes a sector, clusters
    const k = diskOf(this, this.r('dx')); if (!k) return HOOK21D.call(this, next);
    const L = k.view.layout(); this.w('ax', L.spc); this.w('bx', L.clusters - L.used); this.w('cx', 512); this.w('dx', L.clusters); return true;
  }
  if (ax === 0x7303) {                                                                  // the extended free space: its structure at ES:DI (DS:DX the drive's root)
    const name = ascii(this, segLin(this, this.cpu.ds.value, this.r('dx'))), k = /^[a-z]:/i.test(name) ? diskOf(this, name.toUpperCase().charCodeAt(0) - 64) : null;
    if (!k) return HOOK21D.call(this, next);
    const L = k.view.layout(), a = segLin(this, this.cpu.es.value, this.r('di')), free = L.clusters - L.used;
    for (let i = 0; i < 0x2c; i++) this.s8(a + i, 0);
    this.s16(a, 0x2c); this.s32(a + 4, L.spc); this.s32(a + 8, 512); this.s32(a + 0x0c, free); this.s32(a + 0x10, L.clusters);
    this.s32(a + 0x14, free * L.spc); this.s32(a + 0x18, L.clusters * L.spc); this.s32(a + 0x1c, free); this.s32(a + 0x20, L.clusters);
    return ok();
  }
  if (ax === 0x7305) {                                                                  // extended absolute read (SI bit 0 clear) or write
    const k = diskOf(this, this.r('dx')); if (!k) return HOOK21D.call(this, next);
    const pk = segLin(this, this.cpu.ds.value, this.r('bx')), lba = this.m32(pk), n = this.m16(pk + 4), buf = segLin(this, this.m16(pk + 8), this.m16(pk + 6));
    if (this.r('si') & 1) return fail(0x0300);
    if (this.ilog) this.ilog.push(`read ${lba} ${n}`);
    this.u8.set(k.view.read(k.view.layout().hidden + lba, n), this.v86 + buf); this.w('ax', 0); return ok();
  }
  return HOOK21D.call(this, next);
};
// INT 25h: absolute read (AL the drive, 0 for A:; CX the count and DX the sector, or CX FFFFh and DS:BX a packet of the
// sector, the count and the buffer). It returns with the flags it was entered with left on the stack, as DOS's does
HOOK[0x25] = function () {
  const view = this.o.disks && this.o.disks[String.fromCharCode(65 + this.al())]; if (!view) return false;
  const L = view.layout(); let lba = this.r('dx'), n = this.r('cx'), buf = segLin(this, this.cpu.ds.value, this.r('bx'));
  if (n === 0xffff) { const pk = buf; lba = this.m32(pk); n = this.m16(pk + 4); buf = segLin(this, this.m16(pk + 8), this.m16(pk + 6)); }
  this.u8.set(view.read(L.hidden + lba, n), this.v86 + buf); this.w('ax', 0); this.cpu.cf.value = 0;
  const c = this.cpu, fl = 0x0202 | (c.zf.value & 1) << 6 | (c.sf.value & 1) << 7 | (c.df.value & 1) << 10 | (c.of.value & 1) << 11;
  c.esp.value = (c.esp.value & 0xffff0000) | ((c.esp.value - 2) & 0xffff); this.dv.setUint16(this.lin(c.ss.value, c.esp.value), fl, true);
  return true;
};
// (a diagnostic: each INT 21h and 2Fh a machine with an `ilog` takes, its AX, BX, CX and DX, the last 3000; vmm.js
// gives a VM's one)
for (const n of [0x21, 0x2f]) {
  const h = HOOK[n];
  HOOK[n] = function (next) {
    if (this.ilog && !(n === 0x21 && this.ah() === 0x0b)) { this.ilog.push(`${n.toString(16)}:${['ax', 'bx', 'cx', 'dx'].map(r => this.r(r).toString(16)).join(' ')}`); if (this.ilog.length > 3000) this.ilog.shift(); }
    return h.call(this, next);
  };
}
window.W95V86 = M;
})();
