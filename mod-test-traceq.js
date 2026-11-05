// (a test: mod-test-calltrace's filter (self.W95TraceQ) set to the threads of the program self.W95TraceProg names (WINHLP32
// when unset), the trace so far cleared)
(() => { self.W95TraceQ = self.W95TraceProg || /winhlp32/i; self.W95TraceOnly = self.W95TraceQ; self.W95CallTrace = []; })();
