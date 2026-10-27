// a session window's place on a machine whose screen is smaller than the one that placed it (win95.js osFit): moved
// only as far as keeps its title bar on this machine's work area; one that fits, a minimized or a maximized one, as
// it is. And a screen's change is this machine's own: osRead sends nothing for it and sets the session's places again
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };
const osFit = new Function(`${cut('function osFit(v, area) {', '\n}')}\n${cut('const OS_GRIP', ';')}\nreturn osFit;`)();
const area = { x: 0, y: 0, w: 700, h: 530 };
const v = { x: 66, y: 66, w: 265, h: 219, min: false, max: false, ctrls: {} };
assert.equal(osFit(v, area), v, 'on the screen: as it is');
assert.deepEqual(osFit({ ...v, x: 690, y: 600 }, area), { ...v, x: 660, y: 508 }, 'its title bar kept on the screen');
assert.deepEqual(osFit({ ...v, x: -400, y: -30 }, area), { ...v, x: 40 - 265, y: 0 });
assert.deepEqual(Object.keys(osFit({ ...v, x: 900 }, area)), Object.keys(v), '(its fields in the same order: compared as JSON)');
const max = { ...v, x: -4, y: -4, max: true }; assert.equal(osFit(max, area), max);
assert.equal(osFit(v, null), v);
// osRead: a changed work area resets the session's places, sending none
{
  const r = cut('async function osRead() {', '\n}');
  assert.ok(/resized = osArea !== null && area !== osArea/.test(r));
  assert.ok(/if \(reset\.has\(id\)\) continue;/.test(r));
  assert.ok(/osFit\(v, local\.area\); osSeen\.set\(id, f\)/.test(cut('async function osApply(', '\n}')));
}
console.log('osfit: ok');
