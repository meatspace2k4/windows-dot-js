// (a test: the address space DLLs take in this machine: the arena's mapped modules, those mapped above the heap (vmTop),
// memory's size, and which running processes there are, into the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p) return;
  const mods = (p.modules || []).filter(m => m.size).map(m => ({ name: m.name, base: m.base >>> 0, size: m.size, dyn: !!(m.meta && m.meta.dynamic) }));
  const hi = mods.filter(m => m.base >= 0x02000000), arena = mods.filter(m => m.base < 0x02000000);
  const sum = a => a.reduce((s, m) => s + m.size, 0);
  const procs = [...(p.threadsById || new Map()).values()].map(t => t.pc).filter((pc, i, a) => pc && a.indexOf(pc) === i && pc.exitCode == null).map(pc => pc.path);
  console.warn('[dllspace] ' + JSON.stringify({ mem: (p.mem.buffer.byteLength / 1048576) + 'MB', vmTop: p.vmTop && (p.vmTop >>> 0).toString(16), arenaMods: arena.length, arenaMB: +(sum(arena) / 1048576).toFixed(1), hiMods: hi.length, hiMB: +(sum(hi) / 1048576).toFixed(1),
    hi: hi.map(m => m.name + '@' + m.base.toString(16) + '+' + (m.size >> 10) + 'K'), procs }));
})();
