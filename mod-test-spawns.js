// (a test: who starts programs and who asks for named mutexes, events and windows (an instance check): each call of
// CreateProcessA, WinExec, ShellExecuteA/ExA, CreateMutexA, OpenMutexA, CreateEventA, FindWindowA with its caller's
// program, arguments and answer, the last 60, into self.W95Spawns and the console)
(() => {
  const W = self.W95Win32, API = W && W.API; if (!API || API.__spawns) return; API.__spawns = true;
  const L = self.W95Spawns = [];
  const str = (p, v) => { if (!(v >>> 16)) return (v >>> 0).toString(16); try { const s = p.readA(v, 200); return /^[\x20-\x7e]*$/.test(s) ? JSON.stringify(s) : (v >>> 0).toString(16); } catch (_) { return (v >>> 0).toString(16); } };
  for (const [dll, nm] of [['KERNEL32', 'CreateProcessA'], ['KERNEL32', 'WinExec'], ['SHELL32', 'ShellExecuteA'], ['SHELL32', 'ShellExecuteExA'], ['KERNEL32', 'CreateMutexA'], ['KERNEL32', 'OpenMutexA'], ['KERNEL32', 'CreateEventA'], ['USER32', 'FindWindowA']]) {
    const d = API[dll] && API[dll][nm]; if (!Array.isArray(d) || typeof d[1] !== 'function') continue; const f = d[1];
    d[1] = function (...a) {
      const r = f.apply(this, a), who = ((this.thread16 && this.thread16.pc && this.thread16.pc.path) || 'main').split('\\').pop();
      const line = `${who} ${nm}(${a.slice(0, 4).map(v => str(this, v)).join(', ')}) = ${typeof r === 'number' ? (r >>> 0).toString(16) : String(r)} le ${this.lastError}`;
      L.push(line); if (L.length > 60) L.shift(); if (/runonce|RunOnce/i.test(line)) console.warn('[spawns] ' + line);
      return r;
    };
  }
  console.warn('[spawns] installed');
})();
