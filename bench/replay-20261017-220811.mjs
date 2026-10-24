#!/usr/bin/env node
// Replay of the Windows 95 shell benchmark recorded 2026-10-17T22:08:11.494Z
// on Chrome/152.0.7977.149 (640x480, persistent store).
//
//   node bench/replay-20261017-220811.mjs [endpoint]     default http://127.0.0.1:9334 (the app's control port)
//
// Runs the recorded steps against a running shell and prints each metric next to the value recorded here.
// --record prints this run's results as JSON instead.

const PRELUDE = "\nconst frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));\nconst sleep = ms => new Promise(r => setTimeout(r, ms));\nconst stat = a => {\n  const s = [...a].sort((x, y) => x - y), r = v => +v.toFixed(3);\n  return { n: s.length, mean_ms: r(s.reduce((t, x) => t + x, 0) / s.length), p50_ms: r(s[s.length >> 1]),\n    p95_ms: r(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), max_ms: r(s[s.length - 1]) };\n};\n// the time an action takes to run and draw, and until the frame showing it is on screen\nconst measure = async (n, act, undo) => {\n  const sync = [], shown = [];\n  for (let i = 0; i < n; i++) {\n    await frame();\n    const t = performance.now(); await act(i); win95.render(); sync.push(performance.now() - t);\n    await frame(); shown.push(performance.now() - t);\n    if (undo) { await undo(i); await frame(); }\n  }\n  return { sync: stat(sync), to_frame: stat(shown) };\n};\nconst reset = async () => {\n  win95.stopSaver();\n  for (let k = 0; k < 20 && (win95.menus().length || win95.windows().length); k++) {\n    if (win95.menus().length) { win95.key('esc'); continue; }\n    const w = win95.windows().at(-1);\n    if (w.modal && /^Notepad$|Save/.test(w.title)) win95.key('alt+n'); else win95.close(w.title);\n  }\n  await frame();\n};\nconst BENCH = 'C:\\\\BENCH';\n// the share of the main thread other work took over ms: a chain of message-channel tasks, each gap past 0.25 ms counted\nconst load = ms => new Promise(done => {\n  const ch = new MessageChannel(), t0 = performance.now(); let last = t0, busy = 0, n = 0;\n  ch.port1.onmessage = () => {\n    const now = performance.now(), gap = now - last; if (gap > 0.25) busy += gap; last = now; n++;\n    if (now - t0 < ms) ch.port2.postMessage(0); else { ch.port1.close(); done({ busy_pct: +(100 * busy / (now - t0)).toFixed(2), tasks_per_s: +(n / ((now - t0) / 1000)).toFixed(0) }); }\n  };\n  ch.port2.postMessage(0);\n});\n// the guest time a native program used over ms, as a share of it\nconst guestCpu = async (app, ms) => { const a = app.proc.stats.guestMs, t = performance.now(); await sleep(ms); return +(100 * (app.proc.stats.guestMs - a) / (performance.now() - t)).toFixed(2); };\n";

