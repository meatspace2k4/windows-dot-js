// Test: Windows' own Change Icon dialog (SHELL32's PickIconDlg, ordinal 62) opened on a file's icons, on a thread of
// the system's machine as a program's dialog runs; what was chosen (the file and the icon's index) in the log as it is
// closed (#mod=test-pickicon:C:\WINDOWS\SYSTEM\SHELL32.DLL, or by hand: sysApp.cmd('reload', ['mod-test-pickicon.js',
// path]))
(async () => {
  const p = machine.proc, W = self.W95Win32, file = String(self.W95ModArg || 'C:\\WINDOWS\\SYSTEM\\SHELL32.DLL');
  if (!p.byName.get('SHELL32')) await machine.netCall('LoadLibraryA', ['SHELL32.DLL'], 'KERNEL32');
  const sh = p.byName.get('SHELL32'), key = sh && [...sh.exports.keys()].find(k => /^#?62$/.test(String(k)) || /^PickIconDlg/i.test(String(k)));
  if (key === undefined) { W.log('warn', 'mod', 'pickicon: no PickIconDlg in SHELL32'); return; }
  const path = p.alloc(260), idx = p.alloc(4); p.u8.fill(0, path, path + 260); p.writeA(path, file); p.w32(idx, 0);
  W.log('info', 'mod', `pickicon: Change Icon on ${file}`);
  const r = await machine.netBatch([{ dll: 'SHELL32', name: key, args: [0, path, 260, idx] }]);
  W.log('info', 'mod', `pickicon: ${r && r[0] ? 'chosen' : 'cancelled'} ${p.readA(path)},${p.r32(idx)}`);
  p.free(path); p.free(idx);
})();
