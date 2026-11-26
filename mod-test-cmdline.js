// (a test: each process's command line as GetCommandLine answers it, into the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p) return;
  for (const pc of (p.procs || new Map()).values()) { let s = ''; try { s = pc.cmdPtr ? p.readA(pc.cmdPtr) : String(pc.cmdline || pc.cmd || ''); } catch (_) { s = '?'; } console.warn(`[cmdline] ${pc.pid} ${pc.path}: ${JSON.stringify(s)} keys ${Object.keys(pc).filter(k => /cmd/i.test(k)).join(',')}`); }
})();
