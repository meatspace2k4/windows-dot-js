'use strict';
// The sound hardware under the CD's MSSNDSYS.DRV: a Windows Sound System card (an AD1848 codec behind the card's
// configuration register), the PC's 8237 DMA controller that feeds it and the 8259 interrupt controller its interrupt
// goes through. Native code reaches them with IN and OUT (ne16.js portIO); what the codec plays goes to Web Audio.
// MSSNDSYS.VXD's part (the card's record, its DMA buffer) is in ne16.js as the VxD's API.
(function () {
const P = window.W95Win32.Process.prototype;

// the card as WAVE.INF's *PNPB007 factory configuration has it: configuration register 530h, codec 534h-537h, the OPL3
// synthesizer's ports 388h-38Bh, IRQ 7, DMA channel 1. Its devnode is the one Setup made for it (win95.js setupSound)
const WSS = { devnode: 'ROOT\\*PNPB007\\0000', cfg: 0x530, codec: 0x534, opl: 0x388, irq: 7, dma: 1 };
P.cards = function () { return [{ devnode: WSS.devnode, io: [[WSS.cfg, 8], [WSS.opl, 4]], irq: [WSS.irq], dma: [WSS.dma], wss: WSS }]; };

// ---------------------------------------------------------------- 8259 interrupt controllers
// the mask registers (21h, A1h) and in-service state; an interrupt is delivered to the vector the driver set for it
// (INT 21h AH=25h: 08h-0Fh for IRQ 0-7, 70h-77h for IRQ 8-15) once nothing of its level is in service
const pic = p => p.pic || (p.pic = { imr: [0, 0], isr: 0 });
const irqVector = irq => (irq < 8 ? 8 + irq : 0x68 + irq);
// It can arrive between slices or while native code polls the hardware or the clock (sound16 from soundIO and VTDAPI),
// as an interrupt arrives between two instructions: the code it interrupts gets its registers and flags back
const FLAGS = ['cf', 'pf', 'af', 'zf', 'sf', 'of', 'df'];
P.raiseIRQ = function (irq) {
  const c = pic(this);
  if (c.imr[irq >> 3] & (1 << (irq & 7)) || c.isr & (1 << irq) || this.inIRQ) return false;
  // an IRQ a VxD virtualized (VPICD_Virtualize_IRQ) goes to its hardware interrupt procedure, which reflects it into
  // the VM (VPICD_Set_Int_Request) and ends it (VPICD_Phys_EOI) as it sees fit
  const v = this.vpicd && this.vpicd.byIrq.get(irq);
  if (v) {
    c.isr |= 1 << irq; this.inIRQ = true;
    try { this.vxdCall(v.hw, { eax: v.handle, ebx: this.sysVM(), edx: v.ref }); } finally { this.inIRQ = false; }
    if (!this.r0Depth) this.vmIrqDeliver();   // else as the ring-0 code it interrupted returns
    return true;
  }
  if (!this.dosVec || !this.dosVec[irqVector(irq)]) return false;
  c.isr |= 1 << irq;
  return this.vmIRQ(irq);
};
/** the VM's handler for an IRQ (the vector its driver set), run with an interrupt frame */
P.vmIRQ = function (irq) {
  const h = this.dosVec && this.dosVec[irqVector(irq)]; if (!h || this.inIRQ) return false;
  this.inIRQ = true;
  const fl = FLAGS.filter(f => this.cpu[f]).map(f => [f, this.cpu[f].value]);
  this.tick16();
  try { this.call16(h >>> 16, h & 0xffff, [['w', 0x202]]); }   // an interrupt frame: IRET pops IP, CS and the flags
  finally { this.inIRQ = false; for (const [f, v] of fl) this.cpu[f].value = v; }
  return true;
};

// ---------------------------------------------------------------- 8237 DMA controller (channels 0-3, 8-bit)
const DMA_PAGE = { 0x87: 0, 0x83: 1, 0x81: 2, 0x82: 3 };
const dmac = p => p.dmac || (p.dmac = { ff: 0, ch: [0, 1, 2, 3].map(() => ({ base: 0, cur: 0, bcount: 0, count: 0, mode: 0, page: 0, masked: true, tc: false })) });
/** the count register of the card's playback channel (the VxD's VDMAD_Get_Phys_Count) */
P.dmaCount = function () { return dmac(this).ch[WSS.dma].count; };
/** an 8237 channel's registers (VDMAD programs them from its virtual state) */
P.dmaChannel = function (n) { return dmac(this).ch[n & 3]; };
/** the 8259s' state (VPICD) */
P.picState = function () { return pic(this); };
/** n bytes from a DMA channel (memory to device); fewer when it is masked or reaches its end without auto-init */
P.dmaRead = function (chn, n) {
  const d = dmac(this).ch[chn], out = new Uint8Array(n); let k = 0;
  while (k < n && !d.masked) {
    out[k++] = this.u8[(d.page << 16) | d.cur];
    d.cur = (d.cur + 1) & 0xffff;
    if (d.count === 0) { d.tc = true; if (d.mode & 0x10) { d.cur = d.base; d.count = d.bcount; } else { d.masked = true; d.count = 0xffff; } }
    else d.count--;
  }
  return k === n ? out : out.subarray(0, k);
};

// ---------------------------------------------------------------- AD1848 codec
// indirect registers 0-15: 6/7 DAC attenuation (bits 0-5 in 1.5 dB steps, bit 7 mute), 8 clock and data format,
// 9 interface configuration (bit 0 playback enable), 10 pin control (bit 1 interrupt enable), 11 test and
// initialisation (bit 5 auto-calibration in progress), 12 version (0Ah: AD1848), 14/15 the base count
const XTAL = [24576000, 16934400], DIV = [3072, 1536, 896, 768, 448, 384, 512, 2560];
const codec = p => p.ad1848 || (p.ad1848 = { idx: 0, mce: false, trd: false, regs: Uint8Array.from([0, 0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0, 0, 0, 0, 0x0a, 0, 0, 0]), int: false, count: 0, frac: 0, last: 0, cfg: 0 });
const rateOf = r8 => XTAL[r8 & 1] / DIV[(r8 >> 1) & 7];
// ---------------------------------------------------------------- OPL3 (YMF262) at 388h-38Bh
// The synthesizer's register file (two banks: 388h/389h and 38Ah/38Bh) and its two timers, as drivers detect the chip:
// timer 1 counts in 80 us steps from register 2, timer 2 in 320 us steps from register 3; register 4 starts them
// (bits 0, 1), masks them (bits 6, 5) and resets the flags (bit 7). The status port reads 80h (an interrupt) with 40h
// (timer 1) and 20h (timer 2). Time runs on the bus: each access to the chip takes 1 us, as an ISA read does
const opl = p => p.opl3 || (p.opl3 = { idx: [0, 0], regs: [new Uint8Array(256), new Uint8Array(256)], t: 0, start: [0, 0], flags: 0 });
const oplTime = (p, o) => { o.t = Math.max(o.t + 0.001, p.now()); return o.t; };
const oplStatus = (p, o) => {
  const now = oplTime(p, o), r = o.regs[0][4];
  [[1, 2, 0.08, 0x40, 0x40], [2, 3, 0.32, 0x20, 0x20]].forEach(([bit, reg, step, flag, mask], i) => {
    if (r & bit && !(r & mask) && now - o.start[i] >= (256 - o.regs[0][reg]) * step) o.flags |= flag;
  });
  return o.flags ? o.flags | 0x80 : 0;
};
P.oplIO = function (port, isIn, v) {
  // one address latch for both banks: an address write at 388h or 38Ah picks the register and its bank, and a data
  // write at either data port goes to that register
  const o = opl(this);
  if (isIn) return port === WSS.opl ? oplStatus(this, o) : 0xff;
  oplTime(this, o);
  if (!(port & 1)) { o.idx = [v, (port - WSS.opl) >> 1]; return 0; }
  const [r, bank] = o.idx;
  this.oplRender();   // the sound up to this moment comes from the registers as they were
  o.regs[bank][r] = v; fm(o).write(bank, r, v);
  if (bank === 0 && r === 4) {
    if (v & 0x80) o.flags = 0;
    else { if (v & 1) o.start[0] = o.t; if (v & 2) o.start[1] = o.t; }
  }
  return 0;
};
// ---------------------------------------------------------------- OPL3 synthesis
// The YMF262's sound: 36 operators (18 per register bank) at the chip's 49716 Hz. An operator is a phase generator
// (F-number, block, multiplier, vibrato) reading one of 8 waveforms, scaled by its envelope (attack, decay, sustain,
// release, key scaling), total level, key-scale level and tremolo. A channel joins two operators by FM (the first
// modulating the second) or by adding them, with feedback on the first; channel pairs 0-3, 1-4, 2-5 of either bank
// can join four (register 104h). The output goes left and right as register C0h's bits 4 and 5 say (OPL3 mode, 105h)
const OPL_RATE = 49716;
const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
// key-scale level: by the F-number's top 4 bits, in 0.75 dB steps at block 8, 6 dB less per block below; register
// bits 6-7 take 0, 1/2, 1/4 or all of it (0, 3, 1.5, 6 dB per octave)
const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const OP_OF_SLOT = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17];
const CH_OPS = [[0, 3], [1, 4], [2, 5], [6, 9], [7, 10], [8, 11], [12, 15], [13, 16], [14, 17]];
const wave = (w, ph) => {   // ph in cycles [0, 1)
  const s = Math.sin(2 * Math.PI * ph), half = ph < 0.5;
  switch (w) {
    case 0: return s;
    case 1: return half ? s : 0;
    case 2: return Math.abs(s);
    case 3: return (ph % 0.5) < 0.25 ? Math.abs(s) : 0;
    case 4: return half ? Math.sin(4 * Math.PI * ph) : 0;
    case 5: return half ? Math.abs(Math.sin(4 * Math.PI * ph)) : 0;
    case 6: return half ? 1 : -1;
    default: { const x = half ? ph * 2 : (ph - 0.5) * 2; const e = Math.pow(2, -x * 8); return half ? e : -e; }
  }
};
const ATTACK_MS = r => 2826 / Math.pow(2, r - 1), DECAY_MS = r => 39280 / Math.pow(2, r - 1);
class FM {
  constructor() {
    this.ops = Array.from({ length: 36 }, () => ({ am: 0, vib: 0, egt: 0, ksr: 0, mult: 1, ksl: 0, tl: 0, ar: 0, dr: 0, sl: 0, rr: 0, ws: 0,
      phase: 0, env: 96, stage: 'off', out: 0, prev: 0 }));
    this.ch = Array.from({ length: 18 }, () => ({ fnum: 0, block: 0, key: false, fb: 0, cnt: 0, l: true, r: true }));
    this.r104 = 0; this.opl3 = false; this.bd = 0; this.t = 0;
  }
  op(bank, slot) { const k = OP_OF_SLOT[slot]; return k < 0 ? null : this.ops[bank * 18 + k]; }
  write(bank, r, v) {
    const lo = r & 0x1f, hi = r & 0xe0;
    if (bank === 1 && r === 4) { this.r104 = v & 0x3f; return; }
    if (bank === 1 && r === 5) { this.opl3 = !!(v & 1); return; }
    if (bank === 0 && r === 0xbd) { this.bd = v; return; }
    if (hi === 0x20 || hi === 0x40 || hi === 0x60 || hi === 0x80 || hi === 0xe0) {
      if (lo > 0x15) return; const o = this.op(bank, lo); if (!o) return;
      if (hi === 0x20) { o.am = v >> 7; o.vib = (v >> 6) & 1; o.egt = (v >> 5) & 1; o.ksr = (v >> 4) & 1; o.mult = MULT[v & 15]; }
      else if (hi === 0x40) { o.ksl = v >> 6; o.tl = v & 0x3f; }
      else if (hi === 0x60) { o.ar = v >> 4; o.dr = v & 15; }
      else if (hi === 0x80) { o.sl = v >> 4; o.rr = v & 15; }
      else o.ws = v & (this.opl3 ? 7 : 3);
      return;
    }
    const c = r & 0x0f, row = r & 0xf0; if (c > 8 || row < 0xa0 || row > 0xc0) return;
    const ch = this.ch[bank * 9 + c];
    if (row === 0xa0) ch.fnum = (ch.fnum & 0x300) | v;
    else if (row === 0xb0) {
      ch.fnum = (ch.fnum & 0xff) | ((v & 3) << 8); ch.block = (v >> 2) & 7;
      const key = !!(v & 0x20);
      if (key !== ch.key) { ch.key = key; for (const k of CH_OPS[c]) this.keyOp(this.ops[bank * 18 + k], key); }
    } else { ch.cnt = v & 1; ch.fb = (v >> 1) & 7; ch.l = !!(v & 0x10); ch.r = !!(v & 0x20); }
  }
  keyOp(o, on) { if (on) { o.stage = 'attack'; o.phase = 0; } else if (o.stage !== 'off') o.stage = 'release'; }
  /** one operator's next sample (-1..1), its phase moved on, with phase modulation `mod` (cycles) */
  opSample(o, ch, mod, trem, vibf) {
    const freq = ch.fnum * Math.pow(2, ch.block) * OPL_RATE / 1048576 * o.mult * (o.vib ? vibf : 1);
    o.phase = (o.phase + freq / OPL_RATE) % 1;
    // envelope, in dB of attenuation (0 loudest, 96 silent); key scaling speeds the rates up for higher notes
    const rof = ((ch.block << 1) | (ch.fnum >> 9)) >> (o.ksr ? 0 : 2), spd = r => (r ? Math.pow(2, rof / 4) : 0), dt = 1000 / OPL_RATE;
    if (o.stage === 'attack') { if (o.ar === 15) o.env = 0; else if (o.ar) { o.env -= 96 * dt / (ATTACK_MS(o.ar) / spd(o.ar)) * (1 + o.env / 24); } if (o.env <= 0) { o.env = 0; o.stage = 'decay'; } }
    else if (o.stage === 'decay') { const sl = o.sl === 15 ? 93 : o.sl * 3; if (o.dr) o.env += 96 * dt / (DECAY_MS(o.dr) / spd(o.dr)); if (o.env >= sl) { o.env = sl; o.stage = o.egt ? 'sustain' : 'release2'; } }
    else if (o.stage === 'release2' || o.stage === 'release') { const rr = o.rr; if (rr) o.env += 96 * dt / (DECAY_MS(rr) / spd(rr)); if (o.env >= 96) { o.env = 96; o.stage = 'off'; } }
    if (o.stage === 'off') return 0;
    const ksl = o.ksl ? Math.max(0, KSL_ROM[ch.fnum >> 6] * 0.75 - (8 - ch.block) * 6) * [0, 0.5, 0.25, 1][o.ksl] : 0;
    const att = o.env + o.tl * 0.75 + ksl + (o.am ? trem : 0);
    if (att >= 96) return 0;
    return wave(o.ws, ((o.phase + mod) % 1 + 1) % 1) * Math.pow(10, -att / 20);
  }
  /** `n` samples into L, R */
  render(L, R, n) {
    const amDepth = this.bd & 0x80 ? 4.8 : 1, vibDepth = this.bd & 0x40 ? 14 : 7;
    for (let i = 0; i < n; i++, this.t++) {
      const tt = this.t / OPL_RATE, trem = amDepth * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.7 * tt)), vibf = Math.pow(2, vibDepth / 1200 * Math.sin(2 * Math.PI * 6.1 * tt));
      let l = 0, r = 0;
      for (let b = 0; b < 2; b++) for (let c = 0; c < 9; c++) {
        const idx = b * 9 + c, ch = this.ch[idx];
        const pair = c < 3 && this.opl3 && (this.r104 >> (b * 3 + c)) & 1, second = c >= 3 && c < 6 && this.opl3 && (this.r104 >> (b * 3 + c - 3)) & 1;
        if (second) continue;   // its operators play in the four-operator channel
        const [k1, k2] = CH_OPS[c], o1 = this.ops[b * 18 + k1], o2 = this.ops[b * 18 + k2];
        if (o1.stage === 'off' && o2.stage === 'off' && !pair) continue;
        const fbm = ch.fb ? (o1.out + o1.prev) * 4 / Math.pow(2, 9 - ch.fb) : 0;
        const s1 = this.opSample(o1, ch, fbm, trem, vibf); o1.prev = o1.out; o1.out = s1;
        let v;
        if (!pair) v = ch.cnt ? s1 + this.opSample(o2, ch, 0, trem, vibf) : this.opSample(o2, ch, s1 * 4, trem, vibf);
        else {
          const ch2 = this.ch[idx + 3], [k3, k4] = CH_OPS[c + 3], o3 = this.ops[b * 18 + k3], o4 = this.ops[b * 18 + k4];
          const alg = ch.cnt | (ch2.cnt << 1);
          if (alg === 0) { const a2 = this.opSample(o2, ch, s1 * 4, trem, vibf), a3 = this.opSample(o3, ch, a2 * 4, trem, vibf); v = this.opSample(o4, ch, a3 * 4, trem, vibf); }
          else if (alg === 1) { const a2 = this.opSample(o2, ch, 0, trem, vibf), a3 = this.opSample(o3, ch, a2 * 4, trem, vibf); v = s1 + this.opSample(o4, ch, a3 * 4, trem, vibf); }
          else if (alg === 2) { const a2 = this.opSample(o2, ch, s1 * 4, trem, vibf), a3 = this.opSample(o3, ch, 0, trem, vibf); v = a2 + this.opSample(o4, ch, a3 * 4, trem, vibf); }
          else { const a2 = this.opSample(o2, ch, 0, trem, vibf), a3 = this.opSample(o3, ch, a2 * 4, trem, vibf); v = s1 + a3 + this.opSample(o4, ch, 0, trem, vibf); }
        }
        if (!this.opl3 || ch.l) l += v; if (!this.opl3 || ch.r) r += v;
      }
      L[i] += l * 0.12; R[i] += r * 0.12;
    }
  }
  active() { return this.ops.some(o => o.stage !== 'off'); }
}
const fm = o => o.fm || (o.fm = new FM());
/** the synthesizer's sound from where it last stopped up to now, queued for the page's audio output */
P.oplRender = function () {
  const o = this.opl3; if (!o || !o.fm) return;
  const f = o.fm, now = this.now();
  if (f.at === undefined) f.at = now;
  let n = Math.floor((now - f.at) * OPL_RATE / 1000);
  if (n <= 0) return;
  f.at += n * 1000 / OPL_RATE;
  if (n > OPL_RATE / 4) n = Math.floor(OPL_RATE / 4);   // after a stall, a quarter second at most
  if (!f.active()) { f.t += n; return; }
  const L = new Float32Array(n), R = new Float32Array(n); f.render(L, R, n);
  play(this, OPL_RATE, L, R, n);
};
P.soundIO = function (port, size, isIn) {
  const eax = this.cpu.eax.value, v = eax & 0xff;
  const ret = r => { this.cpu.eax.value = (eax & ~0xff) | (r & 0xff); return true; };
  if (port >= WSS.opl && port < WSS.opl + 4) { const r = this.oplIO(port, isIn, v); return isIn ? ret(r) : true; }
  if (port >= WSS.cfg && port < WSS.cfg + 4) {
    const c = codec(this);
    if (!isIn) { if (port === WSS.cfg) c.cfg = v; return true; }
    // 533h: the card's ID (04h: a Windows Sound System card), bit 6 set once an interrupt line is selected (bits 3-5 of
    // the configuration register) and the card sees it, bit 7 clear (a 16-bit slot)
    return ret(port === WSS.cfg + 3 ? 0x04 | (c.cfg & 0x38 ? 0x40 : 0) : 0xff);
  }
  if (port >= WSS.codec && port < WSS.codec + 4) {
    const c = codec(this), off = port - WSS.codec;
    if (off === 0) {
      if (isIn) return ret(c.idx | (c.trd ? 0x20 : 0) | (c.mce ? 0x40 : 0));
      c.idx = v & 0x0f; c.trd = !!(v & 0x20); c.mce = !!(v & 0x40); return true;
    }
    if (off === 1) {
      if (isIn) return ret(c.idx === 11 ? c.regs[11] & ~0x20 : c.regs[c.idx]);
      if (c.idx === 12) { c.regs[12] = (c.regs[12] & 0x0f) | (v & 0xf0); return true; }
      if (c.idx === 11) return true;
      this.sound16();   // the samples due up to this write play with the registers as they were
      const was = c.regs[c.idx]; c.regs[c.idx] = v;
      if (c.idx === 9 && (v & 1) && !(was & 1)) { c.count = (c.regs[14] << 8) | c.regs[15]; c.frac = 0; c.last = this.now(); }
      if (c.idx === 15 || c.idx === 14) c.count = (c.regs[14] << 8) | c.regs[15];
      return true;
    }
    if (off === 2) {   // status: INT, PRDY; a write clears INT. A driver polling it sees the codec move on
      if (isIn) { this.sound16(); return ret((c.int ? 1 : 0) | 0x02); }
      c.int = false; return true;
    }
    if (isIn) return ret(0);                                                                        // 537h: programmed I/O, unused
    return true;
  }
  if (port === 0x20 || port === 0xa0) {
    if (!isIn && (v & 0x20)) {   // EOI: for an IRQ a VxD virtualized, its EOI procedure decides (VPICD_Phys_EOI)
      const c = pic(this), lo = port === 0x20 ? 0 : 8;
      for (let i = lo; i < lo + 8; i++) if (c.isr & (1 << i)) {
        const vi = this.vpicd && this.vpicd.byIrq.get(i);
        if (vi && vi.eoi) this.vxdCall(vi.eoi, { eax: vi.handle, ebx: this.sysVM() }); else c.isr &= ~(1 << i);
        break;
      }
    }
    return isIn ? ret(0) : true;
  }
  if (port === 0x21 || port === 0xa1) { const c = pic(this), i = port === 0x21 ? 0 : 1; if (isIn) return ret(c.imr[i]); c.imr[i] = v; return true; }
  if (port <= 0x0f || port in DMA_PAGE) {
    const d = dmac(this);
    if (isIn) this.sound16();   // a driver reading the DMA counters sees them move
    if (port in DMA_PAGE) { const ch = d.ch[DMA_PAGE[port]]; if (isIn) return ret(ch.page); ch.page = v; return true; }
    if (port < 8) {
      const ch = d.ch[port >> 1], cnt = port & 1, hi = d.ff; d.ff ^= 1;
      if (isIn) { const x = cnt ? ch.count : ch.cur; return ret(hi ? x >> 8 : x); }
      const set = (o, x) => (hi ? (o & 0xff) | (x << 8) : (o & 0xff00) | x);
      if (cnt) ch.bcount = ch.count = set(ch.bcount, v); else ch.base = ch.cur = set(ch.base, v);
      return true;
    }
    if (port === 0x08) { if (!isIn) return true; let s = 0; d.ch.forEach((c, i) => { if (c.tc) { s |= 1 << i; c.tc = false; } }); return ret(s); }
    if (isIn) return ret(0xff);
    if (port === 0x0a) { d.ch[v & 3].masked = !!(v & 4); return true; }
    if (port === 0x0b) { d.ch[v & 3].mode = v; return true; }
    if (port === 0x0c) { d.ff = 0; return true; }
    if (port === 0x0d) { d.ff = 0; d.ch.forEach(c => { c.masked = true; }); return true; }
    if (port === 0x0e) { d.ch.forEach(c => { c.masked = false; }); return true; }
    if (port === 0x0f) { d.ch.forEach((c, i) => { c.masked = !!(v & (1 << i)); }); return true; }
    return true;
  }
  return false;
};

