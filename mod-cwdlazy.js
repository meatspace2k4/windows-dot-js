// the running machine given worker.js's lazy current directory and ne16.js's cwdSwitch without a restart: the machine's
// file system wrapped so a thread switch only records the directory, told to the page before the next call there
(() => {
  const W = self.W95Win32, P = W && W.Process.prototype, m = typeof machine !== 'undefined' && machine, p = m && m.proc;
  if (!P || !p || !p.fs || p.__cwdLazy) return; p.__cwdLazy = true;   // (the worker's own proxy answers any name with a function: a mark of the process's says it is done)
  const base = p.fs; let pageCwd, want;
  const apply = () => { if (want !== undefined) { if (want !== pageCwd) { base.cwd = want; pageCwd = want; } want = undefined; } };
  p.fs = new Proxy({}, {
    get(_, k) {
      if (k === 'cwd') return want !== undefined ? want : pageCwd !== undefined ? pageCwd : (pageCwd = base.cwd);
      if (k === 'cwdLazy') return v => { want = v; };
      if (k !== 'vols') apply();
      if (k === 'chdir') return (...a) => { pageCwd = undefined; return base.chdir(...a); };
      return base[k];
    },
    set(_, k, v) { if (k === 'cwd') { want = undefined; base.cwd = v; pageCwd = v; } else base[k] = v; return true; },
  });
  P.cwdSwitch = function (t) {
    const to = t ? (t.task ? t : t.pc || null) : null, from = this.cwdHolder || null;
    if (to === from || !this.fs) return;
    if (from) from.cwd = this.fs.cwd;
    if (to && to.cwd === undefined && to.task && to.task.mod && to.task.mod.path) { const full = String(to.task.mod.path), i = full.lastIndexOf('\\'); to.cwd = i <= 2 ? full.slice(0, 3) : full.slice(0, i); }
    if (to && to.cwd && to.cwd !== this.fs.cwd) { if (this.fs.cwdLazy) this.fs.cwdLazy(to.cwd); else this.fs.chdir(to.cwd); }
    this.cwdHolder = to;
  };
})();
