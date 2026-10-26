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
const SDA = { DTA: 0x0c, FN1: 0x9e, FN2: 0x11e, SDB: 0x19e, DIRENT: 0x1b3, SATTR: 0x24d, XACTION: 0x2dd, XATTR: 0x2df, XMODE: 0x2e1 };
const HOOK21 = HOOK[0x21];
HOOK[0x21] = function (next) {
  if (this.ah() === 0x52 && !this.lol) this.want52 = next;   // (its answer, ES:BX, read as the call returns: v86Run)
  // (the drives taken as the shell is run, once DOS has its drive table from CONFIG.SYS: IO.SYS's own EXECs of
  // WINBOOT.SYS and IO.SYS come before it; and again should DOS make the table anew)
  if (this.lol && this.o.fs) {
    if (!this.drivesTaken && this.ah() === 0x4b && this.al() === 0 && /COMMAND\.COM$/i.test(ascii(this, this.lin(this.cpu.ds.value, this.r('dx')) - this.v86))) this.takeDrives();
    else if (this.drivesTaken && this.m32(this.lol + 0x16) !== this.cdsAt) this.takeDrives();
  }
  return HOOK21.call(this, next);
};
P.takeDrives = function () {
  this.drivesTaken = true; this.cdsAt = this.m32(this.lol + 0x16);
  const lol = this.lol, cds =this.lin(this.m16(lol + 0x18), this.m16(lol + 0x16)) - this.v86, last = this.m8(lol + 0x21);
  this.sda = lol - 0x26 + 0x320;   // (the List of Lists is at DOS's data segment:0026h, the SDA at :0320h)
  for (const v of this.o.fs.volumes()) {
    const d = v.letter.charCodeAt(0) - 65; if (d < 2 || d >= last || v.kind === 'remote') continue;
    const e = cds + d * 0x58;
    const path = `${v.letter}:\\`; for (let i = 0; i < 67; i++) this.s8(e + i, i < path.length ? path.charCodeAt(i) : 0);
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
