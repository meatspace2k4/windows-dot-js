// The benchmark: each step runs in the shell's page through the DevTools protocol and returns its metrics.
// Metric names carry their unit and direction: *_ms and *_pct lower is better, *_per_s higher is better.
// A step's function is sent as source, so it may use only the prelude below and the page's globals.

export const PRELUDE = `
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stat = a => {
  const s = [...a].sort((x, y) => x - y), r = v => +v.toFixed(3);
  return { n: s.length, mean_ms: r(s.reduce((t, x) => t + x, 0) / s.length), p50_ms: r(s[s.length >> 1]),
    p95_ms: r(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), max_ms: r(s[s.length - 1]) };
};
// the time an action takes to run and draw, and until the frame showing it is on screen
const measure = async (n, act, undo) => {
  const sync = [], shown = [];
  for (let i = 0; i < n; i++) {
    await frame();
    const t = performance.now(); await act(i); win95.render(); sync.push(performance.now() - t);
    await frame(); shown.push(performance.now() - t);
    if (undo) { await undo(i); await frame(); }
  }
  return { sync: stat(sync), to_frame: stat(shown) };
};
const reset = async () => {
  win95.stopSaver();
  for (let k = 0; k < 20 && (win95.menus().length || win95.windows().length); k++) {
    if (win95.menus().length) { win95.key('esc'); continue; }
    const w = win95.windows().at(-1);
    if (w.modal && /^Notepad$|Save/.test(w.title)) win95.key('alt+n'); else win95.close(w.title);
  }
  await frame();
};
const BENCH = 'C:\\\\BENCH';
// the share of the main thread other work took over ms: a chain of message-channel tasks, each gap past 0.25 ms counted
const load = ms => new Promise(done => {
  const ch = new MessageChannel(), t0 = performance.now(); let last = t0, busy = 0, n = 0;
  ch.port1.onmessage = () => {
    const now = performance.now(), gap = now - last; if (gap > 0.25) busy += gap; last = now; n++;
    if (now - t0 < ms) ch.port2.postMessage(0); else { ch.port1.close(); done({ busy_pct: +(100 * busy / (now - t0)).toFixed(2), tasks_per_s: +(n / ((now - t0) / 1000)).toFixed(0) }); }
  };
  ch.port2.postMessage(0);
});
// the guest time a native program used over ms, as a share of it
const guestCpu = async (app, ms) => { const a = app.proc.stats.guestMs, t = performance.now(); await sleep(ms); return +(100 * (app.proc.stats.guestMs - a) / (performance.now() - t)).toFixed(2); };
`;

