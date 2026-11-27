// (a test: which thread calls the yielding stand-ins (KERNEL #30 WaitEvent, #117 OldYield, #625, #72) and the INT 20h
// services, and from where (its program, CS:IP of the return), since this mod first loaded; loaded again it reports)
(() => {
  const m = typeof machine !== 'undefined' && machine, p = m && m.proc; if (!p) return;
  const S = self.__who || (self.__who = { t0: performance.now(), by: {} });
  const who = pr => { const t = pr.thread16; const path = (t && t.pc && t.pc.path) || (t ? 'thread ' + t.id : 'main'); let ret = ''; try { const sp = pr.cpu.esp.value & 0xffff, ss = pr.cpu.ss.value; const b = pr.selBase ? pr.selBase(ss) : 0; ret = pr.r16(b + sp + 2).toString(16) + ':' + pr.r16(b + sp).toString(16); } catch (_) { /* no frame */ } return path.split('\\').pop() + ' ' + ret; };
  if (!S.wrapped) {
    const N = self.W95NE16;
    for (const k of ['KERNEL.#30', 'KERNEL.#117', 'KERNEL.#625', 'KERNEL.#72']) { const d = N.K16[k]; if (!d) continue; const f = d[2]; d[2] = function () { const w = k + ' ' + who(this); S.by[w] = (S.by[w] || 0) + 1; return f.apply(this, arguments); }; }
    const i20 = N.INTS[0x20]; if (i20) N.INTS[0x20] = function () { const w = 'int20 ' + who(this); S.by[w] = (S.by[w] || 0) + 1; return i20.apply(this, arguments); };
    S.wrapped = true;
  }
  console.warn('[who] ' + JSON.stringify({ wallMs: Math.round(performance.now() - S.t0), top: Object.entries(S.by).sort((a, b) => b[1] - a[1]).slice(0, 16) }));
})();
