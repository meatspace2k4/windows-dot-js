// (a test: the machine's processes and Windows 3.x tasks, with their command lines, written to C:\PROCS.TXT)
(() => {
  const p = machine.proc, L = [];
  for (const [pid, pc] of p.procs || []) L.push(`pid ${pid.toString(16)} ${pc.path || ''} [${pc.cmdLine || pc.cmd || ''}]`);
  for (const t of p.threads16 || []) { const m = t.task && t.task.hInst && p.neByHandle(t.task.hInst); L.push(`thread ${t.id} ${(m && m.name) || ''} ${(t.pc && t.pc.path) || ''} slept ${!!t.slept}`); }
  p.fs.writeFile('C:\\PROCS.TXT', new TextEncoder().encode(L.join('\r\n')));
})();