// ---------------------------------------------------------------- playback
// The host runs this between slices: the codec takes the samples due since it last ran from its DMA channel at its
// rate, counts them down from the base count and raises its interrupt when the count runs out; the samples go to the
// page's audio output, scheduled one after another
const ULAW = new Float32Array(256), ALAW = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  let u = ~i & 0xff, t = ((u & 0x0f) << 3) + 0x84; t <<= (u & 0x70) >> 4; ULAW[i] = ((u & 0x80) ? 0x84 - t : t - 0x84) / 32768;
  let a = i ^ 0x55, m = (a & 0x0f) << 4, e = (a & 0x70) >> 4; m = e ? (m + 0x108) << (e - 1) : m + 8; ALAW[i] = ((a & 0x80) ? m : -m) / 32768;
}
// Each source (the codec, the synthesizer) plays on an output context of its own running at the source's own rate,
// through one worklet node that takes the samples from a queue as the context renders: the samples reach the context
// unchanged and in one continuous stream (no buffer started per batch, each start time landing between two samples),
// and the browser converts the context's output to the device's rate. After the queue runs dry, output starts again
// once LEAD seconds of samples are queued, or the first of them has waited that long
const LEAD = 0.1;
const WORKLET = `registerProcessor('w95-stream', class extends AudioWorkletProcessor {
  constructor(o) { super(); this.q = []; this.at = 0; this.n = 0; this.lead = o.processorOptions.lead; this.on = false; this.wait = 0;
    this.port.onmessage = e => { this.q.push(e.data); this.n += e.data[0].length; }; }
  process(_, outputs) {
    const L = outputs[0][0], R = outputs[0][1] || outputs[0][0];
    if (!this.on && this.n) { this.wait += L.length; if (this.n >= this.lead || this.wait >= this.lead) { this.on = true; this.wait = 0; } }   // a short sound starts after the lead too
    let k = 0;
    while (this.on && k < L.length && this.q.length) {
      const [a, b] = this.q[0], m = Math.min(L.length - k, a.length - this.at);
      L.set(a.subarray(this.at, this.at + m), k); R.set(b.subarray(this.at, this.at + m), k);
      k += m; this.at += m; this.n -= m;
      if (this.at === a.length) { this.q.shift(); this.at = 0; }
    }
    if (k < L.length) { if (this.on) this.port.postMessage(1); this.on = false; L.fill(0, k); R.fill(0, k); }   // ran dry
    return true;
  }
});`;
// each machine has outputs of its own: two programs' samples never share a queue
const out = (proc, rate) => {
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  rate = Math.min(Math.max(Math.round(rate), 3000), 768000);
  const outs = proc.audioOuts || (proc.audioOuts = new Map());
  let a = outs.get(rate);
  if (!a) {
    let ctx; try { ctx = new AC({ sampleRate: rate }); } catch (_) { return null; }
    a = { ctx, node: null, pending: [], dry: 0 };
    outs.set(rate, a);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    ctx.audioWorklet.addModule(url).then(() => {
      a.node = new AudioWorkletNode(ctx, 'w95-stream', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { lead: Math.round(LEAD * rate) } });
      a.node.port.onmessage = () => { a.dry++; };
      a.node.connect(ctx.destination);
      for (const m of a.pending) a.node.port.postMessage(m, [m[0].buffer, m[1].buffer]);
      a.pending = [];
    });
    const resume = () => { if (ctx.state === 'suspended') ctx.resume(); };
    a.resume = resume;
    for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, resume, true);
  }
  return a;
};
/** close the machine's outputs (its program has exited) */
P.soundClose = function () {
  for (const a of (this.audioOuts || new Map()).values()) {
    for (const t of ['pointerdown', 'keydown']) window.removeEventListener(t, a.resume, true);
    try { a.ctx.close(); } catch (_) { }
  }
  this.audioOuts = null;
};
/** queue n samples (L, R) on the output at `rate`; true if it had run dry while sounding since the last call */
const play = (proc, rate, L, R, n) => {
  if (proc.audioOuts === null) return false;   // closed
  const a = out(proc, rate); if (!a) return false;
  const m = [Float32Array.from(L.subarray(0, n)), Float32Array.from(R.subarray(0, n))];
  if (a.node) a.node.port.postMessage(m, [m[0].buffer, m[1].buffer]); else a.pending.push(m);
  const dry = a.dry > 0; a.dry = 0; return dry;
};
P.sound16 = function () {
  if (!this.inSound) this.oplRender();
  const c = this.ad1848; if (!c || !(c.regs[9] & 1) || this.inIRQ || this.inSound) return;
  this.inSound = true;
  try { this.soundRun(c); } finally { this.inSound = false; }
};
P.soundRun = function (c) {
  const now = this.now(), rate = rateOf(c.regs[8]), dt = Math.min(now - c.last, 250); c.last = now;
  c.frac += rate * dt / 1000; let frames = Math.floor(c.frac); c.frac -= frames;
  if (frames <= 0) return;
  const stereo = !!(c.regs[8] & 0x10), fmt = (c.regs[8] >> 5) & 3, bps = fmt === 2 ? 2 : 1, ch = stereo ? 2 : 1;
  let irq = false;
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const gain = r => (r & 0x80 ? 0 : Math.pow(10, -1.5 * (r & 0x3f) / 20));
  const gl = gain(c.regs[6]), gr = gain(c.regs[7]);
  // the codec interrupts as its count runs out, and the driver's handler refills the half of the buffer just played
  // before the codec reads on: the samples due are taken a block at a time, the interrupt raised between blocks
  this.soundStats = this.soundStats || { frames: 0, irqs: 0 };
  let k = 0;
  const v = this.vpicd && this.vpicd.byIrq.get(WSS.irq);
  while (k < frames && (c.regs[9] & 1)) {
    // the last interrupt not yet handled (unacknowledged, or reflected to the VM and waiting for ring 0 to return
    // there): the half its handler refills is not ready, so the frames still due wait for the next run
    if ((c.int || (v && v.request)) && (c.regs[10] & 2)) { c.frac += frames - k; break; }
    let end = false;
    for (; k < frames; k++) {
      const b = this.dmaRead(WSS.dma, bps * ch); if (b.length < bps * ch) { end = true; break; }
      const s = j => (fmt === 0 ? (b[j] - 128) / 128 : fmt === 1 ? ULAW[b[j]] : fmt === 3 ? ALAW[b[j]] : ((b[j] | (b[j + 1] << 8)) << 16 >> 16) / 32768);
      L[k] = s(0) * gl; R[k] = (stereo ? s(bps) : s(0)) * gr;
      if (c.count === 0) { c.count = (c.regs[14] << 8) | c.regs[15]; c.int = true; irq = true; k++; break; } else c.count--;
    }
    if (irq) { irq = false; if (c.regs[10] & 2) { this.soundStats.irqs++; this.raiseIRQ(WSS.irq); } }
    if (end) break;
  }
  this.soundStats.frames += k;
  if (k && play(this, rate, L, R, k)) this.soundStats.underruns = (this.soundStats.underruns || 0) + 1;
};
})();
