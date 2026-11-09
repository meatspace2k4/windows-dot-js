// (a test: the calls mod-test-calltrace has traced so far written to C:\CALLTRACE.TXT now, and the count kept as the trace's)
(() => { const L = self.W95CallTrace || []; const b = machine.proc.fs; b.writeFile('C:\\CALLTRACE.TXT', new TextEncoder().encode(L.join('\r\n'))); self.W95TraceDumped = L.length; })();
