// A screen saver a machine starts (Display Properties' Preview, Settings, and the small preview in its monitor) is a
// process of that machine whose end the applet sees: the page tells the machine when the saver ends or does not
// start (saverExit), and the machine tells the page when it ended the process (saverStop, the applet picking
// another saver). The small preview lies over the applet's monitor window, whose rectangle the machine gives (winRect)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8'), k = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i) + b.length); };

// startFullSaver(path, o): a start refused (another saver up, no path) tells o.onExit; a start that fails stops the run
{
  const body = cut(w, 'function startFullSaver(path, o = {}) {', '\n}\n');
  const calls = [];
  const fn = new Function('fullSaver', 'closeMenus', 'SaverRun', `${body}\nreturn startFullSaver;`);
  class Run { constructor(p, m, o) { this.o = o; calls.push(['new', p, m]); } start() { return Promise.resolve(false); } stop(c) { calls.push(['stop', c]); if (this.o.onExit) this.o.onExit(c); } }
  const start = fn(null, () => {}, Run);
  const exits = [];
  start('C:\\X.SCR', { onExit: c => exits.push(c) });
  assert.deepEqual(calls[0], ['new', 'C:\\X.SCR', 's']);
  await new Promise(ok => setTimeout(ok, 0)); {
    assert.deepEqual(calls[1], ['stop', 1]); assert.deepEqual(exits, [1]);
    const start2 = fn({ alive: true }, () => {}, Run), exits2 = [];
    start2('C:\\Y.SCR', { onExit: c => exits2.push(c) }); assert.deepEqual(exits2, [1]);   // (another saver is up: refused at once)
    // the page's part: every mode gets the machine's pid and answers with saverExit; the small preview takes the monitor's rectangle
    const serve = cut(w, "else if (m.method === 'saver') {", '\n        }');
    assert.ok(/const \[file, mode, pid, hwnd\] = m\.args/.test(serve) && /saverExit/.test(serve) && /rect: \(\) => this\.cmd\('winRect', \[hwnd\]\)/.test(serve));
    assert.ok(/case 'saverStop': \{ const run = saverRuns\.get\(m\.pid\)/.test(w));
    // the machine's part: a process for /s, /c and /p alike, ended from the page or from here; the monitor's rectangle
    const ex = cut(k, "if (/\\.scr$/i.test(file)) {", '\n    }');
    assert.ok(!/mode === 'p'\) return 2/.test(ex) && /pc\.onExit = \(\) => post\(\{ t: 'saverStop', pid \}\)/.test(ex) && /rpc\('host', 'saver', \[file, mode, pid, hwnd\]\)/.test(ex));
    assert.ok(/case 'winRect':/.test(k) && /m\.t === 'saverExit'/.test(k));
    console.log('saverprocess: ok');
  }
}
