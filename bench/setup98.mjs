#!/usr/bin/env node
// Drives Windows 98 Setup from its CD in the running Windows 95 (bench/win98-setup.md), through the shell's API
// (SCRIPTING.md): each step waits for the control the next page brings (`waitFor`, `next('window.open')`) and presses
// it (`click`, which waits for the element itself), with no polling of the controls in between. Ring α (braid) runs
// under it: the line marks itself as Setup runs and a moment is marked before each step; a fault dialog (EXPLORER,
// SUWIN, W98SETUP, MSGSRV32) or a broken verdict from the lint is a state captured on the line (`fault<n>`), then
// travelled back from (the last moment the lint passed) and the step lived again, the fork recorded; the same fault
// met again on the new generation (braid.same) ends the run, reproduced. A step already lived from the same moment
// with the same presses (the key's check, a page's Next) is memo'd past, its work not done again.
//
//   W98KEY=XXXXX-XXXXX-XXXXX-XXXXX-XXXXX node bench/setup98.mjs [endpoint]
//
// The product key comes from the environment and goes to the page as a value; it is written nowhere, and the keys
// typed are hushed from the line's journal. `endpoint` is a DevTools address (the app's http://127.0.0.1:9334). In a
// page served by tools/serve.py with no endpoint, `pageDrive(null)` fetches the key from the server's /__w98key (the
// server's environment, 127.0.0.1 only): `(await import('/bench/setup98.mjs')).pageDrive(null, {})`.
import { connect, SHELL_READY } from './runner.mjs';

/** runs in the page: the ladder, as far as it goes; resolves with the log of what was pressed and what stopped it,
 *  the faults met, the forks made, and the line */
