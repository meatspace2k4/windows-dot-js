// (a test: a thread's record (self.W95ThreadId, else 149): its program, stack size and base, whether it is a process's
// main thread, into C:\THREAD.TXT)
(() => {
  const p = machine.proc, id = self.W95ThreadId || 149, t = p.threadsById.get(id), hex = v => (v >>> 0).toString(16);
  const L = [t ? `thread ${id} ${(t.pc && t.pc.path) || ''} stack ${hex(t.stack)} base ${hex(t.stackBase)} flat ${!!t.flat} main ${!!(t.pc && t.pc.main === t)} state ${t.state} start ${p.whereOf ? p.whereOf(t.start) : hex(t.start)}` : `no thread ${id}`];
  self.W95Thread = L; p.fs.writeFile('C:\\THREAD.TXT', new TextEncoder().encode(L.join('\r\n')));
})();
