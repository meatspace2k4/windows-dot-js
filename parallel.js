'use strict';
// The printer port under the CD's LPT.VXD: a standard (SPP) parallel port at I/O 378h-37Ah with no interrupt, as
// MSPORTS.INF's first logical configuration for *PNP0400 (lsnn) has it (IRQ 7 is the sound card's: sound.js), set up as
// win95.js setupPorts does it, with a printer on the cable that is always ready. Native code reaches the
// port with IN and OUT (ne16.js portIO): the data latch (378h), the printer's status lines (379h: BUSY#, ACK#, PE,
// SELECT, ERROR#) and the control lines (37Ah: STROBE, AUTOFD, INIT#, SELECTIN, the interrupt enable). A byte is taken
// on the strobe, and the printer acknowledges it, which interrupts when the driver enabled that. What arrives is the
// printer's: each job (from the printer's reset, INIT#, or the first byte after the line went quiet) is saved through
// the file system as C:\PRINTOUT\LPT1-<date>-<time>.PRN
(function () {
const P = window.W95Win32.Process.prototype;
const LPT = { devnode: 'ROOT\\*PNP0400\\0000', io: 0x378, irq: 0 }, QUIET_MS = 3000, DIR = 'C:\\PRINTOUT';
const cards0 = P.cards;
P.cards = function () { const c = cards0 ? cards0.call(this) : []; return this.host && this.host.net ? c : [...c, { devnode: LPT.devnode, io: [[LPT.io, 3]], irq: LPT.irq ? [LPT.irq] : [], dma: [], lpt: LPT }]; };
const port = p => p.lpt || (p.lpt = { data: 0, ctl: 0x0c, job: [], timer: 0 });
// the status lines of a ready printer: not busy (BUSY# high), ACK# high, paper in (PE low), on line (SELECT), no error
const STATUS = 0x80 | 0x40 | 0x10 | 0x08 | 0x04 | 0x03;
const stamp = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
/** the job the printer has received, saved (and a new one begun) */
P.lptFlush = function () {
  const s = port(this); clearTimeout(s.timer); s.timer = 0;
  if (!s.job.length) return;
  const bytes = Uint8Array.from(s.job); s.job = [];
  try {
    this.fs.mkdir(DIR, { recursive: true });
    let f = `${DIR}\\LPT1-${stamp()}.PRN`;
    for (let n = 2; this.fs.exists(f); n++) f = `${DIR}\\LPT1-${stamp()}-${n}.PRN`;
    this.fs.writeFile(f, bytes);
  } catch (e) { console.error('[lpt]', e); }
};
P.lptIO = function (port0, size, isIn) {
  if (port0 < LPT.io || port0 > LPT.io + 2 || (this.host && this.host.net)) return false;
  const s = port(this), off = port0 - LPT.io, ret = v => { this.cpu.eax.value = (this.cpu.eax.value & ~0xff) | (v & 0xff); return true; };
  if (off === 0) { if (isIn) return ret(s.data); s.data = this.cpu.eax.value & 0xff; return true; }
  if (off === 1) return isIn ? ret(STATUS) : true;
  if (isIn) return ret(s.ctl | 0xe0);
  const v = this.cpu.eax.value & 0x3f, was = s.ctl; s.ctl = v;
  if ((was & 4) && !(v & 4)) this.lptFlush();   // INIT# low: the printer resets, its job is over
  if (!(was & 1) && (v & 1)) {   // the strobe: the printer takes the byte on the data lines and acknowledges it
    s.job.push(s.data);
    clearTimeout(s.timer); s.timer = setTimeout(() => this.lptFlush(), QUIET_MS);
    if ((v & 0x10) && LPT.irq && this.raiseIRQ) this.raiseIRQ(LPT.irq);
  }
  return true;
};
})();
