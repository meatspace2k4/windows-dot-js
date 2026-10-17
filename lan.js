'use strict';
// The network hardware under the CD's NE2000.SYS: an NE2000-compatible ISA card (a National DP8390 controller, 32 KB of
// buffer memory at 4000h-7FFFh and its station-address PROM) at I/O 300h-31Fh and IRQ 5, as NETNOVEL.INF's *PNP80D6
// is set up (win95.js setupNetwork), on an Ethernet segment (LAN) shared by every card and by the other computers on it.
// Native code reaches the card with IN and OUT (ne16.js portIO); its interrupt goes to the VxD that virtualized IRQ 5
// (NDIS). Frames the segment delivers wait at the card until the processor next takes interrupts (between slices, or
// while ring-0 code waits), go into its receive ring then, and raise the interrupt when the card's mask lets them.
(function () {
const P = window.W95Win32.Process.prototype;
const NIC = { devnode: 'ROOT\\NET\\0000', io: 0x300, irq: 5 };
const cards0 = P.cards;
P.cards = function () { const c = cards0 ? cards0.call(this) : []; return this.host && this.host.net ? [...c, { devnode: NIC.devnode, io: [[NIC.io, 0x20]], irq: [NIC.irq], dma: [], nic: NIC }] : c; };

// ---------------------------------------------------------------- the segment
// stations: { mac (6 bytes), rx(frame) }; a frame goes to every other station, which keeps what its filter takes
const LAN = window.W95LAN || (window.W95LAN = { stations: new Set(), frames: 0 });
LAN.send = function (from, frame) {
  LAN.frames++;
  if (window.W95LANTRACE) window.W95LANTRACE(from, frame);
  for (const s of LAN.stations) if (s !== from) s.rx(frame);
};
LAN.attach = function (s) { LAN.stations.add(s); return () => LAN.stations.delete(s); };

// ---------------------------------------------------------------- DP8390
// command register CR: STP 01h, STA 02h, TXP 04h, remote DMA 08h read / 10h write / 20h abort, page select in bits 6-7.
// ISR: PRX 01h, PTX 02h, RXE 04h, TXE 08h, OVW 10h, CNT 20h, RDC 40h, RST 80h
const ISR = { PRX: 1, PTX: 2, OVW: 0x10, RDC: 0x40, RST: 0x80 };
const MEM_LO = 0x4000, MEM_HI = 0x8000;
const crc32 = b => { let c = 0xffffffff; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
const nic = p => {
  if (p.nic) return p.nic;
  const mac = Uint8Array.from([0x00, 0x00, 0xe8, 0x95, (Math.random() * 256) | 0, (Math.random() * 256) | 0]);
  const n = p.nic = {
    cr: 0x21, isr: ISR.RST, imr: 0, dcr: 0, rcr: 0, tcr: 0, pstart: 0x46, pstop: 0x80, bnry: 0x4c, curr: 0x4d, tpsr: 0x40, tbcr: 0,
    rsar: 0, rbcr: 0, tsr: 0, rsr: 0, par: mac.slice(), mar: new Uint8Array(8), mem: new Uint8Array(MEM_HI), mac, inbox: [],
  };
  // the station-address PROM as the card's 16-bit bus presents it: its 16 bytes (the address, then the signature
  // 57h 57h at 0Eh) each twice
  const prom = new Uint8Array(16); prom.set(mac); prom[14] = prom[15] = 0x57;
  for (let i = 0; i < 16; i++) n.mem[2 * i] = n.mem[2 * i + 1] = prom[i];
  n.station = { mac, rx: f => { n.inbox.push(f); } };
  n.detach = LAN.attach(n.station);
  return n;
};
/** the frames the segment has delivered to the card, taken into its receive ring; then its interrupt if it is due.
 *  true if the interrupt was raised */
P.lanPoll = function () {
  const n = this.nic; if (!n) return false;
  while (n.inbox.length && n.cr & 2 && !(n.cr & 1)) this.nicReceive(n, n.inbox.shift());
  return this.nicIrq(n);
};
P.nicIrq = function (n) {
  if (!(n.isr & n.imr & 0x7f)) return false;
  return !!(this.raiseIRQ && this.raiseIRQ(NIC.irq));
};
// receive: the destination filter (station, broadcast with AB, multicast with AM through the hash filter, or all with
// PRO), then the frame into the ring from CURR: a 4-byte header (status, next page, length) and the frame, wrapping
// from PSTOP to PSTART; a ring that would reach BNRY overflows (OVW) and the frame is lost
P.nicReceive = function (n, f) {
  const d = f.subarray(0, 6), bcast = d.every(x => x === 0xff), mcast = !bcast && d[0] & 1;
  const mine = d.every((x, i) => x === n.par[i]);
  const hash = mcast && (() => { const h = crc32(d) >>> 26; return n.mar[h >> 3] >> (h & 7) & 1; })();
  if (!(n.rcr & 0x10) && !mine && !(bcast && n.rcr & 4) && !(mcast && n.rcr & 8 && hash)) return;
  const len = Math.max(f.length, 60) + 4, pages = Math.ceil(len / 256), ring = n.pstop - n.pstart;
  let used = n.curr - n.bnry; if (used <= 0) used += ring;
  if (pages >= ring - used + 1 && n.bnry !== n.curr) { n.isr |= ISR.OVW; return; }
  const start = n.curr, next = ((n.curr - n.pstart + pages) % ring) + n.pstart;
  const frame = new Uint8Array(len); frame[0] = 0x01 | (mcast || bcast ? 0x20 : 0); frame[1] = next; frame[2] = len & 0xff; frame[3] = len >> 8; frame.set(f, 4);
  let at = start * 256;
  for (let i = 0; i < len; i++) { n.mem[at++] = frame[i]; if (at >= n.pstop * 256) at = n.pstart * 256; }
  n.curr = next; n.rsr = frame[0]; n.isr |= ISR.PRX;
};
P.nicTransmit = function (n) {
  const len = n.tbcr, a = n.tpsr * 256; if (!len || a + len > MEM_HI) { n.tsr = 0; n.isr |= 8; return; }
  const f = n.mem.slice(a, a + len);
  n.tsr = 1; n.isr |= ISR.PTX; n.cr &= ~4;
  if (n.tcr & 6) { n.inbox.push(f); return; }   // loopback modes
  LAN.send(n.station, f);
};
const memRead = (n, a) => (a < 32 || (a >= MEM_LO && a < MEM_HI) ? n.mem[a] : 0xff);
const memWrite = (n, a, v) => { if (a >= MEM_LO && a < MEM_HI) n.mem[a] = v; };
// remote DMA through the data port (10h-17h): a byte or a word (DCR WTS) at RSAR, counting RBCR down to RDC
const dataPort = (n, isIn, size, v) => {
  let out = 0;
  for (let k = 0; k < size; k++) {
    if (isIn) out |= memRead(n, n.rsar) << (8 * k); else memWrite(n, n.rsar, (v >> (8 * k)) & 0xff);
    n.rsar = (n.rsar + 1) & 0xffff;
    if (n.rsar === n.pstop * 256 && n.cr & 8) n.rsar = n.pstart * 256;
    if (n.rbcr) n.rbcr--;
    if (!n.rbcr) { n.isr |= ISR.RDC; break; }
  }
  return out;
};
P.nicIO = function (port, size, isIn) {
  if (port < NIC.io || port >= NIC.io + 0x20 || !(this.host && this.host.net)) return false;
  const n = nic(this), r = port - NIC.io, eax = this.cpu.eax.value, v = eax & (size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff);
  const ret = x => { const m = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff; this.cpu.eax.value = ((eax & ~m) | (x & m)) >>> 0; };
  if (r >= 0x10 && r < 0x18) { if (isIn) ret(dataPort(n, true, size)); else dataPort(n, false, size, v); return true; }
  if (r >= 0x18) {   // the reset port: reading it resets the card
    if (isIn) { n.cr = 0x21; n.isr |= ISR.RST; n.inbox.length = 0; ret(0); } return true;
  }
  const page = n.cr >> 6;
  if (isIn) {
    if (r === 0) { ret(n.cr); return true; }
    if (page === 0) ret([0, 0, 0, n.bnry, n.tsr, 0, 0, n.isr, n.rsar & 0xff, n.rsar >> 8, 0x50, 0x43, n.rsr, 0, 0, 0][r]);
    else if (page === 1) ret(r <= 6 ? n.par[r - 1] : r === 7 ? n.curr : n.mar[r - 8]);
    else ret([0, n.pstart, n.pstop, 0, n.tpsr, 0, 0, 0, 0, 0, 0, 0, n.rcr, n.tcr, n.dcr, n.imr][r]);
    return true;
  }
  const b = v & 0xff;
  if (r === 0) {
    n.cr = (b & ~4) | (n.cr & 4 && !(b & 1) ? 4 : 0);
    if (b & 1) n.isr |= ISR.RST;                       // stopped
    else n.isr &= ~ISR.RST;
    if ((b & 0x38) === 0x20 || (b & 0x38) === 0) { /* abort or no remote DMA */ }
    if ((b & 0x38) === 0x18) { n.rsar = n.bnry * 256; n.rbcr = 0xffff; }   // send packet: the next frame in the ring
    if (b & 4 && !(b & 1)) { n.cr |= 4; this.nicTransmit(n); }
    return true;
  }
  if (page === 0) {
    switch (r) {
      case 1: n.pstart = b; break; case 2: n.pstop = b; break; case 3: n.bnry = b; break; case 4: n.tpsr = b; break;
      case 5: n.tbcr = (n.tbcr & 0xff00) | b; break; case 6: n.tbcr = (n.tbcr & 0xff) | (b << 8); break;
      case 7: n.isr &= ~b; break;
      case 8: n.rsar = (n.rsar & 0xff00) | b; break; case 9: n.rsar = (n.rsar & 0xff) | (b << 8); break;
      case 0xa: n.rbcr = (n.rbcr & 0xff00) | b; break; case 0xb: n.rbcr = (n.rbcr & 0xff) | (b << 8); break;
      case 0xc: n.rcr = b; break; case 0xd: n.tcr = b; break; case 0xe: n.dcr = b; break; case 0xf: n.imr = b; break;
    }
  } else if (page === 1) {
    if (r <= 6) n.par[r - 1] = b; else if (r === 7) n.curr = b; else n.mar[r - 8] = b;
  }
  return true;
};
})();
