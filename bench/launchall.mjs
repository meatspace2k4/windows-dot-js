#!/usr/bin/env node
// Starts every Windows program on C: one at a time and lists what went wrong: a program whose window never came, one
// that ended with a reason, the machine's fault log (a program's fault, a jump to nowhere), console errors, an error
// box, and the system's machine stopping. Each program's windows are closed before the next starts. A change that
// installs or runs programs is checked with it before it is committed.
//
//   node bench/launchall.mjs [endpoint] [--only REGEX] [--wait ms]
//
// SWEEP is the same check as page code: a page with the scripting API runs it as it is (`await (SWEEP)(opts)`), the
// dev page through its console too (`(await import('/bench/launchall.mjs')).SWEEP`).

export const SWEEP = `async (opts = {}) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = opts.wait || 8000, only = opts.only ? new RegExp(opts.only, 'i') : null;
  // (the system's own programs, which run already or set the system up, are not started again)
  const SYSTEM = /^(EXPLORER|MSGSRV32|RUNONCE|GRPCONV|RUNDLL32|SYSTRAY|SESSTRAY|MPREXE|SPOOL32|MMTASK|PBRUSH)\\.(EXE|TSK)$/i;
  const fs = win95.fs, files = [];
  const walk = (dir, deep) => { let kids = []; try { kids = fs.readdir(dir); } catch (_) { return; }
    for (const k of kids) { if (k.isDir) { if (deep) walk(k.path, deep); } else if (/\\.EXE$/i.test(k.name) && !SYSTEM.test(k.name)) files.push(k.path); } };
  walk('C:\\\\WINDOWS', false); walk('C:\\\\Program Files', true);
  const errs = [], ce = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ').slice(0, 300)); ce.apply(console, a); };
  const exits = []; const off = win95.on('program.exit', e => exits.push(e));
  const ready = () => win95.sysApp && win95.sysApp.alive && win95.state.screen === 'desktop' && win95.windows().some(w => w.title === 'Program Manager');
  const out = [];
  try {
    for (const f of files) {
      if (only && !only.test(f)) continue;
      for (let i = 0; i < 200 && !ready(); i++) await sleep(100);
      const before = new Set(win95.windows()), e0 = errs.length, x0 = exits.length;
      await win95.sysApp.cmd('faults');   // (the log so far: not this program's)
      win95.run('"' + f + '"');
      let mine = [];
      for (let t = 0; t < wait; t += 200) { await sleep(200); mine = win95.windows().filter(w => !before.has(w) && w.title); if (mine.length || exits.length > x0) break; }
      await sleep(1500); mine = win95.windows().filter(w => !before.has(w) && w.title);
      const alive = !!(win95.sysApp && win95.sysApp.alive);
      const faults = (alive && await win95.sysApp.cmd('faults')) || [];   // (none while the machine is busy answering: null)
      const boxes = win95.elements().filter(e => e.role === 'text' && /illegal operation|cannot find|not a valid|error/i.test(e.name || '') && mine.some(w => w.title === e.window)).map(e => e.window + ': ' + e.name.split('\\n')[0]);
      const r = { file: f, windows: mine.map(w => w.title), exits: exits.slice(x0).map(e => [e.path, e.code, e.why || '']), faults: faults.map(x => x.why + ' at ' + x.at), errors: errs.slice(e0), boxes, systemDown: !alive };
      r.ok = !r.systemDown && !r.faults.length && !r.errors.length && !r.boxes.length && (r.windows.length > 0 || r.exits.some(e => e[1] === 0));
      out.push(r);
      // its windows closed, top first; a question on closing answered No, else Escape
      for (let k = 0; k < 4; k++) {
        const left = win95.windows().filter(w => !before.has(w) && w.title).reverse(); if (!left.length) break;
        for (const w of left) { if (w.modal) win95.key('esc'); else win95.close(w.title); await sleep(600); }
        for (const w of win95.windows().filter(w => !before.has(w) && w.modal)) { win95.key('alt+n'); await sleep(400); }
      }
      if (!alive) { await win95.startSystem(); for (let i = 0; i < 300 && !ready(); i++) await sleep(100); }
    }
  } finally { console.error = ce; off(); }
  return out;
}`;

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const only = opt('--only'), wait = +(opt('--wait') || 0) || undefined, [endpoint = 'http://127.0.0.1:9334'] = args;
  const { connect } = await import('./runner.mjs');
  const c = await connect(endpoint);
  const res = await c.evaluate(`(${SWEEP})(${JSON.stringify({ only, wait })})`, 3600000);
  for (const r of res) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.file}${r.ok ? '' : '\n     ' + JSON.stringify({ windows: r.windows, exits: r.exits, faults: r.faults, errors: r.errors, boxes: r.boxes, systemDown: r.systemDown })}`);
  c.close();
  process.exit(res.every(r => r.ok) ? 0 : 1);
}
