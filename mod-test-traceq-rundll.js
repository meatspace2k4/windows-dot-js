// (a test: mod-test-calltrace's filter to RUNDLL32's and WINHLP32's threads, the trace so far cleared)
(() => { self.W95TraceProg = /rundll32|winhlp32/i; self.W95TraceQ = self.W95TraceProg; self.W95TraceOnly = self.W95TraceQ; self.W95CallTrace = []; })();