const STEPS = [
  { name: "idle.load", about: "the empty desktop for 5 s: the main thread's busy share and how many tasks it ran",
    run: async () => { await reset(); return await load(5000); } },
  { name: "network", about: "the network's process (MPREXE with the network VxDs under it), as the shell starts it at boot: start-up to the card started, then 5 s idle: its guest CPU and the main thread's busy share",
    run: async () => {
      if (!win95.startNetwork) return { skipped: 'no network in this build' };
      await reset();
      // started as the shell boots (its logon dialog closed by reset): the time that start took
      const a = await win95.startNetwork(), start_ms = +((a && a.startMs) || 0).toFixed(1);
      if (!a || !a.alive) throw new Error('the network process did not start: ' + (a && a.proc && a.proc.trapped));
      const card = a.proc.devnodes().find(d => d.id === 'ROOT\\NET\\0000');
      if (!card || !card.started) throw new Error('the network card did not start');
      await sleep(1000);
      const [cpu, idle] = await Promise.all([guestCpu(a, 5000), load(5000)]);
      return { start_ms, guest_cpu_pct: cpu, idle_busy_pct: idle.busy_pct, frames_sent: window.W95LAN ? window.W95LAN.frames : 0 };
    } },
  { name: "midi", about: "CANYON.MID opened in Media Player through MCISEQ: start-up until the synthesizer is written, then its guest CPU for 4 s",
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
    } },
  { name: "render.idle", about: "one full redraw of the empty desktop (JS time to issue the canvas drawing)",
    run: async () => {
      await reset();
      const t = []; for (let i = 0; i < 300; i++) { const s = performance.now(); win95.render(); t.push(performance.now() - s); }
      return { render: stat(t) };
    } },
  { name: "input.desktop-click", about: "a click on empty desktop, through the pointer path",
    run: async () => {
      await reset();
      const s = win95.screen();
      return await measure(40, () => win95.click(s.width - 40, s.taskbar - 40));
    } },
  { name: "input.pointer-move", about: "a pointer move over the desktop (cursor redraw)",
    run: async () => {
      await reset();
      const s = win95.screen();
      return await measure(60, i => win95.move(100 + (i % 30) * 10, 100 + (i % 7) * 20));
    } },
  { name: "startmenu", about: "Start menu open, Programs submenu, close",
    run: async () => {
      await reset();
      const s = win95.screen();
      const open = await measure(20, () => win95.click(20, s.taskbar + 15), () => win95.key('esc'));
      win95.click(20, s.taskbar + 15); await frame();
      const sub = await measure(10, () => win95.key('down', 'right'), () => win95.key('left', 'up'));
      win95.key('esc'); await frame();
      return { open, programs: sub };
    } },
  { name: "folders", about: "folder windows: My Computer, C:\\, C:\\WINDOWS\\SYSTEM, D:\\WIN95 (CD); redraw with all four open",
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
    } },
  { name: "window.drag", about: "dragging a folder window by its title bar, per pointer move",
    run: async () => {
      await reset();
      win95.open('C:\\'); await frame();
      const w = win95.window('C:\\') || win95.windows().at(-1);
      let x = w.x + 60, y = w.y + 10;
      win95.down(x, y); await frame();
      const r = await measure(80, i => { x += i % 2 ? 3 : -2; y += 1; win95.move(x, y); });
      win95.up(x, y); await reset();
      return r;
    } },
  { name: "notepad", about: "open a 60,000-byte text file in Notepad (its limit is 65,535), type 1000 characters, save",
    run: async () => {
      await reset();
      if (!win95.fs.exists(BENCH)) win95.fs.mkdir(BENCH);
      const line = 'The quick brown fox jumps over the lazy dog. 0123456789\r\n';
      win95.fs.writeFile(BENCH + '\\big.txt', line.repeat(Math.ceil(60000 / line.length)).slice(0, 60000));
      // the native Notepad starts and closes on its own time: each open is timed to its window on screen
      const until = async (ok, ms = 20000) => { const t0 = performance.now(); while (!ok() && performance.now() - t0 < ms) await sleep(5); return ok(); };
      const opens = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now(); win95.run('notepad ' + BENCH + '\\big.txt');
        if (!await until(() => win95.window('big - Notepad'))) throw new Error('Notepad did not open the file: ' + win95.windows().map(w => w.title).join(', '));
        await frame(); opens.push(performance.now() - t0);
        win95.close('big - Notepad'); await until(() => !win95.windows().length);
      }
      const open = { to_window: stat(opens) };
      win95.run('notepad ' + BENCH + '\\big.txt'); await until(() => win95.window('big - Notepad')); await frame();
      // anything else on screen (a refusal, an error) would make the timings meaningless
      if (!win95.window('big - Notepad') || win95.windows().length !== 1) throw new Error('Notepad did not open the file: ' + win95.windows().map(w => w.title).join(', '));
      // the native Notepad takes typed keys as its USER's queue lets them in: typing ends when it has taken them all,
      // saving when the file has its new size
      const app = (win95.nativeApps || []).find(a => /NOTEPAD/i.test(a.path));
      const t = performance.now(); win95.type('x'.repeat(1000));
      while (app && app.keyq && app.keyq.length && performance.now() - t < 60000) await sleep(5);
      await sleep(50); const type_ms = performance.now() - t;
      const s = performance.now(); win95.key('alt+f', 's');
      while (win95.fs.stat(BENCH + '\\big.txt').size === 60000 && performance.now() - s < 10000) await sleep(5);
      const save_ms = performance.now() - s;
      const saved = win95.fs.stat(BENCH + '\\big.txt').size;
      if (saved !== 61000) throw new Error(`saved ${saved} bytes, expected 61000`);
      await reset();
      win95.fs.unlink(BENCH + '\\big.txt'); win95.fs.rmdir(BENCH);
      // opening the file put it on Start > Documents; take it off again
      for (const i of win95.fs.readdir('C:\\WINDOWS\\Recent')) if (/^Target=C:\\BENCH\\/im.test(win95.fs.readText(i.path))) win95.fs.unlink(i.path);
      return { open, type_1000_ms: +type_ms.toFixed(3), per_key_ms: +(type_ms / 1000).toFixed(4), save_ms: +save_ms.toFixed(3), saved_bytes: saved };
    } },
  { name: "fs", about: "file system with write-through: 500 files of 1 KB created, read, renamed, deleted",
    run: async () => {
      await reset();
      const fs = win95.fs, data = new Uint8Array(1024).fill(65), n = 500;
      if (fs.exists(BENCH)) for (const i of fs.readdir(BENCH)) fs.unlink(i.path);   // what an earlier step left
      else fs.mkdir(BENCH);
      const rate = (t, k = n) => +(k / (t / 1000)).toFixed(1);
      let t = performance.now(); for (let i = 0; i < n; i++) fs.writeFile(`${BENCH}\\File number ${i}.dat`, data); const create = performance.now() - t;
      t = performance.now(); for (let i = 0; i < n; i++) fs.readFile(`${BENCH}\\File number ${i}.dat`); const read = performance.now() - t;
      t = performance.now(); fs.readdir(BENCH); const list_ms = performance.now() - t;
      t = performance.now(); for (let i = 0; i < n; i++) fs.rename(`${BENCH}\\File number ${i}.dat`, `${BENCH}\\Renamed ${i}.dat`); const rename = performance.now() - t;
      t = performance.now(); for (let i = 0; i < n; i++) fs.unlink(`${BENCH}\\Renamed ${i}.dat`); const del = performance.now() - t;
      fs.rmdir(BENCH);
      return { create_per_s: rate(create), read_per_s: rate(read), readdir_500_ms: +list_ms.toFixed(3), rename_per_s: rate(rename), delete_per_s: rate(del) };
    } },
  { name: "display-properties", about: "Display Properties: open, then each tab",
    run: async () => {
      await reset();
      const open = await measure(5, () => win95.displayProperties(), () => win95.close('Display Properties'));
      win95.displayProperties(); await frame();
      const w = win95.window('Display Properties');
      const tabs = await measure(12, () => win95.key('ctrl+tab'));
      await reset();
      return { open, tab_switch: tabs, window: { w: w.w, h: w.h } };
    } },
  { name: "savers", about: "each screen saver full screen for 6 s: start-up, animation timer rate, GL frames, guest CPU",
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
    } },
];

