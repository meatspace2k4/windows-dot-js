#!/usr/bin/env node
// Drives Windows 95 OSR 2.5 Setup from its CD (D:\WIN95\SETUP.EXE) in the running Windows 95, through the shell's API
// (DRIVING-THE-MACHINE.md), as bench/setup98.mjs drives Windows 98's: each step waits for the control the next page
// brings and presses it, a Braid moment marked before each page; the side dialogs (Welcome, Select Uninstall Drive,
// Insert Disk) answered as they open; a fault a machine reports, an error dialog or a broken lint verdict is marked
// on the line (`fault<n>`) and travelled back from to the last moment the lint passed, the page lived again; the same
// fault met again ends the run, reproduced.
//
//   W95OEMKEY=12095-OEM-0004226-12233 node bench/setup95osr.mjs [debugger address]
//
// The certificate's number comes from the environment and goes to the page as a value; it is written nowhere, and
// its typing is hushed from the line's journal. The debugger address is a browser's remote debugging interface (the
// app's http://127.0.0.1:9334 when none is given). In a page served by tools/serve.py:
// `(await import('/bench/setup95osr.mjs')).pageDrive('12095-OEM-0004226-12233', {})`.
import { connect, SHELL_READY } from './runner.mjs';

/** runs in the page: Setup's pages, as far as they go; resolves with the log, the faults met, the forks made */
export const pageDrive = async (key, o = {}) => {
  const log = [], lg = s => { log.push(`${new Date().toLocaleTimeString()} ${s}`); win95.note(s); };
  const MIN = 60000, sleep = ms => new Promise(r => setTimeout(r, ms)), B = win95.braid;
  let fault = null, nf = 0, lastFault = null; const forks = [], faults = [];
  if (o.every !== 0) B.every(o.every || 30000, 4);
  const mark = async name => { try { const r = await B.mark(name); lg(`moment ${name} (${r.verdict})`); return r; } catch (e) { lg(`moment ${name} failed: ${e.message}`); return null; } };
  const stopOnFault = win95.on('braid.fault', e => { if (!fault) { const f = e.fault || {}; fault = { title: `${f.program || e.machine}: ${f.why || 'fault'}`, fault: f }; lg(`FAULT ${fault.title} (generation ${e.gen})`); } });
  const onBroken = win95.on('braid.broken', e => { if (!fault) { fault = { title: 'lint: ' + e.moment, findings: e.findings }; lg(`BROKEN ${e.moment}`); } });
  const dialogs = win95.on('window.open', async e => {
    try {
      if (/^Welcome$/.test(e.title)) { win95.close(/^Welcome$/); lg('Welcome closed'); }
      else if (/Uninstall Drive/.test(e.title)) { await win95.click({ name: 'OK', window: /Uninstall Drive/ }); lg('Select Uninstall Drive: OK'); }
      // (Setup's notice that it will ask for a device's model, and the Select Device page that asks: OK, its default)
      else if (e.title === 'Setup' && (await win95.elementsNow()).some(x => x.window === 'Setup' && /could not identify one or more devices/.test(String(x.name)))) { await win95.click({ name: 'OK', window: 'Setup' }); lg('Setup: OK (it asks for a model next)'); }
      else if (/^Select Device$/.test(e.title)) { await win95.click({ name: 'OK', window: 'Select Device' }); lg('Select Device: OK, its default'); }
      else if (/^Insert Disk$/.test(e.title)) { await win95.click({ name: 'Cancel', window: 'Insert Disk' }); lg('Insert Disk: Cancel (no startup disk)'); }
      else {
        const text = (await win95.elementsNow()).filter(x => x.window === e.title && x.role === 'text').map(x => String(x.name)).join(' ');
        if (!fault && /cannot|could not|error|not found|failed|invalid|not included/i.test(text)) { fault = { title: `${e.title}: ${text.slice(0, 200)}` }; lg(`DIALOG ${fault.title}`); }
      }
    } catch (err) { lg('dialog ' + e.title + ': ' + err.message); }
  });
  const recover = async () => {
    const f = fault; fault = null;
    const broken = await mark(`fault${++nf}`), line = B.line, ev = line.events.length - 1, rec = { ...f, moment: broken && broken.name, gen: line.gen };
    faults.push(rec);
    if (o.stop) { lg(`stopped at the fault (${f.title}), on the line as ${rec.moment}`); return false; }
    if (lastFault !== null && ev >= 0 && B.same(lastFault, ev).same) { lg(`the same fault again (${f.title}): reproduced from ${forks[forks.length - 1].from}`); rec.reproduced = true; return false; }
    if (ev >= 0) lastFault = ev;
    const good = B.along().filter(m => m.verdict !== 'broken' && m.name !== rec.moment && !/^fault/.test(m.name)).pop();
    if (!good) { lg('no moment to travel back to'); return false; }
    const r = await B.travel(good.name); lg(`travelled back to ${good.name} (generation ${r.gen})`);
    forks.push({ from: good.name, gen: r.gen, fault: f.title });
    return true;
  };
  const step = async (actions, fn) => { const m = await B.memo(actions); if (m) { lg(`memo: ${m.from} to ${m.to}`); return m; } return fn(); };
  // (Setup's windows: its full-screen backdrop and its dialogs share "Windows 95 Setup"; the Wizard's pages are under
  // "Windows 95 Setup Wizard" or the page's own title)
  const PAGES = /^Windows 95 Setup( Wizard)?$|^Software License Agreement$|^Setup Options$|^Certificate of Authenticity$|^Select Components$|^Network Configuration$|^Identification$|^Computer Settings$|^Startup Disk$|^Start Copying Files$|^Finishing Setup$/;
  // (Re-enter: the certificate's number refused, back to its boxes)
  const FORWARD = /^(Continue|Yes|Next >|Finish|OK|Restart Now|Re-enter)$/;
  const page = () => {
    const els = win95.elements();
    // (the page with an enabled forward button; the backdrop has none)
    for (const w of win95.windows().slice().reverse()) {
      if (!PAGES.test(w.title)) continue;
      const mine = els.filter(e => e.window === w.title), btn = mine.find(e => e.role === 'pushbutton' && FORWARD.test(e.name) && !e.disabled);
      if (btn) return { title: w.title, text: mine.filter(e => e.role === 'text').map(e => String(e.name)).join(' '), btn, edits: mine.filter(e => e.role === 'text-edit') };
    }
    return null;
  };
  // (the certificate's boxes, left to right as the page shows them: each clicked and its group typed a character at a
  // time, read back, typed again where it differs; hushed from the journal)
  const certificate = async title => B.hush(async () => {
    const groups = String(key).split('-').filter(g => !/^OEM$/i.test(g)), boxes = async () => (await win95.elementsNow()).filter(e => e.role === 'text-edit' && e.window === title).sort((a, b) => a.x - b.x);
    for (let pass = 0; pass < 3; pass++) {
      const b = await boxes(); if (b.length === groups.length && b.every((x, i) => String(x.name) === groups[i])) return true;
      for (let i = 0; i < groups.length && i < b.length; i++) {
        if (String(b[i].name) === groups[i]) continue;
        await win95.click(b[i]); await sleep(300); win95.key('end'); await sleep(100); for (let k = 0; k < 8; k++) { win95.key('backspace'); await sleep(80); }
        for (const ch of groups[i]) { win95.type(ch); await sleep(150); } await sleep(300);
      }
    }
    const b = await boxes(); return b.every((x, i) => String(x.name) === groups[i]);
  });
  try {
    if (win95.window(/^Welcome$/)) { win95.close(/^Welcome$/); lg('Welcome closed'); }
    // (Setup started by this run unless its first dialog is already up)
    if (!win95.elements().some(e => e.role === 'pushbutton' && e.name === 'Continue' && e.window === 'Windows 95 Setup')) { win95.run('D:\\WIN95\\SETUP.EXE'); lg('D:\\WIN95\\SETUP.EXE run'); }
    let last = '', done = false;
    for (let i = 0; i < 80 && !done; i++) {
      let pg = null; const t0 = Date.now();
      while (!fault && Date.now() - t0 < 30 * MIN) { await sleep(1000); pg = page(); if (pg && pg.title + '|' + pg.text.slice(0, 60) !== last) break; pg = null; }
      if (fault) { if (await recover()) { last = ''; continue; } break; }
      if (!pg) { lg('no page came'); break; }
      last = pg.title + '|' + pg.text.slice(0, 60);
      if (o.until && o.until.test(pg.title + ' ' + pg.text)) { lg(`at ${pg.title} :: ${pg.text.slice(0, 60)} (until)`); break; }
      const name = 'osr' + i + ':' + (pg.title + ' ' + pg.text).slice(0, 28).replace(/\W+/g, '-');
      if (!B.along().some(m => m.name === name)) await mark(name);
      if (/Certificate of Authenticity/.test(pg.text) && pg.edits.length === 3) {
        if (!key) { lg('at the certificate: no number given (W95OEMKEY)'); break; }
        if (!(await certificate(pg.title))) { lg('the certificate\'s boxes did not take the number'); break; }
        lg('certificate typed');
      }
      const btn = pg.btn;
      if (pg.title === 'Windows 95 Setup') win95.activate(pg.title);   // (the backdrop holds the activation over Setup's own dialogs)
      try { await step([['click', { name: btn.name, role: btn.role, window: btn.window }]], async () => { await win95.click(btn); lg(`${btn.name} on ${pg.title} :: ${pg.text.slice(0, 70)}`); }); }
      catch (e) { if (!/no element matches|is not pressed/.test(e.message)) throw e; lg(`${pg.title}: ${btn.name} not pressed (${e.message.slice(0, 80)})`); last = ''; continue; }
      if (btn.name === 'Finish' || btn.name === 'Restart Now') done = true;
    }
    if (fault) await recover();
    if (done) lg('ladder done: the copy and the restart are the machine\'s now');
  } catch (e) { lg('stopped: ' + e.message); }
  finally { stopOnFault(); onBroken(); dialogs(); }
  return { log, fault: faults.length ? faults[faults.length - 1].title : null, faults, forks };
};

if (typeof process === 'object' && import.meta.url === `file://${process.argv[1]}`) {
  const key = process.env.W95OEMKEY; if (!key) { console.error('W95OEMKEY is not set'); process.exit(2); }
  const c = await connect(process.argv[2] || 'http://127.0.0.1:9334');
  for (let i = 0; i < 300 && !(await c.evaluate(SHELL_READY).catch(() => false)); i++) await new Promise(r => setTimeout(r, 1000));
  const r = await c.evaluate(`(${pageDrive})(${JSON.stringify(key)}, { stop: ${!!process.env.W95STOP} })`, 90 * 60000);
  for (const l of r.log) console.log(l);
  if (r.faults.length) console.log('faults:', JSON.stringify(r.faults, null, 1));
  const done = r.log.some(l => /ladder done/.test(l));
  console.log('SETUP95OSR ' + JSON.stringify({ done, last: r.log[r.log.length - 1] || null, fault: r.fault, faults: r.faults.length, forks: r.forks.length }));
  process.exitCode = done && !r.faults.length ? 0 : 1;
  c.close();
}
