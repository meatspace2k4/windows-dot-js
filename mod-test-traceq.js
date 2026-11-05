// (a test: mod-test-calltrace's filter set to RUNDLL32's threads (self.W95TraceQ), the trace so far cleared)
(() => { self.W95TraceQ = /rundll32/i; self.W95TraceOnly = self.W95TraceQ; self.W95CallTrace = []; })();
