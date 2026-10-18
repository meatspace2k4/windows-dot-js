// one pointer: the host never changes USER's cursor show count (ShowCursor, USER.71); over a machine's windows the
// page draws that machine's display sprite, elsewhere its own arrow
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
for (const f of ['win95.js', 'worker.js', 'ne16.js']) {
  const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  assert.ok(!/user16\(71\b/.test(s), `${f} calls ShowCursor from the host`);
  assert.ok(!/showCursor\(/.test(s), `${f} toggles a machine's cursor`);
}
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
assert.ok(/if \(nativeAt\(x, y\)\) return 'none';/.test(w), 'cursorAt leaves the pointer to the machine under it');
assert.ok(/const na = nativeAt\(mouse\.x, mouse\.y\); if \(na\) drawSprite\(na\);/.test(w), 'the machine under the pointer has its sprite drawn');
console.log('cursor: ok');
