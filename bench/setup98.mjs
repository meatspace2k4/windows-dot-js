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
export const pageDrive = async key => {
  const log = [], lg = s => { log.push(`${new Date().toLocaleTimeString()} ${s}`); win95.note(s); };
  const MIN = 60000, sleep = ms => new Promise(r => setTimeout(r, ms));
  let fault = null;
  const stopOnFault = win95.on('window.open', e => { if (/^(EXPLORER|SUWIN|W98SETUP|MSGSRV32)/.test(e.title) && e.modal) { fault = e.title; lg('FAULT dialog ' + e.title); } });
  // (the uninstall-drive and startup-disk dialogs come as the pages run: pressed as they open)
  const dialogs = win95.on('window.open', async e => {
    try {
      if (/Uninstall Drive/.test(e.title)) { await win95.click({ name: 'OK', window: /Uninstall Drive/ }); lg('Select Uninstall Drive: OK'); }
    } catch (err) { lg('dialog ' + e.title + ': ' + err.message); }
  });
  const texts = win => win95.elements().filter(e => e.role === 'statictext' && e.window === win).map(e => String(e.name)).join(' | ');
  try {
    win95.cd.insert('Windows 98 se Upgrade.iso'); lg('CD inserted');
    await win95.next('window.open', e => /Windows 98 CD-ROM/.test(e.title) && e.modal, 2 * MIN);
    await win95.click({ name: 'Yes', window: /Windows 98 CD-ROM/ }); lg('AutoRun: Yes');
    await win95.waitFor({ role: 'pushbutton', name: 'Continue', window: 'Windows 98 Setup' }, 5 * MIN);
    await win95.click({ name: 'Continue', window: 'Windows 98 Setup' }); lg('Continue');
    // (ScanDisk's VM, then the Wizard's preparation: minutes)
    await win95.waitFor({ name: 'I accept the Agreement', window: 'Windows 98 Setup' }, 15 * MIN);
    await win95.click({ name: 'I accept the Agreement', window: 'Windows 98 Setup' }); lg('License: accepted');
    await win95.click({ name: 'Next >', window: 'Windows 98 Setup' }); lg('Next');
    const edit = await win95.waitFor({ role: 'text-edit', window: 'Windows 98 Setup' }, 2 * MIN);
    await win95.click(edit); await sleep(300);
    for (const g of String(key).split('-')) { await win95.type(g); await sleep(300); }
    lg('Product Key typed');
    await win95.click({ name: 'Next >', window: 'Windows 98 Setup' }); lg('Next (the key\'s check)');
    // the Wizard's pages, each with a Next of its own: the directory, Save System Files, Setup Options, the user's
    // name, components, identification, settings, the startup disk (declined), then the copy
    for (let i = 0; i < 12 && !fault; i++) {
      const b = await win95.waitFor({ role: 'pushbutton', name: /^(Next >|Finish)$/, window: 'Windows 98 Setup Wizard' }, 30 * MIN);
      if (fault) break;
      const t = texts('Windows 98 Setup Wizard');
      if (/startup disk/i.test(t)) { await win95.click({ name: 'Cancel', window: 'Windows 98 Setup Wizard' }); lg('Startup Disk: Cancel'); }
      else if (b.name === 'Finish') { await win95.click({ name: 'Finish', window: 'Windows 98 Setup Wizard' }); lg('Finish'); break; }
      else { await win95.click({ name: 'Next >', window: 'Windows 98 Setup Wizard' }); lg('Next :: ' + t.slice(0, 100)); }
      await sleep(4000);   // (the page turns before its Next is looked for again)
    }
    if (!fault) lg('ladder done: the copy and the restart are the machine\'s now');
  } catch (e) { lg('stopped: ' + e.message); }
  finally { stopOnFault(); dialogs(); }
  const faults = win95.sysApp ? await Promise.race([win95.sysApp.cmd('faults'), sleep(8000).then(() => null)]) : null;
  return { log, fault, faults: (faults || []).filter(f => f.thread !== 'host') };
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
