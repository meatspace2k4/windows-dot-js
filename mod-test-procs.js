// (a test: the machine's processes with their command lines, into C:\PROCS.TXT)
(() => {
  const p = machine.proc, L = [];
  for (const [pid, pc] of p.procs || []) L.push(`pid ${pid.toString(16)} ${pc.path || ''} [${pc.cmdLine || pc.cmd || pc.args || ''}] keys ${Object.keys(pc).filter(k => /cmd|arg|line/i.test(k)).join(',')}`);
  p.fs.writeFile('C:\\PROCS.TXT', new TextEncoder().encode(L.join('\r\n')));
})();
