// The scripting API's clicks on an element. A native window's controls came from the machine's last answer (none right
// after the window opened, old positions later), a covered element was clicked anyway, and a native list view's item
// was clicked at the middle of its rectangle, which runs the column's width: the click fell beside the label and
// Explorer took the selection away. Now: the element as the machine shows it now, an error naming what is there when it
// is missing or covered, and a list view's item selected or opened by the list view itself
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };
const src = cut('// the front-most element matching every given field', '\n  return e;\n}\n');

const env = { windows: [], list: [], winAt: null };
const make = new Function('env', `
  const performance = globalThis.performance;
  let windows; const elements = () => env.list, winAt = (x, y) => env.winAt(x, y);
  const sync = () => { windows = env.windows; };
  ${src}
  return { resolveEl: (q, ms) => (sync(), resolveEl(q, ms)), actOn: (q, f, item) => (sync(), actOn(q, f, item)) };`);
const S = make(env);

// a native window whose list fills on the machine's second answer: the query waits for it and gets the fresh position
{
  let answers = 0;
  const app = { alive: true, childrenNow: async () => { answers++; env.list = answers >= 2 ? [{ role: 'listitem', name: 'home', window: 'Matts', x: 90, y: 128, w: 112, h: 17, covered: false, list: 0x2a4, index: 0 }] : []; return []; } };
  env.windows = [{ native: true, min: false, app, hwnd: 0x1234, title: 'Matts' }]; env.list = [];
  const e = await S.resolveEl({ name: 'home', window: 'Matts' }, 2000);
  assert.deepEqual([e.x, e.y, answers >= 2], [90, 128, true]);
}
// covered: rejects naming what covers it
{
  const keep = env.windows; env.windows = [];
  env.list = [{ role: 'listitem', name: 'Network Neighborhood', window: 'Program Manager', x: 2, y: 75, w: 71, h: 66, covered: true }];
  env.winAt = () => ({ title: 'Developer' });
  await assert.rejects(S.resolveEl({ name: 'Network Neighborhood' }, 100), /covered by 'Developer'/);
  env.list = [{ role: 'listitem', name: 'Entire Network', window: 'Network Neighborhood', x: 0, y: 0, w: 10, h: 10 }];
  await assert.rejects(S.resolveEl({ name: 'home', window: 'Network Neighborhood' }, 100), /no element matches .*'Entire Network'/);
  env.windows = keep;
}
// a list view's item: opened by its list view (its list and index), not by a click at its middle
{
  const cmds = [], app = { alive: true, childrenNow: async () => [], cmd: async (n, a) => { cmds.push([n, ...a]); return true; } };
  env.windows = [{ native: true, min: false, app, hwnd: 0x1234, title: 'Matts' }];
  env.list = [{ role: 'listitem', name: 'home', window: 'Matts', x: 90, y: 128, w: 112, h: 17, covered: false, list: 0x2a4, index: 3 }];
  const sent = [];
  await S.actOn({ name: 'home' }, (x, y) => sent.push([x, y]), { open: true });
  await S.actOn({ name: 'home' }, (x, y) => sent.push([x, y]), { open: false });
  assert.deepEqual(cmds, [['listItem', 0x2a4, 3, true], ['listItem', 0x2a4, 3, false]]);
  assert.deepEqual(sent, [], 'no pointer input');
  // anything else (a right-click, a button): the pointer at its centre
  await S.actOn({ name: 'home' }, (x, y) => sent.push([x, y]), null);
  env.list = [{ role: 'pushbutton', name: 'OK', window: 'Dlg', x: 10, y: 10, w: 20, h: 10, covered: false }];
  await S.actOn({ name: 'OK' }, (x, y) => sent.push([x, y]), { open: false });
  assert.deepEqual(sent, [[146, 136], [20, 15]]);
}
console.log('scriptclick: ok');
