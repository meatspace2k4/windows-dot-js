#!/usr/bin/env node
// Drives everything a person can reach in the shell, through the element tree, and lists what did nothing or went
// wrong: menu items and buttons with no action, keys nothing took, error and warning boxes, page exceptions,
// guest programs that failed. Items that would change or destroy data are not pressed (see SKIP).
//
//   node bench/crawl.mjs [endpoint]      default http://127.0.0.1:9334
import { connect } from './runner.mjs';

const endpoint = process.argv[2] || 'http://127.0.0.1:9334';

// runs in the page
const CRAWL = async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // never pressed: they change files, settings or the session
  const SKIP = /^(Shut Down\.\.\.|Delete|Empty Recycle Bin|Format\.\.\.|Rename|Cut|Paste( Shortcut)?|Undo.*|Restore|New|Exit|Close|OK|Cancel|Yes|No|Apply|Remove.*|Clear|Save|Save As\.\.\.|Open\.\.\.|Print|Page Setup\.\.\.|Create Shortcut|Sharing\.\.\.|Minimize All Windows|Cascade|Tile .*|Line up Icons|by .*|Select All|Time\/Date|Word Wrap|Copy|Send To|Disconnect)$/;
  const found = [];
  let where = '';
  const off = win95.on('*', e => {
    if (e.type === 'menu.noop') found.push({ where, kind: 'menu item does nothing', what: e.label });
    else if (e.type === 'button.noop') found.push({ where, kind: 'button does nothing', what: e.label });
    else if (e.type === 'program.exit' && e.why) found.push({ where, kind: 'program failed', what: `${e.path}: ${e.why}` });
    else if (e.type === 'window.open' && e.message && /error|warning/.test(e.message.type || '')) found.push({ where, kind: `${e.message.type} box`, what: `${e.title}: ${e.message.text.replace(/\s+/g, ' ')}` });
  });
  const onErr = ev => found.push({ where, kind: 'exception', what: String(ev.error || ev.message) });
  window.addEventListener('error', onErr);
  const reset = async () => {
    win95.stopSaver();
    for (let k = 0; k < 30 && (win95.menus().length || win95.windows().length); k++) {
      if (win95.menus().length) { win95.key('esc'); continue; }
      const w = win95.windows().at(-1);
      if (w.modal && w.message) { win95.key('esc'); if (win95.windows().at(-1)?.title === w.title) win95.key('enter'); }
      else if (w.modal && /^Notepad$/.test(w.title)) win95.key('alt+n');
      else win95.close(w.title);
      await frame();
    }
    await frame();
  };
  const opened = [];
  const disabled = new Map();   // name -> where, for items and buttons that cannot be used
  const leafs = (items, path) => {
    for (const e of items) if (e.disabled) disabled.set(`${path} > ${e.name}`, e.role);
    return items.filter(e => !e.disabled && !SKIP.test(e.name));
  };
  // presses every item of the menu `open()` brings up, depth first; `path` names it for the report
  const crawlMenu = async (path, open, depth = 0) => {
    await reset(); await open(); await frame();
    const top = win95.elements({ window: 'Menu', depth });
    for (const it of leafs(top, path)) {
      await reset(); await open(); await frame();
      const e = win95.find({ window: 'Menu', depth, name: it.name }); if (!e) continue;
      where = `${path} > ${it.name}`;
      if (it.submenu) { await crawlMenu(where, async () => { await open(); await frame(); win95.click(win95.find({ window: 'Menu', depth, name: it.name })); await sleep(450); }, depth + 1); continue; }
      const before = new Set(win95.windows().map(w => w.title));
      win95.click(e); await sleep(250); await frame();
      for (const w of win95.windows()) if (!before.has(w.title)) opened.push({ from: where, title: w.title });
      if (win95.saverStats()) win95.stopSaver();
    }
  };
  const s = win95.screen();
  await crawlMenu('Start', async () => win95.click({ role: 'pushbutton', name: 'Start' }));
  await crawlMenu('Desktop menu', async () => win95.click(s.width - 30, s.taskbar - 30, { button: 'right' }));
  await crawlMenu('Taskbar menu', async () => win95.click(s.width >> 1, s.taskbar + 15, { button: 'right' }));
  // each desktop icon: open it, then every menu bar menu of its window, then its item menus
  await reset();
  for (const icon of win95.elements({ role: 'listitem', window: 'Desktop' })) {
    await crawlMenu(`Desktop icon ${icon.name} (right-click)`, async () => win95.click(win95.find({ role: 'listitem', window: 'Desktop', name: icon.name }), { button: 'right' }));
    await reset();
    where = `open ${icon.name}`; win95.dblclick(win95.find({ role: 'listitem', window: 'Desktop', name: icon.name })); await sleep(200);
    const w = win95.windows().at(-1); if (!w) continue;
    for (const bar of win95.elements({ window: w.title, menubar: true })) {
      await crawlMenu(`${w.title} > ${bar.name}`, async () => {
        if (!win95.window(w.title)) { win95.dblclick(win95.find({ role: 'listitem', window: 'Desktop', name: icon.name })); await sleep(200); }
        win95.click(win95.find({ window: w.title, menubar: true, name: bar.name }));
      });
    }
  }
  // every button and every menu bar menu in every window the crawl opened, each in a fresh copy of that window
  const seenWin = new Set();
  for (const o of opened) {
    if (seenWin.has(o.title)) continue; seenWin.add(o.title);
    await reset();
    const reopen = async () => {
      const [first, ...rest] = o.from.split(' > ');
      if (first === 'Start') win95.click({ role: 'pushbutton', name: 'Start' });
      else if (first === 'Desktop menu') win95.click(s.width - 30, s.taskbar - 30, { button: 'right' });
      else if (first === 'Taskbar menu') win95.click(s.width >> 1, s.taskbar + 15, { button: 'right' });
      else return false;
      for (const [d, name] of rest.entries()) { await frame(); const e = win95.find({ window: 'Menu', depth: d, name }); if (!e) return false; win95.click(e); await sleep(e.submenu ? 450 : 250); }
      return !!win95.window(o.title);
    };
    if (!await reopen()) continue;
    // controls nobody can use here: disabled ones, and read-only fields with no list to pick from
    for (const e of win95.elements({ window: o.title })) {
      if (e.disabled && e.role !== 'menuitem') disabled.set(`${o.title} > ${e.role} ${e.name || '(unnamed)'}`, e.role);
      if (e.role === 'text-edit' && e.readonly) disabled.set(`${o.title} > read-only field showing "${e.value}"`, e.role);
    }
    for (const bar of win95.elements({ window: o.title, menubar: true })) {
      await crawlMenu(`${o.title} > ${bar.name}`, async () => { if (!win95.window(o.title)) await reopen(); win95.click(win95.find({ window: o.title, menubar: true, name: bar.name })); });
    }
    await reset(); if (!await reopen()) continue;
    for (const tab of win95.elements({ window: o.title, role: 'pagetab' })) {
      win95.click(win95.find({ window: o.title, role: 'pagetab', name: tab.name })); await frame();
      for (const e of win95.elements({ window: o.title })) {
        if (e.disabled && e.role !== 'menuitem') disabled.set(`${o.title} > ${tab.name} > ${e.role} ${e.name || '(unnamed)'}`, e.role);
        if (e.role === 'text-edit' && e.readonly) disabled.set(`${o.title} > ${tab.name} > read-only field showing "${e.value}"`, e.role);
      }
    }
    for (const b of leafs(win95.elements({ role: 'pushbutton', window: o.title }), o.title).filter(b => !b.covered && !/^(Close|Minimize|Maximize)$/.test(b.name))) {
      await reset(); if (!await reopen()) break;
      where = `${o.title} > button ${b.name}`;
      const e = win95.find({ role: 'pushbutton', window: o.title, name: b.name }); if (!e) continue;
      win95.click(e); await sleep(250);
      if (win95.saverStats()) win95.stopSaver();
    }
  }
  await reset();
  off(); window.removeEventListener('error', onErr);
  return { found, opened, disabled: [...disabled.keys()] };
};

const c = await connect(endpoint);
const r = await c.evaluate(`(${CRAWL.toString()})()`, 900000);
c.close();
const groups = new Map();
for (const f of r.found) { const k = `${f.kind}\u0000${f.what}`; const g = groups.get(k) || { ...f, at: [] }; g.at.push(f.where); groups.set(k, g); }
console.log(`windows reached: ${[...new Set(r.opened.map(o => o.title))].join(', ')}\n`);
if (!groups.size) console.log('nothing went wrong');
for (const g of groups.values()) console.log(`${g.kind}: ${g.what}\n    at ${[...new Set(g.at)].join('\n    at ')}`);
console.log(`\ndisabled (not pressed):\n    ${r.disabled.sort().join('\n    ')}`);
