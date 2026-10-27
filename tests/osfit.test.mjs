// a session window's place on a machine whose screen is smaller than the one that placed it (oslogic.js fit): moved
// only as far as keeps its title bar on this machine's work area; one that fits, a minimized or a maximized one, as
// it is. And a screen's change is this machine's own: read sends nothing for it and sets the session's places again
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis;
new Function(readFileSync(new URL('../oslogic.js', import.meta.url), 'utf8'))();
const { fit, read } = window.W95OSLogic;
const area = { x: 0, y: 0, w: 700, h: 530 };
const v = { x: 66, y: 66, w: 265, h: 219, min: false, max: false, ctrls: {} };
assert.equal(fit(v, area), v, 'on the screen: as it is');
assert.deepEqual(fit({ ...v, x: 690, y: 600 }, area), { ...v, x: 660, y: 508 }, 'its title bar kept on the screen');
assert.deepEqual(fit({ ...v, x: -400, y: -30 }, area), { ...v, x: 40 - 265, y: 0 });
assert.deepEqual(Object.keys(fit({ ...v, x: 900 }, area)), Object.keys(v), '(its fields in the same order: compared as JSON)');
const max = { ...v, x: -4, y: -4, max: true }; assert.equal(fit(max, area), max);
assert.equal(fit(v, null), v);
// read: a changed work area sets the session's places again, sending none; the same area: a moved window sent
{
  const CL = Symbol('closing'), world = new Map([['A', v]]), seen = new Map([['A', v]]);
  const moved = { ...v, x: 59, y: 49 };
  let r = read({ world, local: new Map([['A', moved]]), seen, starting: new Set(), closing: CL, area, lastArea: JSON.stringify({ ...area, w: 793 }) });
  assert.deepEqual(r.sends, []); assert.deepEqual(r.applies, [['A', v]]);
  r = read({ world, local: new Map([['A', moved]]), seen, starting: new Set(), closing: CL, area, lastArea: r.area });
  assert.deepEqual(r.sends, [['A', moved]]);
}
// (win95.js osApply: a program another machine's person closed, its only object, ended here without asking again
// (worker.js 'end'); a program started three times without coming is not started again)
{
  const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8'), a = w.slice(w.indexOf('async function osApply('), w.indexOf('/** another person changed a window here'));
  assert.ok(/a\.cmd\('end', \[mine\.hwnd\]\)/.test(a)); assert.ok(/if \(n > 3\) return;/.test(a));
  assert.ok(/case 'end': \{/.test(readFileSync(new URL('../worker.js', import.meta.url), 'utf8')));
}
console.log('osfit: ok');
