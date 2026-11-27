// (a test: each #UD raised in 32-bit code: the thread's exception chain (frames and handlers) from FS:[0], the TIB's
// stack bounds and ESP, and each handler's answer at SEH_CONT (its EAX), into the log ('[sehud]'), the first 40)
(() => {
  const W = self.W95Win32, P = W && W.Process.prototype; if (!P || P.__sehud) return; P.__sehud = true;
  let n = 0; const was = P.raise;
  P.raise = function (k, eip, cr2) {
    if (k === 6 && n < 40 && !(this.cpu.cs.value & 0xffff)) {
      n++; const tib = this.cpu.fs.value, out = []; let f = this.r32(tib);
      for (let i = 0; i < 12 && f && f !== 0xffffffff; i++, f = this.r32(f)) out.push(`${(f >>> 0).toString(16)}:${this.whereOf(this.r32(f + 4))}`);
      W.log('warn', 'sehud', `#UD at ${this.whereOf(eip)} thread ${this.thread16 ? this.thread16.id : 'main'} tib ${(tib >>> 0).toString(16)} top ${(this.r32(tib + 4) >>> 0).toString(16)} limit ${(this.r32(tib + 8) >>> 0).toString(16)} esp ${(this.reg('esp') >>> 0).toString(16)} live ${this.sehLive ? this.sehLive.size : 0}; chain ${out.join(' > ')}`);
    }
    return was.call(this, k, eip, cr2);
  };
  const st = W.sehStep;
  if (st && W.API) { const hooks = []; }
})();
