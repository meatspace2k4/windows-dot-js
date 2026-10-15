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
    if (v.request) { v.request = false; this.vmIRQ(irq); }
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
  const o = opl(this), bank = (port - WSS.opl) >> 1;
  if (isIn) return port === WSS.opl ? oplStatus(this, o) : 0xff;
  oplTime(this, o);
  if (!(port & 1)) { o.idx[bank] = v; return 0; }
  const r = o.idx[bank]; o.regs[bank][r] = v;
  if (bank === 0 && r === 4) {
    if (v & 0x80) o.flags = 0;
    else { if (v & 1) o.start[0] = o.t; if (v & 2) o.start[1] = o.t; }
  }
  return 0;
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
let audio = null;
const out = () => {
  if (audio) return audio;
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  audio = { ctx: new AC(), next: 0 }; window.W95AUDIO = audio;   // (the page's output, for a look from the console)
  const resume = () => { if (audio.ctx.state === 'suspended') audio.ctx.resume(); };
  for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, resume, true);
  return audio;
};
P.sound16 = function () {
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
  while (k < frames && (c.regs[9] & 1)) {
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
  const a = k && out();
  if (a) {
    const buf = a.ctx.createBuffer(2, k, Math.min(Math.max(rate, 3000), 768000));
    buf.copyToChannel(L.subarray(0, k), 0); buf.copyToChannel(R.subarray(0, k), 1);
    const src = a.ctx.createBufferSource(); src.buffer = buf; src.connect(a.ctx.destination);
    // back to back with what is queued; only after the queue has run dry does it start again 100 ms ahead
    if (a.next < a.ctx.currentTime + 0.005) a.next = a.ctx.currentTime + 0.1;
    src.start(a.next); a.next += k / rate;
  }
};
})();
