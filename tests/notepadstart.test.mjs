// Notepad is the CD's NOTEPAD.EXE whenever the system bundle carries it; the shell's own stands in only on a page
// without one. A native start that failed brought the stand-in up in its place, so the failure never showed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const i = src.indexOf('function runNotepad('); assert.ok(i >= 0);
const body = src.slice(i, src.indexOf('\n}\n', i) + 2);
const run = async (bundle, ok) => {
  const seen = [];
  const window = { W95SYSTEM: bundle ? { programs: { 'NOTEPAD.EXE': {} } } : undefined };
  const f = new Function('window', 'runNative', 'notepad', 'msgBox', 'join', 'WINDIR', 'basename', 'dispName', `${body}; return runNotepad;`)(
    window, async () => ok, file => seen.push(['stand-in', file]), (t, m) => seen.push(['msgBox', m]), (a, b) => a + '\\' + b, 'C:\\WINDOWS', p => p.split('\\').pop(), n => n);
  f('C:\\A.TXT'); await new Promise(r => setTimeout(r, 0));
  return seen;
};
assert.deepEqual(await run(true, true), [], 'the native one started');
assert.deepEqual((await run(true, false)).map(s => s[0]), ['msgBox'], 'a native start that fails says so; no stand-in');
assert.deepEqual(await run(false, false), [['stand-in', 'C:\\A.TXT']], 'without the system bundle the shell\'s own Notepad');
console.log('notepadstart: ok');
