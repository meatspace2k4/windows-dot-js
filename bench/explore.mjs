#!/usr/bin/env node
// Explores the running system through the input a person has (SCRIPTING.md) and lists what went wrong on the way,
// each with the path of inputs that led to it.
//
//   node bench/explore.mjs [endpoint] [--minutes 10] [--depth 12]
//
// A state is the window stack, the open menus and the guest programs running. From a state the explorer takes an
// input not yet tried there: a click on an element win95.elements() lists, or a key to whatever has the focus. At the
// depth limit, or with nothing left to try, it reloads and replays the path to a state that has untried inputs.
// Controls that change or destroy data (runner.mjs DESTRUCTIVE) are not pressed.
//
// Writes bench/results/explore-<stamp>.json and, for each finding, bench/repro-<stamp>-<n>.mjs: a replay of its path
// in the layout bench.mjs records, which gaps.mjs runs as it is.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, capture, DESTRUCTIVE, replaySource, SHELL_READY, homeTargets } from './runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const MINUTES = +opt('minutes', 10), DEPTH = +opt('depth', 12);
const endpoint = argv[0] || 'http://127.0.0.1:9334';

// ---- in the page: what is on screen, one input, and waiting until the shell is quiet after it
const PAGE = `
if (!window.__xp) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let last = performance.now();
  win95.on('*', () => { last = performance.now(); });
  const ACT = new Set(['pushbutton', 'menuitem', 'listitem', 'checkbutton', 'radiobutton', 'pagetab', 'text-edit', 'combobox', 'list', 'outlineitem']);
  // no shell event for quietMs, at most maxMs
  const settle = async (quietMs = 500, maxMs = 8000) => {
    const t0 = performance.now(); await sleep(100);
    while (performance.now() - last < quietMs && performance.now() - t0 < maxMs) await sleep(40);
  };
  // (a machine in a worker reports its windows' controls a moment after it is asked: one look asks, the next reads)
  const obs = async () => {
    win95.elements(); await sleep(100);
    const seen = new Map(), els = [];
    for (const e of win95.elements()) {
      if (!ACT.has(e.role) || e.covered) continue;
      const k = e.window + '\\u0000' + e.role + '\\u0000' + e.name, nth = seen.get(k) || 0; seen.set(k, nth + 1);
      if (!e.disabled) els.push({ role: e.role, name: e.name || '', window: e.window, nth });
    }
    return {
      wins: win95.windows().filter(w => !w.minimized).map(w => ({ title: w.title, modal: !!w.modal, active: !!w.active })),
      menus: win95.menus(), els, screen: win95.state.screen,
      progs: win95.nativeApps.filter(a => a.alive).map(a => String(a.path || '').split(/[\\\\/]/).pop().toUpperCase()).sort(),
    };
  };
  // the element an input names: window, role, name, and which of the elements with all three
  const at = t => { const e = win95.elements({ window: t.window, role: t.role, name: t.name })[t.nth || 0]; return e && !e.covered ? e : null; };
  const act = async a => {
    if (a.do === 'key') win95.key(...a.keys);
    else { const e = at(a.t); if (!e) return { missing: true }; win95.click(e, { button: a.button, double: !!a.double }); }
    await settle();
    return {};
  };
  // back to the bare desktop without a reload: menus closed, then every window above the desktop closed as its close
  // box would, top first
  const home = async targets => {
    for (let i = 0; i < 3; i++) { win95.key('esc'); await sleep(120); }
    for (const t of targets(win95.windows())) { win95.close(t); await settle(); }
    await settle(1000, 10000);
  };
  window.__xp = { obs, act, settle, home };
}
`;

const c = await connect(endpoint), cap = await connect(endpoint);
let pending = [];                       // findings since the last input started
await capture(cap, (kind, detail) => pending.push({ kind, detail }));
const page = expr => c.evaluate(`(async () => { ${PAGE}\n return await (${expr}); })()`);
const step = a => page(`window.__xp.obs().then(() => window.__xp.act(${JSON.stringify(a)}))`);

async function reload() {
  await c.call('Page.enable');
  await c.call('Page.reload', { ignoreCache: false });
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 50));
    let ok = false; try { ok = await c.evaluate(SHELL_READY); } catch (_) { /* loading */ }
    if (ok) break;
    if (Date.now() - t0 > 90000) throw new Error('the system did not come up within 90 s');
  }
  await page(`window.__xp.settle(1500, 60000)`);
}

const stateKey = o => JSON.stringify([o.screen, o.wins.map(w => [w.title, w.modal, w.active]), o.menus, o.progs]);
const sig = a => JSON.stringify(a);

// the inputs a person has in this state
function inputs(o) {
  if (o.screen !== 'desktop') return [];
  if (o.wins.some(w => w.title === 'Shut Down Windows')) return [{ do: 'key', keys: ['esc'] }];
  const out = [], modal = o.wins.find(w => w.modal && w.active), top = o.wins.at(-1);
  for (const e of o.els) {
    if (DESTRUCTIVE.test(e.name) || (modal && e.window !== modal.title && e.window !== 'Menu')) continue;
    const t = { window: e.window, role: e.role, name: e.name, nth: e.nth };
    out.push({ do: 'click', t });
    if (e.role === 'listitem' || e.role === 'outlineitem') out.push({ do: 'click', t, double: true }, { do: 'click', t, button: 'right' });
    if (e.role === 'list') out.push({ do: 'click', t, button: 'right' });
  }
  const keys = ['F1', 'shift+F10', 'esc', 'enter', 'tab', 'shift+tab', 'down', 'space', 'alt+space', 'ctrl+esc'];
  if (top && top.title) keys.push('alt+F4');
  for (const k of keys) out.push({ do: 'key', keys: [k] });
  return out;
}
const describe = a => a.do === 'key' ? `key ${a.keys.join(' ')}`
  : `${a.button === 'right' ? 'right-click' : a.double ? 'double-click' : 'click'} ${a.t.role} ${a.t.name || '#' + a.t.nth} in ${a.t.window}`;

