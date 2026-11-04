#!/usr/bin/env node
// Drives Windows 98 Setup from its CD in the running Windows 95 (bench/win98-setup.md), through the shell's API
// (SCRIPTING.md): each step waits for the control the next page brings (`waitFor`, `next('window.open')`) and presses
// it (`click`, which waits for the element itself), with no polling of the controls in between. A fault dialog
// (EXPLORER, SUWIN, MSGSRV32) ends the run and is reported with the machine's fault record.
//
//   W98KEY=XXXXX-XXXXX-XXXXX-XXXXX-XXXXX node bench/setup98.mjs [endpoint]
//
// The product key comes from the environment and goes to the page as a value; it is written nowhere. `endpoint` is a
// DevTools address (the app's http://127.0.0.1:9334). In a browser pane with no endpoint, `pageDrive` is the code to
// evaluate in the page: `(${pageDrive})(key)`, its promise the run's log.
import { connect, SHELL_READY } from './runner.mjs';

/** runs in the page: the ladder, as far as it goes; resolves with the log of what was pressed and what stopped it */
export const pageDrive = async (key, o = {}) => {
  const log = [], lg = s => { log.push(`${new Date().toLocaleTimeString()} ${s}`); win95.note(s); };
  const MIN = 60000, sleep = ms => new Promise(r => setTimeout(r, ms));
  let fault = null;
  // (o.mark: a moment of everything before each step, ring α (braid.js), the last `o.keep` (2) kept: a fault is
  // rewound from, the step run again under code changed meanwhile)
  const marks = [], mark = async name => { if (!o.mark) return; try { await win95.braid.mark(name); marks.push(name); lg('moment ' + name); while (marks.length > (o.keep || 2)) win95.braid.forget(marks.shift()); } catch (e) { lg('moment ' + name + ' failed: ' + e.message); } };
  const stopOnFault = win95.on('window.open', e => { if (/^(EXPLORER|SUWIN|W98SETUP|MSGSRV32)/.test(e.title) && e.modal) { fault = e.title; lg('FAULT dialog ' + e.title); } });
  // (the uninstall-drive and startup-disk dialogs come as the pages run: pressed as they open)
  const dialogs = win95.on('window.open', async e => {
    try {
      if (/Uninstall Drive/.test(e.title)) { await win95.click({ name: 'OK', window: /Uninstall Drive/ }); lg('Select Uninstall Drive: OK'); }
    } catch (err) { lg('dialog ' + e.title + ': ' + err.message); }
  });
  const texts = win => win95.elements().filter(e => e.role === 'statictext' && e.window === win).map(e => String(e.name)).join(' | ');
  try {
    if (o.from) lg(`from the ${o.from} on`);   // (Setup already past its first dialog ('license'), or past the key ('wizard'): the ladder from there)
    else {
    win95.cd.insert('Windows 98 se Upgrade.iso'); lg('CD inserted');
    // (the question may be up before a listener is: waited for as a control; a CD already in, which asks nothing, has
    // its Setup run by name)
    if (await win95.waitFor({ name: 'Yes', window: /Windows 98 CD-ROM/ }, 30000).then(() => true, () => false)) { await win95.click({ name: 'Yes', window: /Windows 98 CD-ROM/ }); lg('AutoRun: Yes'); }
    else { win95.run('D:\\SETUP.EXE'); lg('D:\\SETUP.EXE run'); }
    await win95.waitFor({ role: 'pushbutton', name: 'Continue', window: 'Windows 98 Setup' }, 5 * MIN);
    // (the element itself: three windows carry Setup's title, and the full-screen one is taken for covering the dialog's button)
    await win95.click((await win95.elementsNow()).find(e => e.role === 'pushbutton' && e.name === 'Continue' && e.window === 'Windows 98 Setup')); lg('Continue');
    }
    // (ScanDisk's VM, then the Wizard's preparation: minutes)
    const WIZ = /^Windows 98 Setup( Wizard)?$/;   // (the license and the key are the Wizard's pages, under either title)
    if (o.from !== 'wizard') {
    await win95.waitFor({ name: 'I accept the Agreement', window: WIZ }, 15 * MIN);
    await mark('license');
    await win95.click({ name: 'I accept the Agreement', window: WIZ }); lg('License: accepted');
    await win95.click({ name: 'Next >', window: WIZ }); lg('Next');
    const edit = await win95.waitFor({ role: 'text-edit', window: WIZ }, 2 * MIN);
    await win95.click(edit); await sleep(300);
    // (a character at a time, with time for USER to take each: typed as a string, one came twice and the key's boxes
    // ended shifted; each box read back and typed again where it differs; the key stays in the page's memory)
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
    lg('Product Key typed');
    await win95.click({ name: 'Next >', window: WIZ }); lg('Next (the key\'s check)');
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
    let last = '';
    for (let i = 0; i < 40 && !fault; i++) {
      let pg = null; const t0 = Date.now();
      while (!fault && Date.now() - t0 < 30 * MIN) { await sleep(1500); pg = page(); if (pg && pg.btn && pg.title + '|' + pg.text.slice(0, 40) !== last) break; pg = null; }
      if (fault || !pg) break;
      last = pg.title + '|' + pg.text.slice(0, 40);
      await mark('page' + i + ':' + (pg.title + ' ' + pg.text).slice(0, 28).replace(/\W+/g, '-'));
      const startup = /startup disk/i.test(pg.text) && pg.cancel, btn = startup ? pg.cancel : pg.btn;
      await win95.click(btn); lg(`${btn.name} on ${pg.title} :: ${pg.text.slice(0, 60)}`);
      if (btn.name === 'Finish') break;
    }
    if (!fault) lg('ladder done: the copy and the restart are the machine\'s now');
  } catch (e) { lg('stopped: ' + e.message); }
  finally { stopOnFault(); dialogs(); }
  const faults = win95.sysApp ? await Promise.race([win95.sysApp.cmd('faults'), sleep(8000).then(() => null)]) : null;
  return { log, fault, faults: (faults || []).filter(f => f.thread !== 'host'), moments: marks.slice() };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const key = process.env.W98KEY; if (!key) { console.error('W98KEY is not set'); process.exit(2); }
  const c = await connect(process.argv[2] || 'http://127.0.0.1:9334');
  for (let i = 0; i < 300 && !(await c.evaluate(SHELL_READY).catch(() => false)); i++) await new Promise(r => setTimeout(r, 1000));
  const r = await c.evaluate(`(${pageDrive})(${JSON.stringify(key)})`, 90 * 60000);
  for (const l of r.log) console.log(l);
  if (r.fault) { console.log('fault:', JSON.stringify(r.faults, null, 1)); process.exitCode = 1; }
  c.close();
}