const RECORDED = {
  "env": {
    "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Windows95/0.1.0 Chrome/152.0.7977.149 Electron/44.7.2 Safari/537.36",
    "screen": {
      "width": 640,
      "height": 480,
      "taskbar": 452
    },
    "dpr": 2,
    "cores": 8,
    "store": true,
    "browser": "Chrome/152.0.7977.149",
    "url": "file:///Users/johusha/Win95/electron/Windows%2095.app/Contents/Resources/app/web/index.html"
  },
  "results": {
    "boot": {
      "to_desktop_ms": 1056,
      "dom_content_loaded_ms": 232.4,
      "load_ms": 739.6
    },
    "idle.load": {
      "busy_pct": 6.3,
      "tasks_per_s": 385720
    },
    "network": {
      "start_ms": 2676.5,
      "guest_cpu_pct": 1.23,
      "idle_busy_pct": 6.53,
      "frames_sent": 9
    },
    "midi": {
      "start_ms": 441.3,
      "guest_cpu_pct": 3.53
    },
    "render.idle": {
      "render": {
        "n": 300,
        "mean_ms": 0.021,
        "p50_ms": 0,
        "p95_ms": 0.1,
        "max_ms": 0.6
      }
    },
    "input.desktop-click": {
      "sync": {
        "n": 40,
        "mean_ms": 0.52,
        "p50_ms": 0.5,
        "p95_ms": 1.2,
        "max_ms": 1.2
      },
      "to_frame": {
        "n": 40,
        "mean_ms": 16.752,
        "p50_ms": 16.7,
        "p95_ms": 19,
        "max_ms": 21.2
      }
    },
    "input.pointer-move": {
      "sync": {
        "n": 60,
        "mean_ms": 0.438,
        "p50_ms": 0.4,
        "p95_ms": 1.1,
        "max_ms": 1.5
      },
      "to_frame": {
        "n": 60,
        "mean_ms": 16.618,
        "p50_ms": 16.5,
        "p95_ms": 19.3,
        "max_ms": 20.1
      }
    },
    "startmenu": {
      "open": {
        "sync": {
          "n": 20,
          "mean_ms": 0.66,
          "p50_ms": 0.5,
          "p95_ms": 1.7,
          "max_ms": 1.7
        },
        "to_frame": {
          "n": 20,
          "mean_ms": 16.595,
          "p50_ms": 16.6,
          "p95_ms": 20.7,
          "max_ms": 20.7
        }
      },
      "programs": {
        "sync": {
          "n": 10,
          "mean_ms": 1.14,
          "p50_ms": 1.3,
          "p95_ms": 1.7,
          "max_ms": 1.7
        },
        "to_frame": {
          "n": 10,
          "mean_ms": 15.98,
          "p50_ms": 16.6,
          "p95_ms": 18.1,
          "max_ms": 18.1
        }
      }
    },
    "folders": {
      "c_root": {
        "sync": {
          "n": 5,
          "mean_ms": 2.08,
          "p50_ms": 1,
          "p95_ms": 6.4,
          "max_ms": 6.4
        },
        "to_frame": {
          "n": 5,
          "mean_ms": 16.22,
          "p50_ms": 16.5,
          "p95_ms": 16.7,
          "max_ms": 16.7
        }
      },
      "windows_system": {
        "sync": {
          "n": 5,
          "mean_ms": 2.88,
          "p50_ms": 3.1,
          "p95_ms": 5.1,
          "max_ms": 5.1
        },
        "to_frame": {
          "n": 5,
          "mean_ms": 16.34,
          "p50_ms": 16.5,
          "p95_ms": 19,
          "max_ms": 19
        }
      },
      "cd_win95": {
        "sync": {
          "n": 5,
          "mean_ms": 3.06,
          "p50_ms": 3,
          "p95_ms": 5.1,
          "max_ms": 5.1
        },
        "to_frame": {
          "n": 5,
          "mean_ms": 17.5,
          "p50_ms": 16.8,
          "p95_ms": 19.8,
          "max_ms": 19.8
        }
      },
      "my_computer": {
        "sync": {
          "n": 5,
          "mean_ms": 1.28,
          "p50_ms": 0.9,
          "p95_ms": 2.7,
          "max_ms": 2.7
        },
        "to_frame": {
          "n": 5,
          "mean_ms": 16.6,
          "p50_ms": 16.3,
          "p95_ms": 17.6,
          "max_ms": 17.6
        }
      },
      "render_four_open": {
        "n": 100,
        "mean_ms": 0.461,
        "p50_ms": 0.3,
        "p95_ms": 0.9,
        "max_ms": 8.6
      }
    },
    "window.drag": {
      "sync": {
        "n": 80,
        "mean_ms": 0.527,
        "p50_ms": 0.5,
        "p95_ms": 1.1,
        "max_ms": 1.5
      },
      "to_frame": {
        "n": 80,
        "mean_ms": 16.846,
        "p50_ms": 16.7,
        "p95_ms": 19.6,
        "max_ms": 24.2
      }
    },
    "notepad": {
      "open": {
        "to_window": {
          "n": 5,
          "mean_ms": 193.2,
          "p50_ms": 185.6,
          "p95_ms": 249.8,
          "max_ms": 249.8
        }
      },
      "type_1000_ms": 3688.1,
      "per_key_ms": 3.6881,
      "save_ms": 43.8,
      "saved_bytes": 61000
    },
    "fs": {
      "create_per_s": 19841.3,
      "read_per_s": 500000,
      "readdir_500_ms": 0.3,
      "rename_per_s": 23923.4,
      "delete_per_s": 128205.1
    },
    "display-properties": {
      "open": {
        "sync": {
          "n": 5,
          "mean_ms": 1.24,
          "p50_ms": 0.8,
          "p95_ms": 3,
          "max_ms": 3
        },
        "to_frame": {
          "n": 5,
          "mean_ms": 122.36,
          "p50_ms": 121.1,
          "p95_ms": 157.5,
          "max_ms": 157.5
        }
      },
      "tab_switch": {
        "sync": {
          "n": 12,
          "mean_ms": 0.592,
          "p50_ms": 0.3,
          "p95_ms": 3.5,
          "max_ms": 3.5
        },
        "to_frame": {
          "n": 12,
          "mean_ms": 16.958,
          "p50_ms": 16.6,
          "p95_ms": 24.5,
          "max_ms": 24.5
        }
      },
      "window": {
        "w": 398,
        "h": 445
      }
    },
    "savers": {
      "Blank Screen": {
        "startup_ms": null,
        "timers_per_s": 0,
        "gl_frames_per_s": 0,
        "guest_cpu_pct": 0.04
      },
      "Curves and Colors": {
        "startup_ms": 71.1,
        "timers_per_s": 18.16,
        "gl_frames_per_s": 0,
        "guest_cpu_pct": 3.12
      },
      "Flying Through Space": {
        "startup_ms": 68.6,
        "timers_per_s": 18.16,
        "gl_frames_per_s": 0,
        "guest_cpu_pct": 0.99
      },
      "Flying Windows": {
        "startup_ms": 73.1,
        "timers_per_s": 18.16,
        "gl_frames_per_s": 0,
        "guest_cpu_pct": 4.79
      },
      "Mystify Your Mind": {
        "startup_ms": 84.7,
        "timers_per_s": 18.14,
        "gl_frames_per_s": 0,
        "guest_cpu_pct": 1.49
      },
      "SS3DFO": {
        "startup_ms": 206.3,
        "timers_per_s": 18.16,
        "gl_frames_per_s": 36.32,
        "guest_cpu_pct": 16.41
      },
      "SSFLWBOX": {
        "startup_ms": 126.2,
        "timers_per_s": 18.16,
        "gl_frames_per_s": 54.49,
        "guest_cpu_pct": 12.93
      },
      "SSMAZE": {
        "startup_ms": 406,
        "timers_per_s": 18.16,
        "gl_frames_per_s": 18.16,
        "guest_cpu_pct": 10.83
      },
      "SSPIPES": {
        "startup_ms": 206.1,
        "timers_per_s": 17.66,
        "gl_frames_per_s": 35.33,
        "guest_cpu_pct": 3.24
      },
      "SSTEXT3D": {
        "startup_ms": 189.4,
        "timers_per_s": 18.17,
        "gl_frames_per_s": 54.5,
        "guest_cpu_pct": 7.97
      },
      "Scrolling Marquee": {
        "startup_ms": 74.4,
        "timers_per_s": 18.17,
        "gl_frames_per_s": 0,
        "guest_cpu_pct": 0.48
      }
    }
  },
  "at": "2026-10-17T22:08:11.494Z"
};

