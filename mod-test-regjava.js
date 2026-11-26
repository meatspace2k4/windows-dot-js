// (a test: the machine's registry values that start the Java package install (RunOnce's), into C:\REGJAVA.TXT)
(() => {
  const d = self.W95Win32.regDump(), L = [];
  for (const [k, v] of d) { const s = JSON.stringify(v); if (/java|jpk|\.cab/i.test(s) && /run/i.test(k)) L.push(`${k} ${s.slice(0, 400)}`); }
  machine.proc.fs.writeFile('C:\\REGJAVA.TXT', new TextEncoder().encode(L.join('\r\n') || 'none'));
})();
