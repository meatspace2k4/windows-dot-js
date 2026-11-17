#!/usr/bin/env node
// Regressions of Windows 98 after the upgrade, checked from moments anchored on this computer (braid.anchor) rather
// than by running Setup again: each change is loaded into the page (the machines' scripts by reloadScript, any other by
// reloading the page, whose machines then arrive at an anchored moment booted as the new build is), the line travels
// to the case's anchor, and the case is lived from there (bench/win98-setup.md's rungs 6 to 9, then Windows 98's own
// desktop). Minutes, where Setup is an hour; Setup runs once to lay the anchors down (armAnchors, from pageDrive).
//
//   node bench/anchor98.mjs [endpoint] [--load changed|page|none] [case ...]
//   node bench/anchor98.mjs --list
//
// endpoint: a DevTools address (default http://127.0.0.1:9334) whose page is the origin that anchored the moments
// (IndexedDB). --load: `changed` (default) loads the scripts the tree changed since the last commit, `page` reloads the
// page, `none` leaves it. In a page with no DevTools endpoint: `(await import('/bench/anchor98.mjs')).pageCheck('desktop')`.
// Each case prints `ANCHOR98 {json}`; the exit code is the number of cases that failed (2 when the page has none of
// their anchors).
import { connect, SHELL_READY } from './runner.mjs';

// the anchors Setup lays down as it climbs: armed by bench/setup98.mjs's pageDrive, each taken once when its rung is met
export const ANCHORS = {
  // the PC's boot after Setup's restart: the screen leaves Windows 95's desktop
  'w98-reboot': { type: 'screen', test: 'e => e.screen !== "desktop"' },
  // the first boot of Windows 98: its Setup's first-start screen (RUNONCE's "Windows 98 Setup")
  'w98-firstboot': { type: 'window.open', test: 'e => /^Windows 98 Setup$/.test(e.title) && !!window.__w98rebooted' },
  // Windows 98's desktop: the first start's items done, Explorer's desktop up and the line quiet for 30 s
  'w98-desktop': { type: 'window.open', test: 'e => e.title === "Program Manager" && !!window.__w98rebooted', settle: 30000 },
};

/** runs in the page: the anchors above taken as Setup meets each rung (once each); returns a function that disarms */
export const armAnchors = (anchors = ANCHORS) => {
  const B = win95.braid, offs = [];
  offs.push(win95.on('screen', e => { if (e.screen !== 'desktop') window.__w98rebooted = true; }));
  for (const [name, a] of Object.entries(anchors)) {
    const test = (0, eval)(`(${a.test})`); let done = false;
    offs.push(win95.on(a.type, async e => {
      if (done || !test(e)) return; done = true;
      if (a.settle) { const quiet = await new Promise(r => { const off = win95.on('braid.fault', () => { off(); r(false); }); setTimeout(() => { off(); r(true); }, a.settle); }); if (!quiet) { done = false; return; } }
      try { const r = await B.anchor(name); win95.note(`anchored ${name} (${r && r.verdict})`); } catch (x) { win95.note(`anchor ${name} failed: ${x.message}`); done = false; }
    }));
  }
  return () => offs.forEach(f => f());
};

/** the cases: the anchor to start from; `type`/`test` the event that says it passed (waited for from before the
 *  travel, or from before `act` when there is one); `act` what a person does there; `check` a function's source
 *  answering a failure (a string) or nothing, run when the event has come (or at once with no event); `hold` ms the
 *  machine must then run with no fault and the line no broken verdict */
