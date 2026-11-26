// (a test: the machine's registry keys matching self.W95RegQ (else BROWSEUI's TrayBandSiteService CLSID and BROWSEUI's
// name), with their values, and the count of CLSIDs, into C:\REG.TXT)
(() => {
  const W = self.W95Win32, d = W.regDump(), q = self.W95RegQ || /ECD4FC4D|browseui/i, L = [];
  L.push(`keys ${d.length}, CLSIDs ${d.filter(([k]) => /^hkcr\\clsid\\\{[^\\]+\}$/i.test(k) || /^hklm\\software\\classes\\clsid\\\{[^\\]+\}$/i.test(k)).length}`);
  for (const [k, v] of d) if (q.test(k) || q.test(JSON.stringify(v))) { L.push(`${k} ${JSON.stringify(v).slice(0, 200)}`); if (L.length > 60) break; }
  machine.proc.fs.writeFile('C:\\REG.TXT', new TextEncoder().encode(L.join('\r\n')));
})();
