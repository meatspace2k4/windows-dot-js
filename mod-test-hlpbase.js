// (a test: WINHLP32.EXE's process here: its image base, preferred base and size, into the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p) return;
  const out = [];
  for (const t of (p.threadsById || new Map()).values()) { const pc = t.pc; if (!pc || !/winhlp32/i.test(pc.path || '') || out.some(o => o.pid === pc.pid)) continue; const e = pc.exe || {}; out.push({ pid: pc.pid, base: (e.base >>> 0).toString(16), pref: e.pref && (e.pref >>> 0).toString(16), size: e.size && e.size.toString(16), thread: t.id, state: t.state }); }
  console.warn('[hlpbase] ' + JSON.stringify(out));
})();
