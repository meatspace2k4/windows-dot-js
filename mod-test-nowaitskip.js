// (a test: ne16.js waitBlocked off)
(() => { const P = self.W95Win32.Process.prototype; P.waitBlocked = () => false; })();
