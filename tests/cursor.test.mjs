// one pointer: where a machine has the mouse its USER's cursor shows (the page draws that machine's sprite), elsewhere
// the shell's arrow; the host never changes a machine's cursor show count (ShowCursor, USER.71)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
for (const f of ['win95.js', 'worker.js', 'ne16.js']) {
  assert.ok(!/user16\(71\b/.test(read(f)), `${f} calls ShowCursor from the host`);
  assert.ok(!/showCursor\(/.test(read(f)), `${f} toggles a machine's cursor`);
}
const w = read('win95.js');
const i = w.indexOf('const pointerApp ='), j = w.indexOf('\n}\n', w.indexOf('function cursorAt', i)) + 3;
const env = { cap: null, menus: [], modalWin: null, drag: null, under: null, shellWin: null };
const make = new Function('env', `
  const SIZE_CUR = { e: 'sizewe' };
  const modal = () => env.modalWin, menuAt = () => (env.menus.length ? 0 : -1), onTaskbar = () => false;
  const nativeAt = () => env.under, winAt = () => env.shellWin;
  let cap, menus, drag;
  const sync = () => { cap = env.cap; menus = env.menus; drag = env.drag; };
  ${w.slice(i, j)}
  return { pointerApp: (x, y) => (sync(), pointerApp(x, y)), cursorAt: (x, y) => (sync(), cursorAt(x, y)) };`);
const { pointerApp, cursorAt } = make(env);
const A = { name: 'machine A' }, B = { name: 'machine B' };
const shellW = { hit: () => 'client' };

// over a machine's window: its cursor, and the sprite drawn is that machine's
env.under = A; assert.equal(cursorAt(5, 5), 'none'); assert.equal(pointerApp(5, 5), A);
// over the desktop: the shell's arrow, no machine's sprite
env.under = null; env.shellWin = null; assert.equal(cursorAt(5, 5), 'arrow'); assert.equal(pointerApp(5, 5), null);
// a shell menu open over a machine's window: the shell's arrow (the machine gets no moves then, its sprite would stick)
env.under = A; env.menus = [{}]; assert.equal(cursorAt(5, 5), 'arrow'); assert.equal(pointerApp(5, 5), null); env.menus = [];
// a shell dialog modal over a machine's window: the shell's cursor
env.modalWin = shellW; env.shellWin = shellW; assert.equal(pointerApp(5, 5), null); assert.notEqual(cursorAt(5, 5), 'none'); env.modalWin = null; env.shellWin = null;
// a drag a machine holds: its cursor wherever the pointer goes, even over another machine
env.cap = { native: B }; env.under = A; assert.equal(pointerApp(500, 5), B); assert.equal(cursorAt(500, 5), 'none');
// a drag the shell holds: the shell's cursor
env.cap = {}; env.drag = { cursor: 'move' }; assert.equal(pointerApp(5, 5), null); assert.equal(cursorAt(5, 5), 'move');
console.log('cursor: ok');
