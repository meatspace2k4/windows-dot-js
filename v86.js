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
HOOK[0x2f] = function () {
  if (this.r('ax') === 0x4300) { this.setAL(0x80); return true; }                                       // XMS: installed
  if (this.r('ax') === 0x4310) { this.sreg('es', ROM >> 4); this.w('bx', XMS.entry); return true; }       // its entry
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

window.W95V86 = M;
})();
