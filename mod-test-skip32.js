// (a test: ne16.js waitBlocked for Win32 object waits only, WaitEvent's tasks always run)
(() => {
  const P = self.W95Win32.Process.prototype, orig = P.__waitBlocked0 || (P.__waitBlocked0 = P.waitBlocked.__orig || null);
  P.waitBlocked = function (t) {
    if (t.state !== 'waiting' || t.preempted || !t.ctx || !t.waitYield || t.evWait || t.task) return false;
    const now = this.now(), w = t.waitOn; if (!w || !w.hs || !w.hs.length) return false;
    if (t.wake && now >= t.wake) return false;
    if (t.queue && this.selValid(t.queue)) { const q = this.selBase(t.queue); if (this.r16(q + 0x4c) & 0x8000 || this.r16(q + 0x4e) || (!this.r16(q + 0x4c) && this.r16(q + 0x48))) return false; }
    for (const h of w.hs) { const o = this.obj(h); if (!o || o.kind !== 'event' || o.set || P.queueWoken.call(this, h)) return false; }
    return true;
  };
})();
