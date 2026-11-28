// win95.screen() carries the screen state the 'screen' event reports (desktop, dos, black, logow, logos): the event
// comes only on a change, so a script that registers for the desktop after it is up waits for good unless it can
// read the state first (the arrival at an anchored moment after a reload did)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const i = w.indexOf('  screen() {'), line = w.slice(i, w.indexOf('\n', i));
assert.match(line, /return \{ width: W, height: H, taskbar: barTop\(\), screen \}/, 'screen() answers the state');
assert.match(w, /if \(now\.screen !== was\.screen\) emit\('screen', \{ screen: now\.screen \}\)/, 'the event carries the same');
assert.match(w, /^let screen = 'desktop'/m);
const doc = readFileSync(new URL('../docs/scripting/screen.md', import.meta.url), 'utf8');
assert.match(doc, /`screen\(\)` \| `\{ width, height, taskbar, screen \}`/);
console.log('screenstate: ok');