// ---- runner (bench/runner.mjs)
// Runs benchmark steps in the shell's page over the DevTools protocol and compares results with a baseline.
// Shared by bench.mjs and every replay script it records (which carry a copy of this file).

async function connect(endpoint) {
  const list = await (await fetch(endpoint + '/json')).json();
  const page = list.find(t => t.type === 'page' && /index\.html|localhost:8095\/?$/.test(t.url)) || list.find(t => t.type === 'page');
  if (!page) throw new Error('no page at ' + endpoint);
  const version = await (await fetch(endpoint + '/json/version')).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const api = { onEvent: null };
  ws.onmessage = m => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (api.onEvent) api.onEvent(d); };
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  const call = (method, params = {}) => new Promise((ok, no) => {
    pend.set(++id, d => d.error ? no(new Error(`${method}: ${d.error.message}`)) : ok(d.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, timeout = 300000) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return Object.assign(api, { call, evaluate, version, url: page.url, close: () => ws.close() });
}

// boot: reload the page and time it until the shell has drawn its desktop
async function boot(c) {
  const t0 = Date.now();
  await c.call('Page.enable');
  await c.call('Page.reload', { ignoreCache: false });
  for (;;) {
    await new Promise(r => setTimeout(r, 10));
    let ready = false;
    try { ready = await c.evaluate(`typeof win95 === 'object' && win95.state.screen === 'desktop' && document.fonts.status === 'loaded'`); } catch (_) { /* page still loading */ }
    if (ready) break;
    if (Date.now() - t0 > 60000) throw new Error('shell did not boot within 60 s');
  }
  const nav = await c.evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; return { dom_content_loaded_ms: +n.domContentLoadedEventEnd.toFixed(1), load_ms: +n.loadEventEnd.toFixed(1) }; })()`);
  await new Promise(r => setTimeout(r, 300));
  return { to_desktop_ms: Date.now() - t0, ...nav };
}

async function runAll(endpoint, prelude, steps, log = console.log) {
  const c = await connect(endpoint);
  const env = await c.evaluate(`({ userAgent: navigator.userAgent, screen: win95.screen(), dpr: devicePixelRatio, cores: navigator.hardwareConcurrency, store: typeof W95HOST === 'object' })`);
  env.browser = c.version.Browser; env.url = c.url;
  const results = {};
  log(`boot ...`); results.boot = await boot(c);
  for (const s of steps) {
    log(`${s.name} ...`);
    const src = typeof s.run === 'string' ? s.run : s.run.toString();
    try { results[s.name] = await c.evaluate(`(async () => { ${prelude}\n return await (${src})(); })()`); }
    catch (e) { results[s.name] = { failed: e.message.split('\n')[0] }; }
  }
  await c.evaluate(`(async () => { ${prelude}\n await reset(); })()`).catch(() => {});
  c.close();
  return { env, results, at: new Date().toISOString() };
}

// every leaf metric as [path, value]
function flatten(o, pre = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const p = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, p, out); else out.push([p, v]);
  }
  return out;
}

function table(results, baseline) {
  const base = baseline ? new Map(flatten(baseline)) : null, rows = [];
  for (const [p, v] of flatten(results)) {
    if (/\.n$|p50_ms$|max_ms$/.test(p)) continue;
    const row = { metric: p, value: v };
    if (base && base.has(p) && typeof v === 'number' && typeof base.get(p) === 'number') {
      const b = base.get(p); row.baseline = b;
      if (b !== 0) {
        const d = (v - b) / Math.abs(b) * 100, lowerBetter = /_ms$|_pct$/.test(p), higherBetter = /_per_s$/.test(p);
        row.change = `${d >= 0 ? '+' : ''}${d.toFixed(1)}%` + (Math.abs(d) < 10 || !(lowerBetter || higherBetter) ? '' : (d < 0) === lowerBetter ? ' better' : ' worse');
      }
    } else if (base && base.has(p)) row.baseline = base.get(p);
    rows.push(row);
  }
  return rows;
}

function print(rows) {
  const cols = Object.keys(rows.reduce((a, r) => Object.assign(a, r), {}));
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = r => cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  ');
  console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
}

// ---- replay
const endpoint = process.argv.slice(2).find(a => !a.startsWith('--')) || 'http://127.0.0.1:9334';
const now = await runAll(endpoint, PRELUDE, STEPS, m => process.stderr.write(m + '\n'));
if (process.argv.includes('--record')) console.log(JSON.stringify(now, null, 2));
else { console.log(`recorded ${RECORDED.at} on ${RECORDED.env.browser}; now ${now.at} on ${now.env.browser}\n`); print(table(now.results, RECORDED.results)); }