export const CASES = {
  // rung 6: ExitWindows from "Restarting your computer": USER's 3Bh ends every other process's tasks and returns
  // (the PC's own boot screens, not any change: a black screen is also what a machine that stopped shows)
  restart: { anchor: 'exitwin-stuck', type: 'screen', test: 'e => e.screen === "dos" || e.screen === "logow" || e.screen === "logos"', ms: 10 * 60000, rung: 6 },
  // rung 7: the PC boots what Setup copied, and Windows 98's IO.SYS draws its own logo (v86.js VGA)
  logo: { anchor: 'w98-reboot', type: 'screen', test: 'e => e.screen === "logow" || e.screen === "logos"', ms: 10 * 60000, rung: 7 },
  // rung 8: the first boot shows Windows 98's Setup screen (98's RUNONCE, from SYSTEM; a Windows 95 one is the stray)
  firstboot: { anchor: 'w98-reboot', type: 'window.open', test: 'e => /Setup$/.test(e.title)', ms: 30 * 60000, rung: 8,
    check: 'async () => /^Windows 98 Setup$/.test(win95.windows().map(w => w.title).find(t => /Setup$/.test(t)) || "") ? null : "the first boot\'s Setup screen is " + JSON.stringify(win95.windows().map(w => w.title))' },
  // rung 9: the first start's items run to Explorer's desktop
  desktop: { anchor: 'w98-firstboot', type: 'window.open', test: 'e => e.title === "Program Manager"', ms: 30 * 60000, rung: 9, hold: 30000,
    check: 'async () => { const t = win95.windows().map(w => w.title); return t.some(x => /Windows 95/.test(x)) ? "a Windows 95 window on Windows 98\'s desktop: " + JSON.stringify(t) : null; }' },
  // after the upgrade: Windows 98's Start menu (Windows Update is 98's, not 95's)
  startmenu: { anchor: 'w98-desktop', act: 'async () => win95.key("ctrl+esc")', type: 'menu.open', test: 'e => (e.menus || []).length > 0', ms: 60000, rung: 9,
    check: 'async () => { const m = win95.menus().flat(); win95.key("esc"); return m.some(x => /Windows Update/.test(x)) ? null : "the Start menu is not Windows 98\'s: " + JSON.stringify(m); }' },
  // after the upgrade: RUNONCE.EXE only where Setup puts it (a copy in the Windows folder runs before SYSTEM's)
  runonce: { anchor: 'w98-desktop', ms: 60000, rung: 9,
    check: 'async () => { const has = f => { try { return !!win95.fs.stat(f); } catch (_) { return false; } }; return has("C:\\\\WINDOWS\\\\RUNONCE.EXE") ? "a RUNONCE.EXE in the Windows folder" : has("C:\\\\WINDOWS\\\\SYSTEM\\\\RUNONCE.EXE") ? null : "no RUNONCE.EXE in SYSTEM"; }' },
  // after the upgrade: the desktop stays up, nothing faults, for two minutes of the machine's own running
  idle: { anchor: 'w98-desktop', ms: 60000, rung: 9, hold: 120000,
    check: 'async () => win95.sysApp && win95.sysApp.alive ? null : "the system\'s machine is not running"' },
};

/** runs in the page: one case. Resolves with { case, anchor, rung, ok, why, ms, event, faults } */
export const pageCheck = async (name, cases = CASES) => {
  const c = cases[name]; if (!c) throw new Error(`no case ${name}: ${Object.keys(cases).join(', ')}`);
  const B = win95.braid, t0 = performance.now(), out = { case: name, anchor: c.anchor, rung: c.rung };
  const sleep = ms => new Promise(r => setTimeout(r, ms)), fn = s => (s ? (0, eval)(`(${s})`) : null);
  if (!(await B.moments()).some(m => m.name === c.anchor)) return { ...out, ok: false, missing: true, why: `no moment ${c.anchor} in this origin` };
  let failed = null; const fail = why => { if (!failed) failed = why; };
  const offs = [win95.on('braid.fault', e => fail(`fault: ${JSON.stringify(e.fault || e).slice(0, 300)}`)),
    win95.on('braid.broken', e => fail(`broken: ${JSON.stringify(e.findings || e).slice(0, 300)}`))];
  // (a failure ends the wait at once: each wait is raced with the first fault or broken verdict)
  const orFail = p => new Promise((ok, no) => { const iv = setInterval(() => { if (failed) { clearInterval(iv); no(new Error(failed)); } }, 250); p.then(v => { clearInterval(iv); ok(v); }, e => { clearInterval(iv); no(e); }); });
  try {
    let ev = null, there = false;
    if (c.act) { await B.travel(c.anchor, { force: true }); there = true; await sleep(500); }
    // (waited for from before the travel, so nothing the arrival sets off is missed; but only an event after the
    // arrival counts: the page's state before it, or the restore itself, is not the case passing)
    const test = c.type ? fn(c.test) : null, reached = c.type ? win95.next(c.type, e => there && test(e), c.ms) : null;
    if (!c.act) { const t = B.travel(c.anchor, { force: true }); await t; there = true; } else await fn(c.act)();
    if (reached) ev = await orFail(reached);
    const why = c.check ? await orFail(Promise.resolve(fn(c.check)())) : null;
    if (why) throw new Error(why);
    if (c.hold) await orFail(sleep(c.hold));
    if (failed) throw new Error(failed);
    return { ...out, ok: true, ms: Math.round(performance.now() - t0), event: ev };
  } catch (e) {
    const faults = win95.sysApp ? await Promise.race([win95.sysApp.cmd('faults'), sleep(8000).then(() => null)]) : null;
    return { ...out, ok: false, ms: Math.round(performance.now() - t0), why: failed || e.message, faults: (faults || []).filter(f => f.thread !== 'host') };
  } finally { offs.forEach(f => f()); }
};