export const pageDrive = async (key, o = {}) => {
  const log = [], lg = s => { log.push(`${new Date().toLocaleTimeString()} ${s}`); win95.note(s); };
  const MIN = 60000, sleep = ms => new Promise(r => setTimeout(r, ms));
  const B = win95.braid;
  // (no key anywhere and o.keyless: the ladder stops at the Product Key page for a person to type it, and goes on from
  // there when run again with { from: 'wizard' })
  if (!key) { key = await fetch('/__w98key', { cache: 'no-store' }).then(r => (r.ok ? r.text() : ''), () => ''); if (!key && !o.keyless) throw new Error('no product key: W98KEY in the server\'s environment, or passed in'); }
  let fault = null, nf = 0, lastFault = null, atKey = false; const forks = [], faults = [];
  // (the line marking itself every o.every ms (30 s), the last four held; o.every 0 leaves it to the steps' moments)
  if (o.every !== 0) B.every(o.every || 30000, 4);
  const mark = async name => { try { const r = await B.mark(name); lg(`moment ${name} (${r.verdict})`); return r; } catch (e) { lg(`moment ${name} failed: ${e.message}`); return null; } };
  // (a fault a machine reports is an event on the line (braid.fault: the program, the exception, the machine's fault
  // log); the fault box the shell draws for it is not modal, so the event is what the driver goes by)
  const stopOnFault = win95.on('braid.fault', e => { if (!fault) { const f = e.fault || {}; fault = { title: `${f.program || e.machine}: ${f.why || 'fault'}`, fault: f, t: Date.now() }; lg(`FAULT ${fault.title} (generation ${e.gen})`); } });
  const onBroken = win95.on('braid.broken', e => { if (!fault) { fault = { title: 'lint: ' + e.moment, findings: e.findings, t: Date.now() }; lg(`BROKEN ${e.moment}: ${(e.findings || []).map(f => f.what).join('; ')}`); } });
  // (the uninstall-drive dialog comes as the pages run: pressed as it opens)
  const dialogs = win95.on('window.open', async e => {
    try {
      if (/Uninstall Drive/.test(e.title)) { await win95.click({ name: 'OK', window: /Uninstall Drive/ }); lg('Select Uninstall Drive: OK'); }
      // (the startup disk's own dialog, after its page: Setup asks for a disk in A: once its files are gathered; Cancel
      // skips the disk, as the page's Cancel did)
      if (/^Insert Disk$/.test(e.title)) { await win95.click({ name: 'Cancel', window: 'Insert Disk' }); lg('Insert Disk: Cancel (no startup disk)'); }
    }
    catch (err) { lg('dialog ' + e.title + ': ' + err.message); }
  });
  /** a fault met: the broken state marked on the line, then travel back to the last moment the lint passed, the fork
   *  recorded; false when the same fault was met before on the lineage (reproduced: the run ends there) */
  const recover = async () => {
    const f = fault; fault = null;
    const broken = await mark(`fault${++nf}`);
    const line = B.line, ev = line.events.length - 1, rec = { ...f, moment: broken && broken.name, gen: line.gen, event: ev >= 0 ? ev : null };
    faults.push(rec);
    if (o.stop) { lg(`stopped at the fault (${f.title}), on the line as ${rec.moment}`); return false; }   // (o.stop: the fault marked, the machine left as it is, for a person to look at)
    if (lastFault !== null && ev >= 0 && B.same(lastFault, ev).same) { lg(`the same fault again (${f.title}) on generation ${line.gen}: reproduced from ${forks[forks.length - 1].from}`); rec.reproduced = true; return false; }
    if (ev >= 0) lastFault = ev;
    const good = B.along().filter(m => m.verdict !== 'broken' && m.name !== rec.moment && !/^fault/.test(m.name)).pop();
    if (!good) { lg('no moment to travel back to'); return false; }
    const r = await B.travel(good.name); lg(`travelled back to ${good.name} (generation ${r.gen}); ${f.title} is on the line as ${rec.moment}`);
    forks.push({ from: good.name, gen: r.gen, fault: f.title, broken: rec.moment });
    return true;
  };
  /** a step: a span already lived from this moment is memo'd past, else lived (fn) */
  const step = async (actions, fn) => { const m = await B.memo(actions); if (m) { lg(`memo: ${m.from} to ${m.to}, ${Math.round(m.ms / 1000)} s of the machine's time not run again`); return m; } return fn(); };
  const WIZ = /^Windows 98 Setup( Wizard)?$/;   // (the license and the key are the Wizard's pages, under either title)
  const el = (name, window) => ({ name, role: 'pushbutton', window: window instanceof RegExp ? String(window) : window });
  try {
    if (o.from) lg(`from the ${o.from} on`);   // (Setup already past its first dialog ('license'), or past the key ('wizard'): the ladder from there)
    else {
      win95.cd.insert('Windows 98 se Upgrade.iso'); lg('CD inserted');
      // (the question may be up before a listener is: waited for as a control; a CD already in, which asks nothing, has
      // its Setup run by name)
      if (await win95.waitFor({ name: 'Yes', window: /Windows 98 CD-ROM/ }, 30000).then(() => true, () => false)) { await win95.click({ name: 'Yes', window: /Windows 98 CD-ROM/ }); lg('AutoRun: Yes'); }
      else { win95.run('D:\\SETUP.EXE'); lg('D:\\SETUP.EXE run'); }
      await win95.waitFor({ role: 'pushbutton', name: 'Continue', window: 'Windows 98 Setup' }, 5 * MIN);
      await mark('setup');
      // (the element itself: three windows carry Setup's title, and the full-screen one is taken for covering the dialog's button)
      await win95.click((await win95.elementsNow()).find(e => e.role === 'pushbutton' && e.name === 'Continue' && e.window === 'Windows 98 Setup')); lg('Continue');
    }
    // (ScanDisk's VM, then the Wizard's preparation: minutes)
    if (o.from !== 'wizard') {
      await win95.waitFor({ name: 'I accept the Agreement', window: WIZ }, 15 * MIN);
      await mark('license');
      // (the key's check, about 70 s of the machine's time: lived once from this moment, then memo'd past)
      await step([['click', { name: 'I accept the Agreement', window: String(WIZ) }], ['click', el('Next >', WIZ)], ['click', el('Next >', WIZ)]], async () => {
        await win95.click({ name: 'I accept the Agreement', window: WIZ }); lg('License: accepted');
        await win95.click({ name: 'Next >', window: WIZ }); lg('Next');
        const edit = await win95.waitFor({ role: 'text-edit', window: WIZ }, 2 * MIN);
        if (!key) { const stop = new Error('at the Product Key page: type the key, then run again with { from: \'wizard\' }'); stop.atKey = true; throw stop; }
        // (the key: a character at a time, with time for USER to take each (typed as a string, one came twice and the
        // key's boxes ended shifted), each box read back and typed again where it differs; hushed from the journal, so
        // the key is on no line and in no anchored moment; the click on the edit is hushed with it, so the span's
        // actions are the same whatever box took the focus)
        await B.hush(async () => {
          await win95.click(edit); await sleep(300);
          const groups = String(key).split('-'), boxesNow = async () => (await win95.elementsNow()).filter(e => e.role === 'text-edit' && WIZ.test(e.window));
          for (const g of groups) for (const ch of g) { win95.type(ch); await sleep(150); }
          for (let pass = 0; pass < 3; pass++) {
            const boxes = await boxesNow(); if (boxes.length === groups.length && boxes.every((b, i) => String(b.name) === groups[i])) break;
            for (let i = 0; i < groups.length && i < boxes.length; i++) {
              if (String(boxes[i].name) === groups[i]) continue;
              await win95.click(boxes[i]); await sleep(400); win95.key('End'); await sleep(150); for (let k = 0; k < 6; k++) { win95.key('Backspace'); await sleep(120); }
              for (const ch of groups[i]) { win95.type(ch); await sleep(250); } await sleep(500);
            }
          }
        });
        lg('Product Key typed');
        await win95.click({ name: 'Next >', window: WIZ }); lg('Next (the key\'s check)');
      });
    }
    // the Wizard's pages, each with a Next of its own: the directory, Save System Files, Setup Options, the user's
    // name, components, identification, settings, the startup disk (declined), then the copy
    // (a page is pressed once, when its Next (or Finish, or OK) is enabled and the page is not the one pressed last:
    // Setup's checks run with Next greyed for minutes, and some pages are dialogs of their own (Identification))
    const PAGES = /Setup Wizard|Identification|Setup Options|User Information|Components|Location|Startup Disk|Start Copying|Computer Settings|Network/;
    const page = () => {
      const w = win95.windows().find(x => PAGES.test(x.title) && x.title !== 'Windows 98 Setup'); if (!w) return null;
      const els = win95.elements().filter(e => e.window === w.title), btn = els.find(e => e.role === 'pushbutton' && /^(Next >|Finish|OK)$/.test(e.name) && !e.disabled);
      return { title: w.title, text: els.filter(e => e.role === 'text').map(e => String(e.name)).join(' '), btn, cancel: els.find(e => e.role === 'pushbutton' && e.name === 'Cancel') };
    };
    let last = '', done = false;
    for (let i = 0; i < 60 && !done; i++) {
      let pg = null; const t0 = Date.now();
      while (!fault && Date.now() - t0 < 30 * MIN) { await sleep(1500); pg = page(); if (pg && pg.btn && pg.title + '|' + pg.text.slice(0, 40) !== last) break; pg = null; }
      if (fault) { if (await recover()) { last = ''; continue; } break; }
      if (!pg) break;
      last = pg.title + '|' + pg.text.slice(0, 40);
      if (o.until && o.until.test(pg.title + ' ' + pg.text)) { lg(`at ${pg.title} :: ${pg.text.slice(0, 60)} (until)`); break; }   // (o.until: the ladder stops at the page, unpressed)
      const name = 'page' + i + ':' + (pg.title + ' ' + pg.text).slice(0, 28).replace(/\W+/g, '-');
      if (!B.along().some(m => m.name === name)) await mark(name);
      // (the Startup Disk page takes Next: its Cancel asks whether to quit Setup; the disk itself is declined at its
      // Insert Disk dialog, Cancel, above)
      const btn = pg.btn;
      // (a page that went before its button was pressed (the Identification dialog Setup shows and takes down itself):
      // the ladder looks for the next page, the press not made)
      try { await step([['click', { name: btn.name, role: btn.role, window: btn.window }]], async () => { await win95.click(btn); lg(`${btn.name} on ${pg.title} :: ${pg.text.slice(0, 60)}`); }); }
      catch (e) { if (!/no element matches/.test(e.message)) throw e; lg(`${pg.title} went before its ${btn.name} was pressed`); last = ''; continue; }
      if (btn.name === 'Finish') done = true;
    }
    if (fault) await recover();
    if (done) lg('ladder done: the copy and the restart are the machine\'s now');
  } catch (e) { if (e.atKey) { atKey = true; lg(e.message); } else lg('stopped: ' + e.message); }
  finally { stopOnFault(); onBroken(); dialogs(); }
  const machineFaults = win95.sysApp ? await Promise.race([win95.sysApp.cmd('faults'), sleep(8000).then(() => null)]) : null;
  return { log, atKey, fault: faults.length ? faults[faults.length - 1].title : null, faults, forks, machineFaults: (machineFaults || []).filter(f => f.thread !== 'host'), line: B.line };
};

