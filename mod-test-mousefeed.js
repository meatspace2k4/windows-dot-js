// (a test: why the machine's mouse is not fed (worker.js feedMouse): its depth, ring 0, focusing, the queue, into C:\MOUSE.TXT)
(() => {
  const m = machine, p = m.proc;
  const L = [`depth ${p.depth} r0 ${!!m.ring0()} r0Depth ${p.r0Depth} focusing ${!!m.focusing} mouseq ${m.mouseq.length} stroke ${!!m.stroke} rs ${!!m.rs} strokes ${(m.strokes || []).length} btn ${m.btn} thread ${p.thread16 ? p.thread16.id + ' ' + ((p.thread16.pc && p.thread16.pc.path) || '') : '-'} winHeld ${p.win16Held ? p.win16Held.who && p.win16Held.who.id : '-'}`];
  p.fs.writeFile('C:\\MOUSE.TXT', new TextEncoder().encode(L.join('\r\n')));
})();
