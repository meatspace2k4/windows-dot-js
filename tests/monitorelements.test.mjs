// The element tree once EXPLORER.EXE is the shell (the page is its monitor): the taskbar on screen is Explorer's
// (Shell_TrayWnd), so the elements list its Start button, its task buttons (the tab control's tabs, each named by the
// window it stands for) and its clock under the window name 'Taskbar', as the page's own taskbar is named when it is
// the one drawn; the page's taskbar, not drawn then, is not listed
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };

const nativeEls = new Function('label', cut('function nativeEls(', '\n}\n') + '\nreturn nativeEls;')(s => s.replace(/&/g, ''));
const r = (x, y, w, h) => ({ x, y, w, h });
const tray = [
  { cls: 'Button', text: 'Start', style: 0x50000000, ...r(2, 454, 54, 22), id: 0x130, hwnd: 388, enabled: true, focused: false },
  { cls: 'TrayNotifyWnd', text: '', style: 0, ...r(656, 454, 72, 22), id: 0, hwnd: 392, enabled: true, focused: false },
  { cls: 'TrayClockWClass', text: '8:31 PM', style: 0, ...r(670, 456, 54, 18), id: 0, hwnd: 396, enabled: true, focused: false },
  { cls: 'MSTaskSwWClass', text: '', style: 0, ...r(60, 454, 594, 22), id: 0, hwnd: 400, enabled: true, focused: false },
  { cls: 'SysTabControl32', text: '', style: 0, ...r(60, 454, 594, 22), id: 0, hwnd: 404, enabled: true, focused: false,
    items: [{ ...r(60, 454, 160, 22), text: 'Enter Windows Password', selected: false }, { ...r(223, 454, 160, 22), text: 'Welcome', selected: true }] },
];
const els = nativeEls(tray, { window: '' });
const named = (role, name) => els.find(e => e.role === role && e.name === name);
assert.ok(els.every(e => e.window === 'Taskbar'), 'the tray\'s elements are the Taskbar\'s');
assert.ok(named('pushbutton', 'Start'));
assert.deepEqual(r(named('pushbutton', 'Welcome').x, 454, 160, 22), r(223, 454, 160, 22));
assert.equal(named('pushbutton', 'Welcome').pressed, true);
assert.equal(named('pushbutton', 'Enter Windows Password').pressed, false);
assert.ok(named('clock', '8:31 PM'));
// another native window keeps its title, its controls as before
const dlg = nativeEls([{ cls: 'Button', text: '&OK', style: 1, ...r(10, 10, 75, 23), id: 1, hwnd: 9, enabled: true, focused: true }], { window: 'Open' });
assert.deepEqual(dlg.map(e => [e.role, e.name, e.window, e.focused]), [['pushbutton', 'OK', 'Open', true]]);

// the page's own taskbar is listed only while it is the one drawn
const el = cut('function elements()', '\n}\n');
assert.match(el, /if \(!monApp\(\)\) \{[^}]*const L = taskLayout\(\);/);
console.log('monitorelements: ok');