if (typeof process === 'object' && import.meta.url === `file://${process.argv[1]}`) {   // (imported by a page too)
  const { readFileSync } = await import('node:fs'), { execFileSync } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname;
  const args = process.argv.slice(2);
  if (args[0] === '--list') { for (const [k, v] of Object.entries(CASES)) console.log(`${k}\trung ${v.rung}\tfrom ${v.anchor}${v.type ? `\tuntil ${v.type}` : ''}${v.check ? '\tcheck' : ''}${v.hold ? `\thold ${v.hold / 1000}s` : ''}`); process.exit(0); }
  const endpoint = args[0] && /^https?:/.test(args[0]) ? args.shift() : (process.env.W95_DEVTOOLS || 'http://127.0.0.1:9334');
  let load = 'changed'; const li = args.indexOf('--load'); if (li >= 0) { load = args[li + 1]; args.splice(li, 2); }
  const names = args.length ? args : Object.keys(CASES);
  for (const n of names) if (!CASES[n]) { console.error(`no case ${n}: ${Object.keys(CASES).join(', ')}`); process.exit(64); }
  const c = await connect(endpoint);
  const ready = async () => { for (let i = 0; i < 300 && !(await c.evaluate(SHELL_READY).catch(() => false)); i++) await new Promise(r => setTimeout(r, 1000)); };
  await ready();
  // the change under test into the page: the machines' scripts in place (reloadScript), anything else by a reload
  // of the page, which then arrives at each anchor booted as this tree is (braid.travel)
  if (load !== 'none') {
    const worker = new Set((readFileSync(root + 'win95.js', 'utf8').match(/const WORKER_SCRIPTS = new Set\(\[([^\]]*)\]\)/) || [, ''])[1].match(/[\w.-]+\.js/g) || []);
    const changed = load === 'page' ? null : execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => /^[\w.-]+\.js$/.test(f));
    if (changed === null || changed.some(f => !worker.has(f))) {
      console.log(`ANCHOR98 load page${changed ? ` (${changed.filter(f => !worker.has(f)).join(', ')})` : ''}`);
      await c.call('Page.reload', { ignoreCache: true }); await new Promise(r => setTimeout(r, 2000)); await ready();
    } else for (const f of changed) { const r = await c.evaluate(`win95.reloadScript(${JSON.stringify(f)}).then(() => true)`); console.log(`ANCHOR98 load ${f} ${r}`); }
  }
  let failed = 0, missing = 0;
  for (const n of names) {
    const r = await c.evaluate(`import(new URL('bench/anchor98.mjs', document.baseURI).href).then(m => m.pageCheck(${JSON.stringify(n)}))`, CASES[n].ms + (CASES[n].hold || 0) + 120000)
      .catch(e => ({ case: n, ok: false, why: e.message }));
    console.log('ANCHOR98 ' + JSON.stringify(r));
    if (!r.ok) failed++; if (r.missing) missing++;
  }
  c.close();
  process.exitCode = missing === names.length ? 2 : failed;
}
