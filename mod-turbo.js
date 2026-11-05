// Turbo: the machine run x times ahead of the wall (braid.speed x), x its setting (the page's address, #mod=turbo:8; loaded
// by hand, sysApp.cmd('reload', ['mod-turbo.js', 8])). Ended (the parameter taken out, cmd 'modOff'), the machine
// runs at a person's pace again
(() => {
  const x = Math.max(1, Number(self.W95ModArg) || 1);
  machine.cmd('speed', [x]);
  (self.W95ModOff || (self.W95ModOff = {}))['mod-turbo.js'] = () => machine.cmd('speed', [1]);
  self.W95Win32.log('info', 'mod', `turbo: ${x} times the wall's pace`);
})();