export const STEPS = [
  {
    name: 'idle.load',
    about: 'the empty desktop for 5 s: the main thread\'s busy share and how many tasks it ran',
    run: async () => { await reset(); return await load(5000); },
  },
  {
    name: 'network',
    about: 'the network\'s process (MPREXE with the network VxDs under it): start-up to the card started, then 5 s idle: its guest CPU and the main thread\'s busy share',
    run: async () => {
      if (!win95.startNetwork) return { skipped: 'no network in this build' };
      await reset();
      const t = performance.now(), a = await win95.startNetwork(), start_ms = +(performance.now() - t).toFixed(1);
      if (!a || !a.alive) throw new Error('the network process did not start: ' + (a && a.proc && a.proc.trapped));
      const card = a.proc.devnodes().find(d => d.id === 'ROOT\\NET\\0000');
      if (!card || !card.started) throw new Error('the network card did not start');
      await sleep(1000);
      const [cpu, idle] = await Promise.all([guestCpu(a, 5000), load(5000)]);
      return { start_ms, guest_cpu_pct: cpu, idle_busy_pct: idle.busy_pct, frames_sent: window.W95LAN ? window.W95LAN.frames : 0 };
    },
  },
  {
    name: 'midi',
    about: 'CANYON.MID opened in Media Player through MCISEQ: start-up until the synthesizer is written, then its guest CPU for 4 s',
    run: async () => {
      await reset();
      const before = new Set(win95.nativeApps), t = performance.now();
      win95.shellOpen('C:\\WINDOWS\\MEDIA\\canyon.mid');
      let app = null;
      while (performance.now() - t < 20000) { app = win95.nativeApps.find(x => !before.has(x) && /MPLAYER/i.test(x.path)); if (app && app.proc && app.proc.opl3 && app.proc.opl3.regs.some(v => v)) break; await sleep(20); }
      if (!app || !app.alive) throw new Error('Media Player did not start: ' + (app && app.proc && app.proc.trapped));
      const start_ms = +(performance.now() - t).toFixed(1), cpu = await guestCpu(app, 4000);
      for (const w of app.wins.values()) if (w.title) app.close(w);
      await sleep(500); await reset();
      return { start_ms, guest_cpu_pct: cpu };
    },
  },
  {
    name: 'render.idle',
    about: 'one full redraw of the empty desktop (JS time to issue the canvas drawing)',
    run: async () => {
      await reset();
      const t = []; for (let i = 0; i < 300; i++) { const s = performance.now(); win95.render(); t.push(performance.now() - s); }
      return { render: stat(t) };
    },
  },
  {
    name: 'input.desktop-click',
    about: 'a click on empty desktop, through the pointer path',
    run: async () => {
      await reset();
      const s = win95.screen();
      return await measure(40, () => win95.click(s.width - 40, s.taskbar - 40));
    },
  },
  {
    name: 'input.pointer-move',
    about: 'a pointer move over the desktop (cursor redraw)',
    run: async () => {
      await reset();
      const s = win95.screen();
      return await measure(60, i => win95.move(100 + (i % 30) * 10, 100 + (i % 7) * 20));
    },
  },
  {
    name: 'startmenu',
    about: 'Start menu open, Programs submenu, close',
    run: async () => {
      await reset();
      const s = win95.screen();
      const open = await measure(20, () => win95.click(20, s.taskbar + 15), () => win95.key('esc'));
      win95.click(20, s.taskbar + 15); await frame();
      const sub = await measure(10, () => win95.key('down', 'right'), () => win95.key('left', 'up'));
      win95.key('esc'); await frame();
      return { open, programs: sub };
    },
  },
  {
    name: 'folders',
    about: 'folder windows: My Computer, C:\\, C:\\WINDOWS\\SYSTEM, D:\\WIN95 (CD); redraw with all four open',
    run: async () => {
      await reset();
      const out = {};
      for (const [k, p] of [['c_root', 'C:\\'], ['windows_system', 'C:\\WINDOWS\\SYSTEM'], ['cd_win95', 'D:\\WIN95']]) {
        out[k] = await measure(5, () => win95.open(p), () => win95.close(win95.windows().at(-1).title));
      }
      out.my_computer = await measure(5, () => win95.dblclick(37, 25), () => win95.close('My Computer'));
      win95.dblclick(37, 25); for (const p of ['C:\\', 'C:\\WINDOWS\\SYSTEM', 'D:\\WIN95']) win95.open(p);
      await frame();
      const t = []; for (let i = 0; i < 100; i++) { const s = performance.now(); win95.render(); t.push(performance.now() - s); }
      out.render_four_open = stat(t);
      await reset();
      return out;
    },
  },
  {
    name: 'window.drag',
    about: 'dragging a folder window by its title bar, per pointer move',
    run: async () => {
      await reset();
      win95.open('C:\\'); await frame();
      const w = win95.window('C:\\') || win95.windows().at(-1);
      let x = w.x + 60, y = w.y + 10;
      win95.down(x, y); await frame();
      const r = await measure(80, i => { x += i % 2 ? 3 : -2; y += 1; win95.move(x, y); });
      win95.up(x, y); await reset();
      return r;
    },
  },
  {
    name: 'notepad',
    about: 'open a 60,000-byte text file in Notepad (its limit is 65,535), type 1000 characters, save',
    run: async () => {
      await reset();
      if (!win95.fs.exists(BENCH)) win95.fs.mkdir(BENCH);
      const line = 'The quick brown fox jumps over the lazy dog. 0123456789\r\n';
      win95.fs.writeFile(BENCH + '\\big.txt', line.repeat(Math.ceil(60000 / line.length)).slice(0, 60000));
      const open = await measure(5, () => win95.run('notepad ' + BENCH + '\\big.txt'), () => win95.close(/Notepad$/));
      win95.run('notepad ' + BENCH + '\\big.txt'); await frame();
      // anything else on screen (a refusal, an error) would make the timings meaningless
      if (!win95.window('big - Notepad') || win95.windows().length !== 1) throw new Error('Notepad did not open the file: ' + win95.windows().map(w => w.title).join(', '));
      const t = performance.now(); win95.type('x'.repeat(1000)); win95.render(); const type_ms = performance.now() - t;
      await frame();
      const s = performance.now(); win95.key('alt+f', 's'); win95.render(); const save_ms = performance.now() - s;
      const saved = win95.fs.stat(BENCH + '\\big.txt').size;
      if (saved !== 61000) throw new Error(`saved ${saved} bytes, expected 61000`);
      await reset();
      win95.fs.unlink(BENCH + '\\big.txt'); win95.fs.rmdir(BENCH);
      // opening the file put it on Start > Documents; take it off again
      for (const i of win95.fs.readdir('C:\\WINDOWS\\Recent')) if (/^Target=C:\\BENCH\\/im.test(win95.fs.readText(i.path))) win95.fs.unlink(i.path);
      return { open, type_1000_ms: +type_ms.toFixed(3), per_key_ms: +(type_ms / 1000).toFixed(4), save_ms: +save_ms.toFixed(3), saved_bytes: saved };
    },
  },
  {
    name: 'fs',
    about: 'file system with write-through: 500 files of 1 KB created, read, renamed, deleted',
    run: async () => {
      await reset();
      const fs = win95.fs, data = new Uint8Array(1024).fill(65), n = 500;
      if (!fs.exists(BENCH)) fs.mkdir(BENCH);
      const rate = (t, k = n) => +(k / (t / 1000)).toFixed(1);
      let t = performance.now(); for (let i = 0; i < n; i++) fs.writeFile(`${BENCH}\\File number ${i}.dat`, data); const create = performance.now() - t;
      t = performance.now(); for (let i = 0; i < n; i++) fs.readFile(`${BENCH}\\File number ${i}.dat`); const read = performance.now() - t;
      t = performance.now(); fs.readdir(BENCH); const list_ms = performance.now() - t;
      t = performance.now(); for (let i = 0; i < n; i++) fs.rename(`${BENCH}\\File number ${i}.dat`, `${BENCH}\\Renamed ${i}.dat`); const rename = performance.now() - t;
      t = performance.now(); for (let i = 0; i < n; i++) fs.unlink(`${BENCH}\\Renamed ${i}.dat`); const del = performance.now() - t;
      fs.rmdir(BENCH);
      return { create_per_s: rate(create), read_per_s: rate(read), readdir_500_ms: +list_ms.toFixed(3), rename_per_s: rate(rename), delete_per_s: rate(del) };
    },
  },
  {
    name: 'display-properties',
    about: 'Display Properties: open, then each tab',
    run: async () => {
      await reset();
      const open = await measure(5, () => win95.displayProperties(), () => win95.close('Display Properties'));
      win95.displayProperties(); await frame();
      const w = win95.window('Display Properties');
      const tabs = await measure(12, () => win95.key('ctrl+tab'));
      await reset();
      return { open, tab_switch: tabs, window: { w: w.w, h: w.h } };
    },
  },
  {
    name: 'savers',
    about: 'each screen saver full screen for 6 s: start-up, animation timer rate, GL frames, guest CPU',
    run: async () => {
      await reset();
      const out = {};
      const list = win95.fs.readdir('C:\\WINDOWS\\SYSTEM', '*.scr').map(i => i.path).sort();
      for (const path of list) {
        const name = path.split('\\').pop().replace(/\.scr$/i, '');
        let failed = null; const off = win95.on('program.exit', e => { if (e.why) failed = e.why; });
        const t0 = performance.now(); win95.saver(path);
        let first = null;
        while (performance.now() - t0 < 15000 && !failed) { const s = win95.saverStats(); if (s && (s.timers || s.presents)) { first = performance.now() - t0; break; } await sleep(5); }
        const a = win95.saverStats(); const ta = performance.now();
        if (!failed && a) await sleep(6000);
        const b = win95.saverStats(), dt = (performance.now() - ta) / 1000;
        win95.stopSaver(); off(); await reset();
        if (failed || !a || !b) { out[name] = { failed: failed || 'did not start' }; continue; }
        out[name] = {
          startup_ms: first === null ? null : +first.toFixed(1),
          timers_per_s: +((b.timers - a.timers) / dt).toFixed(2),
          gl_frames_per_s: +((b.presents - a.presents) / dt).toFixed(2),
          guest_cpu_pct: +(100 * (b.guestMs - a.guestMs) / (dt * 1000)).toFixed(2),
        };
      }
      return out;
    },
  },
];
