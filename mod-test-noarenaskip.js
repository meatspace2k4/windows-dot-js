// (a test: ne16.js imgUse's arena skip off)
(() => { const P = self.W95Win32.Process.prototype; P.imgUse = function (pc) { this.dllUse(pc); this.arenaUse(pc); }; })();
