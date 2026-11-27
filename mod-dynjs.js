// Run named translated modules as debuggable JavaScript (dynjs.js). Source appears in DevTools as dyn/NAME.js.
// Setting: module names joined by + or a comma; * means every module.
//   Address: #mod=dynjs:MSTASK+EXPLORER
//   By hand: sysApp.cmd('reload', ['mod-dynjs.js', 'MSTASK,EXPLORER'])
// The same from the page: win95.debug.run([...]).
// Modules already loaded are converted in place from their wasm; later ones convert as they load.
// cmd 'modOff' puts every module back on WebAssembly.
(() => {
  const J = self.W95DynJs, p = machine.proc;
  const names = String(self.W95ModArg == null ? '' : self.W95ModArg).split(/[+,]/).map(s => s.trim()).filter(Boolean);
  const made = J.debug(p, ['run', names]);
  console.log(`[dynjs] ${names.join(' ')}: ${made.length ? made.join(', ') + ' as JavaScript now' : 'none in place yet'}; the rest as they load`);
  (self.W95ModOff || (self.W95ModOff = {}))['mod-dynjs.js'] = () => { J.debug(p, ['run', []]); };
})();
