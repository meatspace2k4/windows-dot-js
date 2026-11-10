// Run named translated modules as debuggable JavaScript (dynjs.js). Source appears in DevTools as dyn/NAME.js.
// Setting: module names joined by + or a comma; * means every module.
//   Address: #mod=dynjs:MSTASK+EXPLORER
//   By hand: sysApp.cmd('reload', ['mod-dynjs.js', 'MSTASK,EXPLORER'])
// An entry starting with @ sets a breakpoint at that guest address (hex): 'MSTASK,@1001def' pauses DevTools there.
// Modules already loaded are converted in place from their wasm; later ones convert as they load.
// cmd 'modOff' puts every module back on WebAssembly.
(() => {
  const J = self.W95DynJs, p = machine.proc;
  const label = m => (m.name === 'EXE' ? m.meta.path || m.meta.name || 'EXE' : m.name);
  const remake = () => { const n = []; for (const m of p.modules || []) if (m && m.run && m.module && m.netSeed && m.netSeed.wasm && !m.netText && !m.hidden && (J.wants(label(m)) || m.dynJs)) { m.dynJs = J.wants(label(m)); p.neSet(m, m.module, m.netSeed); n.push(label(m)); } return n; };
  J.names.clear();
  // An entry starting with @ is a breakpoint address in hex (MSTASK,@1001def); the others are module names.
  J.clearBreak();
  for (const n of String(self.W95ModArg == null ? '' : self.W95ModArg).split(/[+,]/).map(s => s.trim()).filter(Boolean)) {
    if (n[0] === '@') J.breakAt(parseInt(n.slice(1), 16)); else J.names.add(n.toUpperCase().replace(/\.\w+$/, ''));
  }
  const made = remake();
  console.log(`[dynjs] ${[...J.names].join(' ')}: ${made.length ? made.join(', ') + ' as JavaScript now' : 'none in place yet'}; the rest as they load`);
  (self.W95ModOff || (self.W95ModOff = {}))['mod-dynjs.js'] = () => { J.names.clear(); remake(); };
})();
