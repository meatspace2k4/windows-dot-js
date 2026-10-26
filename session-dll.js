// SESSION.DLL: Export Session and Import Session, from the Start menu (Programs > Accessories > System Tools), run as
// RUNDLL32 runs a DLL's entry: RUNDLL32.EXE SESSION.DLL,Export. Implemented here as the system's other stand-ins are
// (shell32.js); each asks the page, which keeps the machine's store and chooses the file (win95.js sessionCommand).
(() => {
  if (typeof importScripts !== 'function' || !self.W95Win32) return;   // (the system's machine's worker only)
  const { def } = self.W95Win32;
  // (hwnd, hinst, lpszCmdLine, nCmdShow), as RUNDLL32 calls an entry
  def('SESSION', 'Export', 4, () => { self.postMessage({ t: 'session', op: 'export' }); return 0; });
  def('SESSION', 'Import', 4, () => { self.postMessage({ t: 'session', op: 'import' }); return 0; });
})();