// ---- the walk
const states = new Map();               // key -> { path, tried: Set, untried }
const findings = new Map();
const note = (found, path) => {
  for (const f of found) {
    const k = f.kind + '\u0000' + f.detail, g = findings.get(k);
    if (!g) findings.set(k, { ...f, count: 1, path: [...path] });
    else { g.count++; if (path.length < g.path.length) g.path = [...path]; }
  }
};
const touch = (o, path) => {
  const k = stateKey(o);
  let s = states.get(k);
  if (!s) states.set(k, s = { path: [...path], tried: new Set() });
  else if (path.length < s.path.length) s.path = [...path];
  s.untried = inputs(o).filter(a => !s.tried.has(sig(a))).length;
  return s;
};

const deadline = Date.now() + MINUTES * 60000;
await reload();
note(pending, []);
let o = await page(`window.__xp.obs()`), path = [], cur = touch(o, path);
const root = stateKey(o);
// back to the bare desktop: by closing what is open (no reboot of the machine), by a reload when that does not get there
const home = async () => {
  await page(`window.__xp.home(${homeTargets.toString()})`);
  const now = await page(`window.__xp.obs()`);
  if (stateKey(now) === root) return;
  await reload();
};
while (Date.now() < deadline) {
  const a = path.length < DEPTH ? inputs(o).find(x => !cur.tried.has(sig(x))) : null;
  if (!a) {
    // back to a state with inputs left: the bare desktop, then its path again
    const next = [...states.entries()].filter(([, s]) => s.untried > 0 && s.path.length < DEPTH).sort((x, y) => x[1].path.length - y[1].path.length)[0];
    if (!next) break;
    await home();
    let lost = false;
    for (const b of next[1].path) if ((await step(b)).missing) { lost = true; break; }
    o = await page(`window.__xp.obs()`);
    if (lost || stateKey(o) !== next[0]) { next[1].untried = 0; continue; }   // not reached the same way again: left
    path = [...next[1].path]; cur = next[1];
    continue;
  }
  cur.tried.add(sig(a)); cur.untried--;
  pending = [];
  if ((await page(`window.__xp.act(${JSON.stringify(a)})`)).missing) continue;
  path.push(a);
  await new Promise(r => setTimeout(r, 100));   // (events the input caused still arriving on the listening connection)
  note(pending, path);
  process.stderr.write(`${states.size} states, ${findings.size} findings  ${describe(a)}${pending.length ? '  ! ' + pending.map(f => f.kind).join(', ') : ''}\n`);
  o = await page(`window.__xp.obs()`);
  cur = touch(o, path);
}

// ---- a replay per finding, so gaps.mjs runs it as it is
const at = new Date().toISOString(), stamp = at.replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const runnerSrc = readFileSync(join(here, 'runner.mjs'), 'utf8');
const list = [...findings.values()];
list.forEach((f, i) => {
  if (!f.path.length) return;
  const run = `async () => {
      await window.__xp.settle(1500, 60000);
      const path = ${JSON.stringify(f.path)};
      for (const a of path) { await window.__xp.obs(); if ((await window.__xp.act(a)).missing) throw new Error('input target missing: ' + JSON.stringify(a)); }
      return { inputs: path.length };
    }`;
  const file = `repro-${stamp}-${i + 1}.mjs`;
  writeFileSync(join(here, file), replaySource({
    title: `Reproduces ${f.kind}: ${f.detail}\n// found by bench/explore.mjs ${at}: ${f.path.map(describe).join('; ')}`,
    usage: `bench/${file}`, prelude: PAGE + '\nconst reset = async () => {};\n', steps: [{ name: 'repro', about: `${f.kind}: ${f.detail}`, run }],
    recorded: { env: { browser: c.version.Browser }, results: {}, at }, runnerSrc,
  }), { mode: 0o755 });
  f.repro = `bench/${file}`;
});

mkdirSync(join(here, 'results'), { recursive: true });
const out = join(here, 'results', `explore-${stamp}.json`);
writeFileSync(out, JSON.stringify({ at, endpoint, minutes: MINUTES, depth: DEPTH, states: states.size,
  findings: list.map(f => ({ kind: f.kind, detail: f.detail, count: f.count, repro: f.repro, steps: f.path.map(describe) })) }, null, 2) + '\n');
c.close(); cap.close();

console.log(`${states.size} states reached\n`);
if (!list.length) console.log('nothing went wrong');
for (const f of list) console.log(`${f.kind}: ${f.detail}  (x${f.count})\n    ${f.path.map(describe).join('\n    ') || '(at start-up)'}${f.repro ? `\n    replay: ${f.repro}` : ''}`);
process.stderr.write(`\nresults: bench/results/explore-${stamp}.json\n`);
