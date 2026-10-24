// The JS USER32's MessageBoxA (a screen saver drawn by the page) shows nothing; it answered IDOK with a console line,
// so the program went on with an answer nobody gave. It stops, naming the box.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { API, GuestError } = window.W95Win32;
const p = { readA: a => ({ 1: 'Starfield', 2: 'No 3D hardware found.' })[a] };
assert.throws(() => API.USER32.MessageBoxA[1].call(p, 0, 2, 1, 0), e => e instanceof GuestError && /MessageBoxA: Starfield: No 3D hardware found\./.test(e.message));
console.log('messagebox: ok');
