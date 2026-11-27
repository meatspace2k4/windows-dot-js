// (a test: each process's current directory, and the one in place, into the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p) return;
  console.warn(`[cwd] in place ${p.fs && p.fs.cwd}; holder ${p.cwdHolder ? (p.cwdHolder.path || (p.cwdHolder.task && p.cwdHolder.task.mod && p.cwdHolder.task.mod.path)) : '-'}`);
  for (const pc of (p.procs || new Map()).values()) console.warn(`[cwd] ${pc.path}: ${pc.cwd} (parent ${pc.parent ? pc.parent.path : '-'})`);
})();