if (typeof process === 'object' && import.meta.url === `file://${process.argv[1]}`) {   // (imported by a page too)
  const key = process.env.W98KEY; if (!key) { console.error('W98KEY is not set'); process.exit(2); }
  const c = await connect(process.argv[2] || 'http://127.0.0.1:9334');
  for (let i = 0; i < 300 && !(await c.evaluate(SHELL_READY).catch(() => false)); i++) await new Promise(r => setTimeout(r, 1000));
  const r = await c.evaluate(`(${pageDrive})(${JSON.stringify(key)})`, 90 * 60000);
  for (const l of r.log) console.log(l);
  if (r.faults.length) { console.log('faults:', JSON.stringify(r.faults, null, 1)); console.log('forks:', JSON.stringify(r.forks, null, 1)); }
  // (one line a check runner keeps as the run's record: the ladder finished or not, the last thing it logged, the faults)
  const done = r.log.some(l => /ladder done/.test(l));
  console.log('SETUP98 ' + JSON.stringify({ done, atKey: r.atKey, last: r.log[r.log.length - 1] || null, fault: r.fault, faults: r.faults.length, forks: r.forks.length,
    machineFaults: r.machineFaults.length }));
  process.exitCode = done && !r.faults.length && !r.machineFaults.length ? 0 : 1;
  c.close();
}
