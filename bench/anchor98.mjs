#!/usr/bin/env node
// Windows 98 Setup's later rungs (bench/win98-setup.md), each lived again from a moment anchored on this computer
// (braid.anchor) instead of from the CD: the line travels to the anchor and the rung's event is waited for (SCRIPTING.md
// `next`), with the machine's faults and the line's broken verdicts as failures. Minutes, where the whole ladder is an
// hour.
//
//   node bench/anchor98.mjs [endpoint] [case ...]     endpoint: a DevTools address (default http://127.0.0.1:9334)
//   node bench/anchor98.mjs --list
//
// Anchors live in the page's origin (IndexedDB), so the endpoint's page must be the origin that anchored them. In a
// page with no DevTools endpoint: `(await import('/bench/anchor98.mjs')).pageCheck('restart')`. Each case prints one
// line, `ANCHOR98 {json}`; the exit code is the number of cases that failed (2 when the page has none of the anchors).
import { connect, SHELL_READY } from './runner.mjs';

/** the rungs: the anchor to start from and the event that says the rung is climbed. `test` is a predicate's source,
 *  evaluated in the page on each event of `type` */
export const CASES = {
  // ExitWindows from Setup's "Restarting your computer": USER's 3Bh ends every other process's tasks and returns;
  // the machine leaves the desktop for the PC's boot (sysPid, tests/w98fixes.test.mjs 1)
  restart: { anchor: 'exitwin-stuck', type: 'screen', test: 'e => e.screen !== "desktop"', ms: 10 * 60000, rung: 6 },
  // the PC's boot of what Setup copied: Windows 98's IO.SYS draws its own logo (v86.js VGA), not the bundle's
  logo: { anchor: 'w98-reboot', type: 'screen', test: 'e => e.screen === "logow" || e.screen === "logos"', ms: 10 * 60000, rung: 7 },
  // the first boot's start-up: Setup's first-start items under RUNONCE (Windows 98's, from SYSTEM), titled as 98's
  firstboot: { anchor: 'w98-reboot', type: 'window.open', test: 'e => /^Windows 98 Setup$/.test(e.title)', ms: 30 * 60000, rung: 8 },
  // the first boot ends at Windows 98's desktop: Explorer's tray
  desktop: { anchor: 'w98-firstboot', type: 'window.open', test: 'e => e.class === "Shell_TrayWnd" || /^Program Manager$/.test(e.title)', ms: 30 * 60000, rung: 9 },
};

/** runs in the page: one case. Resolves with { case, anchor, ok, why, ms, event, faults } */
export const pageCheck = async (name, cases = CASES) => {
  const c = cases[name]; if (!c) throw new Error(`no case ${name}: ${Object.keys(cases).join(', ')}`);
  const B = win95.braid, t0 = performance.now(), out = { case: name, anchor: c.anchor, rung: c.rung };
  const have = (await B.moments()).some(m => m.name === c.anchor);
  if (!have) return { ...out, ok: false, missing: true, why: `no moment ${c.anchor} in this origin` };
  const offs = []; let failed = null; const fail = why => { if (!failed) failed = why; };
  offs.push(win95.on('braid.fault', e => fail(`fault: ${JSON.stringify(e.fault || e).slice(0, 300)}`)));
  offs.push(win95.on('braid.broken', e => fail(`broken: ${JSON.stringify(e.findings || e).slice(0, 300)}`)));
  try {
    const test = (0, eval)(`(${c.test})`);
    const reached = win95.next(c.type, test, c.ms);
    await B.travel(c.anchor, { force: true });
    const ev = await Promise.race([reached, new Promise((_, no) => { const iv = setInterval(() => { if (failed) { clearInterval(iv); no(new Error(failed)); } }, 250); reached.finally(() => clearInterval(iv)); })]);
    return { ...out, ok: true, ms: Math.round(performance.now() - t0), event: ev };
  } catch (e) {
    const faults = win95.sysApp ? await Promise.race([win95.sysApp.cmd('faults'), new Promise(r => setTimeout(r, 8000, null))]) : null;
    return { ...out, ok: false, ms: Math.round(performance.now() - t0), why: failed || e.message, faults: (faults || []).filter(f => f.thread !== 'host') };
  } finally { offs.forEach(f => f()); }
};

if (typeof process === 'object' && import.meta.url === `file://${process.argv[1]}`) {   // (imported by a page too)
  const args = process.argv.slice(2);
  if (args[0] === '--list') { for (const [k, v] of Object.entries(CASES)) console.log(`${k}\trung ${v.rung}\tfrom ${v.anchor}\tuntil ${v.type} ${v.test}`); process.exit(0); }
  const endpoint = args[0] && /^https?:/.test(args[0]) ? args.shift() : 'http://127.0.0.1:9334';
  const names = args.length ? args : Object.keys(CASES);
  const c = await connect(endpoint);
  for (let i = 0; i < 300 && !(await c.evaluate(SHELL_READY).catch(() => false)); i++) await new Promise(r => setTimeout(r, 1000));
  let failed = 0, missing = 0;
  for (const n of names) {
    const r = await c.evaluate(`(${pageCheck})(${JSON.stringify(n)}, ${JSON.stringify(CASES)})`, CASES[n].ms + 120000)
      .catch(e => ({ case: n, ok: false, why: e.message }));
    console.log('ANCHOR98 ' + JSON.stringify(r));
    if (!r.ok) failed++; if (r.missing) missing++;
  }
  c.close();
  process.exitCode = missing === names.length ? 2 : failed;
}
