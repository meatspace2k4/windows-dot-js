// the running machine given ne16.js's waitBlocked without a restart: a thread stopped in a wait that would only wait
// again is passed by in the scheduler's round (marked blocked for the pass, as the scheduler already skips those),
// and WaitEvent sleeps a Win16 task until an event is posted to it (at most 50 ms of the machine's time)
(() => {
  const P = self.W95Win32 && self.W95Win32.Process.prototype, K = self.W95NE16 && self.W95NE16.K16; if (!P || !K || P.threads16.__waitskip) return;
  const we = K['KERNEL.#30'], wasWE = we[2];
  we[2] = function () {
    const t = this.thread16, top = t && !this.asTask && this.depth === t.depth;
    if (t && t.events > 0) t.evWait = 0;
    else if (t && top && !t.slept) t.evWait = this.now() + 50;
    else if (t) t.evWait = 0;
    return wasWE.call(this);
  };
  const blocked = function (t) {
    if (t.state !== 'waiting' || t.preempted || !t.ctx || t.blocked) return false;
    const now = this.now();
    if (t.evWait) return !(t.events > 0) && now < t.evWait;
    const w = t.waitOn; if (!w || !w.hs || !w.hs.length || t.task) return false;
    if (t.wake && now >= t.wake) return false;
    if (t.queue && this.selValid(t.queue)) { const q = this.selBase(t.queue); if (this.r16(q + 0x4c) & 0x8000 || this.r16(q + 0x4e) || (!this.r16(q + 0x4c) && this.r16(q + 0x48))) return false; }
    for (const h of w.hs) { const o = this.obj(h); if (!o || o.kind !== 'event' || o.set || P.queueWoken.call(this, h)) return false; }
    return true;
  };
  const was = P.threads16;
  P.threads16 = function (nested = false, only = null) {
    if (only || !this.threadsById) return was.call(this, nested, only);
    const marked = []; for (const t of this.threadsById.values()) if (blocked.call(this, t)) { t.blocked = true; marked.push(t); }
    try { return was.call(this, nested, only); } finally { for (const t of marked) t.blocked = false; }
  };
  P.threads16.__waitskip = true;
})();
